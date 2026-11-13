import { getDb } from '../db/mongo.js';
import { logger } from '../logger.js';
import { formatDate, notifyUsers } from '../notifications/notifier.js';

/**
 * RF12: recordatorios de asistencia. Cada minuto toma los recordatorios vencidos y los envía.
 * Cada uno se "reclama" con findOneAndUpdate (sentAt) antes de enviar, así dos réplicas no lo
 * mandan dos veces; la notificación además es idempotente por su dedupeKey.
 */
export async function sendDueReminders(db = getDb(), now = new Date()) {
  const reminders = db.collection('reminders');
  let sent = 0;
  for (;;) {
    const r = await reminders.findOneAndUpdate(
      { sentAt: null, cancelled: false, sendAt: { $lte: now }, startsAt: { $gt: now } },
      { $set: { sentAt: now } },
      { sort: { sendAt: 1 }, returnDocument: 'after' },
    );
    if (!r) break;
    await notifyUsers(
      [r.userId],
      { kind: 'reminder', title: `Hoy: ${r.title}`, body: `Empieza a las ${formatDate(r.startsAt)}. No olvides tu QR.`, eventId: r.eventId },
      { dedupeKey: `reminder:${r._id}:${r.startsAt.toISOString()}` },
      db,
    );
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
