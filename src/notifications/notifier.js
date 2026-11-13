import { getDb } from '../db/mongo.js';
import { logger } from '../logger.js';
import { enqueue, deterministicUuid } from '../messaging/outboxRepository.js';
import { sendPush } from '../push/fcm.js';

export const PUSH_KINDS = ['nearby_event', 'reminder', 'event_cancelled', 'event_rescheduled', 'ticket', 'merchant_status', 'report', 'admin', 'other'];

/**
 * Notifica a varios usuarios: guarda una notificación en la bandeja de cada uno y envía push a sus
 * dispositivos. Es idempotente por `dedupeKey`: el _id de cada notificación se deriva de
 * (dedupeKey, userId), así que si el mensaje que la causó se reprocesa, solo se envía push a quien
 * aún no la tenía. Publica `push.sent` con el alcance (una vez por dedupeKey).
 *
 * @param {string[]} userIds
 * @param {{kind: string, title: string, body: string, eventId?: string, data?: object}} message
 * @param {{dedupeKey: string, causationId?: string, correlationId?: string}} options
 */
export async function notifyUsers(userIds, message, { dedupeKey, causationId = null, correlationId = null }, db = getDb()) {
  const unique = [...new Set(userIds.filter(Boolean))];
  const users = db.collection('users');
  const inbox = db.collection('notifications');
  const now = new Date();

  // Usuarios suspendidos (moderación) no reciben nada.
  const blocked = new Set(
    (await users.find({ _id: { $in: unique }, suspended: true }, { projection: { _id: 1 } }).toArray()).map((u) => u._id),
  );

  const fresh = [];
  for (const userId of unique) {
    if (blocked.has(userId)) continue;
    const id = deterministicUuid(`${dedupeKey}:${userId}`);
    const res = await inbox.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          userId,
          kind: message.kind,
          title: message.title,
          body: message.body,
          eventId: message.eventId ?? null,
          data: message.data ?? {},
          createdAt: now,
          readAt: null,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount === 1) fresh.push(userId);
  }

  let failedCount = 0;
  if (fresh.length > 0) {
    const docs = await users.find({ _id: { $in: fresh } }, { projection: { devices: 1 } }).toArray();
    const tokens = docs.flatMap((u) => (u.devices ?? []).map((d) => d.token));
    try {
      const result = await sendPush(tokens, {
        title: message.title,
        body: message.body,
        data: { kind: message.kind, eventId: message.eventId, ...(message.data ?? {}) },
      });
      failedCount = result.failed;
      if (result.invalidTokens.length > 0) {
        await users.updateMany({}, { $pull: { devices: { token: { $in: result.invalidTokens } } } });
      }
    } catch (err) {
      // El push es "mejor esfuerzo": la notificación ya quedó en la bandeja.
      logger.error({ err, kind: message.kind }, 'falló el envío a FCM');
      failedCount = tokens.length;
    }
  }

  if (fresh.length > 0 || unique.length === 0) {
    await enqueue(
      {
        exchange: 'festa.notification',
        routingKey: 'push.sent',
        payload: {
          kind: PUSH_KINDS.includes(message.kind) ? message.kind : 'other',
          ...(message.eventId ? { eventId: message.eventId } : {}),
          recipientCount: fresh.length,
          failedCount,
          sentAt: now.toISOString(),
        },
        causationId,
        correlationId,
        key: dedupeKey,
      },
      db,
    );
  }
  return { recipients: fresh.length, failedCount };
}

/** Ids de los administradores (para avisos de comercios por verificar y reportes). */
export async function adminIds(db = getDb()) {
  const admins = await db.collection('users').find({ role: 'admin' }, { projection: { _id: 1 } }).toArray();
  return admins.map((a) => a._id);
}

const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
export const formatCop = (cents) => money.format(cents / 100);

const dateFmt = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });
export const formatDate = (iso) => dateFmt.format(new Date(iso));
