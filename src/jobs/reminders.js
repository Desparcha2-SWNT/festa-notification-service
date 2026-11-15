import { getDb } from '../db/mongo.js';
import { logger } from '../logger.js';
import { formatDate, notifyUsers } from '../notifications/notifier.js';

// Tiempo que una réplica conserva el recordatorio mientras lo envía. Si muere, otra lo retoma al vencer.
const LEASE_MS = 5 * 60_000;

/**
 * RF12: recordatorios de asistencia. Cada minuto toma los recordatorios vencidos y los envía.
 * Con lease (claimedUntil): una réplica lo reserva mientras lo envía y solo marca sentAt tras
 * confirmar la notificación. Si falla, se libera para reintentar; si muere, el lease vence y otra
 * réplica lo retoma. La notificación es idempotente por su dedupeKey, así un reenvío no duplica.
 */
export async function sendDueReminders(db = getDb(), now = new Date()) {
  const reminders = db.collection('reminders');
  let sent = 0;
  const skipped = []; // recordatorios que fallaron en esta tanda: se dejan para el siguiente minuto
  for (;;) {
    const r = await reminders.findOneAndUpdate(
      {
        sentAt: null,
        cancelled: false,
        sendAt: { $lte: now },
        startsAt: { $gt: now },
        _id: { $nin: skipped },
        $or: [{ claimedUntil: null }, { claimedUntil: { $lte: now } }],
      },
      { $set: { claimedUntil: new Date(now.getTime() + LEASE_MS) } },
      { sort: { sendAt: 1 }, returnDocument: 'after' },
    );
    if (!r) break;
    try {
      const result = await notifyUsers(
        [r.userId],
        { kind: 'reminder', title: `Hoy: ${r.title}`, body: `Empieza a las ${formatDate(r.startsAt)}. No olvides tu QR.`, eventId: r.eventId },
        { dedupeKey: `reminder:${r._id}:${r.startsAt.toISOString()}` },
        db,
      );
      // notifyUsers absorbe los errores de FCM y los cuenta: un push fallido no cuenta como enviado.
      if (result?.failedCount > 0) throw new Error(`push del recordatorio ${r._id} no confirmado por FCM`);
    } catch (err) {
      // Se libera el lease para que el siguiente minuto lo tome; no se marca enviado.
      logger.error({ err, reminderId: String(r._id) }, 'recordatorio no enviado, se reintenta');
      skipped.push(r._id);
      await reminders.updateOne({ _id: r._id }, { $set: { claimedUntil: null } }).catch(() => {});
      continue;
    }
    await reminders.updateOne({ _id: r._id }, { $set: { sentAt: new Date() }, $unset: { claimedUntil: '' } });
    sent++;
  }
  // Los recordatorios de eventos que ya empezaron sin enviarse se descartan.
  await reminders.updateMany({ sentAt: null, startsAt: { $lte: now } }, { $set: { cancelled: true } });
  return sent;
}

export function startReminderJob({ intervalMs = 60_000 } = {}) {
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    try {
      const count = await sendDueReminders();
      if (count > 0) logger.info({ count }, 'recordatorios enviados');
    } catch (err) {
      logger.error(err, 'fallo enviando recordatorios');
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, 5_000);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
