import crypto from 'node:crypto';
import { getDb } from '../db/mongo.js';

/**
 * UUID determinista (formato v8 de RFC 9562, con SHA-256) a partir de un texto. Con Mongo sin réplica
 * no hay transacciones entre colecciones, así que el outbox se vuelve idempotente de otra forma: el eventId de lo que se
 * publica por causa de un mensaje consumido se deriva de (causationId, routingKey, clave). Si el
 * handler se repite (reintento), la fila del outbox es la misma y no se duplica el mensaje.
 */
export function deterministicUuid(text) {
  const hash = crypto.createHash('sha256').update(text).digest();
  hash[6] = (hash[6] & 0x0f) | 0x80;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Encola un mensaje en la colección `outbox` (ver contracts/README.md § Publicar). `key` distingue
 * varios mensajes del mismo tipo causados por el mismo mensaje consumido.
 */
export async function enqueue({ exchange, routingKey, payload, correlationId = null, causationId = null, key = '' }, db = getDb()) {
  const eventId = causationId ? deterministicUuid(`${causationId}:${routingKey}:${key}`) : crypto.randomUUID();
  await db.collection('outbox').updateOne(
    { _id: eventId },
    {
      $setOnInsert: {
        exchange,
        routingKey,
        payload,
        correlationId,
        causationId,
        createdAt: new Date(),
        sentAt: null,
      },
    },
    { upsert: true },
  );
  return eventId;
}
