import { getDb } from '../db/mongo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const LEASE_MS = 30_000;

/**
 * Publica lo pendiente en `outbox` con publisher confirms (contracts/README.md § Publicar).
 * Cada fila se "alquila" con findOneAndUpdate (lockedUntil) para que dos réplicas no publiquen la
 * misma a la vez. El eventId es el _id de la fila: si se republica tras una caída, el consumidor
 * lo deduplica por processed_events.
 */
export function startOutboxPublisher(connection, { intervalMs = 2000 } = {}) {
  let stopped = false;
  let channelPromise = connection.createConfirmChannel();

  const tick = async () => {
    if (stopped) return;
    try {
      const channel = await channelPromise;
      const outbox = getDb().collection('outbox');
      for (let i = 0; i < 50 && !stopped; i++) {
        const now = new Date();
        const row = await outbox.findOneAndUpdate(
          { sentAt: null, $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }] },
          { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS) } },
          { sort: { createdAt: 1 }, returnDocument: 'after' },
        );
        if (!row) break;

        const envelope = {
          eventId: row._id,
          eventType: row.routingKey,
          version: 1,
          occurredAt: row.createdAt.toISOString(),
          producer: config.serviceName,
          correlationId: row.correlationId ?? null,
          causationId: row.causationId ?? null,
          data: row.payload,
        };
        await new Promise((resolve, reject) => {
          channel.publish(
            row.exchange,
            row.routingKey,
            Buffer.from(JSON.stringify(envelope)),
            {
              persistent: true,
              contentType: 'application/json',
              messageId: envelope.eventId,
              type: envelope.eventType,
              headers: row.correlationId ? { 'x-correlation-id': row.correlationId } : {},
            },
            (err) => (err ? reject(err) : resolve()),
          );
        });
        await outbox.updateOne({ _id: row._id }, { $set: { sentAt: new Date() }, $unset: { lockedUntil: '' } });
      }
    } catch (err) {
      logger.error(err, 'fallo publicando el outbox, se reintenta en el siguiente tick');
      channelPromise = connection.createConfirmChannel();
    } finally {
      if (!stopped) setTimeout(tick, intervalMs);
    }
  };

  tick();
  return { stop: () => { stopped = true; } };
}
