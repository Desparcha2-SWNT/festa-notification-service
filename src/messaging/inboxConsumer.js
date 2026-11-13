import { getDb } from '../db/mongo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getSchemaRegistry } from './schemaRegistry.js';
import { handlers } from './handlers.js';

const QUEUE = `${config.serviceName}.inbox`;
const RETRY_QUEUE = `${config.serviceName}.inbox.retry`;
const MAX_RETRIES = 3;

/**
 * Consume `<servicio>.inbox` siguiendo contracts/README.md § Consumir: valida sobre, productor,
 * exchange y `data`; es idempotente (colección processed_events); reintenta errores transitorios
 * vía inbox.retry y manda a la DLQ los permanentes.
 *
 * Mongo sin réplica no tiene transacciones: los handlers son idempotentes por diseño (upserts,
 * $addToSet, ids deterministas en el outbox) y el eventId se marca como procesado DESPUÉS del
 * efecto. Si el proceso muere entre ambos, el reintento repite un efecto idempotente.
 */
export async function startInboxConsumer(connection) {
  const registry = getSchemaRegistry(config.contractsDir);
  const channel = await connection.createConfirmChannel();
  await channel.prefetch(10);

  await channel.consume(QUEUE, (msg) => {
    if (!msg) return;
    handle(channel, msg, registry).catch((err) => logger.error(err, 'error inesperado manejando un mensaje del inbox'));
  });

  return channel;
}

async function handle(channel, msg, registry, db = undefined) {
  let envelope;
  try {
    envelope = JSON.parse(msg.content.toString());
  } catch (err) {
    logger.error({ err }, 'mensaje del inbox no es JSON, va directo a la DLQ');
    return channel.nack(msg, false, false);
  }

  if (!registry.validateEnvelope(envelope)) {
    logger.error({ errors: registry.validateEnvelope.errors }, 'el sobre no cumple envelope.schema.json, va directo a la DLQ');
    return channel.nack(msg, false, false);
  }

  const expectedProducer = registry.getExpectedProducer(envelope.eventType);
  if (expectedProducer && envelope.producer !== expectedProducer) {
    logger.error({ expectedProducer, actual: envelope.producer }, 'el productor declarado no es el dueño de este eventType, va directo a la DLQ');
    return channel.nack(msg, false, false);
  }

  const expectedExchange = registry.getExpectedExchange(envelope.eventType);
  if (expectedExchange && msg.fields.exchange !== expectedExchange) {
    logger.error({ expectedExchange, actual: msg.fields.exchange }, 'llegó por un exchange distinto al de su esquema, va directo a la DLQ');
    return channel.nack(msg, false, false);
  }

  const validateData = registry.getDataValidator(envelope.eventType);
  if (validateData && !validateData(envelope.data)) {
    logger.error({ errors: validateData.errors, eventType: envelope.eventType }, '`data` no cumple su esquema, va directo a la DLQ');
    return channel.nack(msg, false, false);
  }

  const handler = handlers[envelope.eventType];
  if (!handler) {
    logger.info({ eventType: envelope.eventType }, 'sin handler para este tipo de evento, se confirma sin efecto');
    return channel.ack(msg);
  }

  try {
    const database = db ?? getDb();
    const processed = database.collection('processed_events');
    if (await processed.findOne({ _id: envelope.eventId })) return channel.ack(msg);

    await handler(envelope.data, envelope, database);
    await processed.updateOne(
      { _id: envelope.eventId },
      { $setOnInsert: { eventType: envelope.eventType, processedAt: new Date() } },
      { upsert: true },
    );
    channel.ack(msg);
  } catch (err) {
    await handleFailure(channel, msg, envelope, err);
  }
}

async function handleFailure(channel, msg, envelope, err) {
  const rawRetryCount = msg.properties.headers?.['x-retry-count'] ?? 0;
  const retryCount = Number(rawRetryCount);

  if (!Number.isInteger(retryCount) || retryCount < 0) {
    logger.error({ rawRetryCount, eventType: envelope.eventType }, 'x-retry-count inválido, va directo a la DLQ');
    return channel.nack(msg, false, false);
  }
  if (retryCount >= MAX_RETRIES) {
    logger.error({ err, eventType: envelope.eventType, retryCount }, 'reintentos agotados, va a la DLQ');
    return channel.nack(msg, false, false);
  }

  logger.warn({ err, eventType: envelope.eventType, retryCount }, 'falla transitoria, se reintenta');
  try {
    await new Promise((resolve, reject) => {
      channel.sendToQueue(
        RETRY_QUEUE,
        msg.content,
        { ...msg.properties, headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 } },
        (publishErr) => (publishErr ? reject(publishErr) : resolve()),
      );
    });
    channel.ack(msg);
  } catch (publishErr) {
    logger.error({ err: publishErr }, 'no se pudo confirmar el reintento, se deja el mensaje sin confirmar');
  }
}

// Export solo para pruebas.
export const _internal = { handle, handleFailure };
