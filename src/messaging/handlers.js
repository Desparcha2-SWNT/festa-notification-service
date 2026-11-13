import { config } from '../config.js';
import { adminIds, formatCop, formatDate, notifyUsers } from '../notifications/notifier.js';

const EARTH_RADIUS_M = 6_378_100;

// Un handler por tipo de mensaje consumido (contracts/README.md § Qué consume cada servicio).
// Firma: (data, envelope, db). Todos son idempotentes: se pueden repetir sin efectos dobles.

const opts = (envelope, suffix = '') => ({
  dedupeKey: `${envelope.eventId}${suffix}`,
  causationId: envelope.eventId,
  correlationId: envelope.correlationId ?? null,
});

const upsertUser = (db, userId, set) =>
  db.collection('users').updateOne({ _id: userId }, { $set: { ...set, updatedAt: new Date() } }, { upsert: true });

async function attendeesOf(db, eventId) {
  const rows = await db.collection('attendees').find({ eventId }, { projection: { userId: 1 } }).toArray();
  return rows.map((r) => r.userId);
}

/** Programa (o reprograma) el recordatorio de una asistencia. */
async function scheduleReminder(db, { attendanceId, userId, eventId, title, startsAt }) {
  const sendAt = new Date(new Date(startsAt).getTime() - config.reminderHoursBefore * 3600_000);
  await db.collection('reminders').updateOne(
    { _id: attendanceId },
    { $set: { userId, eventId, title, startsAt: new Date(startsAt), sendAt, sentAt: null, cancelled: false } },
    { upsert: true },
  );
}

export const handlers = {
  // ---------------------------------------------------------------- cuentas y perfiles
  'account.registered': (d, e, db) => upsertUser(db, d.userId, { role: d.role, displayName: d.displayName }),
  'account.role_changed': (d, e, db) => upsertUser(db, d.userId, { role: d.newRole }),
  'profile.updated': (d, e, db) => upsertUser(db, d.userId, { displayName: d.displayName, interests: d.interests }),

  // Ley 1581: se borra todo lo del usuario (tokens, ubicación, bandeja, recordatorios).
  'account.deleted': async (d, e, db) => {
    await db.collection('users').deleteOne({ _id: d.userId });
    await db.collection('notifications').deleteMany({ userId: d.userId });
    await db.collection('reminders').deleteMany({ userId: d.userId });
    await db.collection('attendees').deleteMany({ userId: d.userId });
  },

  // RNF5: la ubicación solo se usa con consentimiento explícito.
  'location_consent.granted': (d, e, db) => upsertUser(db, d.userId, { locationConsent: true }),
  'location_consent.revoked': (d, e, db) =>
    db.collection('users').updateOne(
      { _id: d.userId },
      { $set: { locationConsent: false, updatedAt: new Date() }, $unset: { location: '', locationUpdatedAt: '' } },
      { upsert: true },
    ),

  'moderation.user_suspended': (d, e, db) => upsertUser(db, d.userId, { suspended: true }),
  'moderation.user_reinstated': (d, e, db) => upsertUser(db, d.userId, { suspended: false }),

  // ---------------------------------------------------------------- comercios (RF3)
  'merchant.submitted': async (d, e, db) =>
    notifyUsers(
      await adminIds(db),
      { kind: 'admin', title: 'Comercio por verificar', body: `${d.businessName} envió su perfil para verificación.`, data: { merchantId: d.merchantId } },
      opts(e),
      db,
    ),
  'merchant.verified': (d, e, db) =>
    notifyUsers(
      [d.userId],
      { kind: 'merchant_status', title: '¡Tu comercio fue verificado!', body: `${d.businessName} ya puede publicar eventos con boletería.`, data: { merchantId: d.merchantId } },
      opts(e),
      db,
    ),
  'merchant.rejected': (d, e, db) =>
    notifyUsers(
      [d.userId],
      { kind: 'merchant_status', title: 'Tu verificación necesita cambios', body: `Motivo: ${d.reason}. Corrige los datos y vuelve a enviarla.`, data: { merchantId: d.merchantId } },
      opts(e),
      db,
    ),

  // ---------------------------------------------------------------- reportes (RF14)
  'report.created': async (d, e, db) =>
    notifyUsers(
      await adminIds(db),
      { kind: 'report', title: 'Nuevo reporte', body: `Reporte de ${d.targetType === 'event' ? 'evento' : 'usuario'} por ${d.reason}.`, data: { reportId: d.reportId } },
      opts(e),
      db,
    ),
  'report.resolved': (d, e, db) =>
    notifyUsers(
      [d.reporterId],
      {
        kind: 'report',
        title: 'Revisamos tu reporte',
        body: d.outcome === 'action_taken' ? 'Tomamos medidas. Gracias por ayudarnos a cuidar la comunidad.' : 'Lo revisamos y no encontramos una infracción.',
        data: { reportId: d.reportId },
      },
      opts(e),
      db,
    ),

  // ---------------------------------------------------------------- eventos (RF12)
  // Push a usuarios cercanos, con consentimiento de ubicación reciente e intereses afines.
  'event.published': async (d, e, db) => {
    await db.collection('events').updateOne(
      { _id: d.eventId },
      { $set: { title: d.title, startsAt: new Date(d.startsAt), category: d.category, organizerId: d.organizerId } },
      { upsert: true },
    );
    if (d.status !== 'published' || new Date(d.endsAt) <= new Date()) return;

    const since = new Date(Date.now() - config.locationMaxAgeHours * 3600_000);
    const nearby = await db
      .collection('users')
      .find(
        {
          _id: { $ne: d.organizerId },
          locationConsent: true,
          suspended: { $ne: true },
          locationUpdatedAt: { $gte: since },
          $or: [{ interests: d.category }, { interests: { $exists: false } }, { interests: { $size: 0 } }],
          // $geoWithin (y no $near) porque se combina con $or; el radio va en radianes.
          location: {
            $geoWithin: {
              $centerSphere: [[d.venue.location.lng, d.venue.location.lat], config.nearbyRadiusMeters / EARTH_RADIUS_M],
            },
          },
        },
        { projection: { _id: 1 } },
      )
      .limit(config.nearbyMaxRecipients)
      .toArray();

    await notifyUsers(
      nearby.map((u) => u._id),
      {
        kind: 'nearby_event',
        title: d.isLive ? `🔥 Parche en vivo cerca: ${d.title}` : `Nuevo plan cerca de ti: ${d.title}`,
        body: `${d.venue.name} · ${formatDate(d.startsAt)}`,
        eventId: d.eventId,
      },
      opts(e),
      db,
    );
  },

  'event.rescheduled': async (d, e, db) => {
    const attendees = await attendeesOf(db, d.eventId);
    await db.collection('events').updateOne({ _id: d.eventId }, { $set: { title: d.title, startsAt: new Date(d.startsAt) } }, { upsert: true });
    const reminders = await db.collection('reminders').find({ eventId: d.eventId, cancelled: false }).toArray();
    for (const r of reminders) {
      await scheduleReminder(db, { attendanceId: r._id, userId: r.userId, eventId: d.eventId, title: d.title, startsAt: d.startsAt });
    }
    await notifyUsers(
      attendees,
      { kind: 'event_rescheduled', title: `Cambio en ${d.title}`, body: `Ahora es el ${formatDate(d.startsAt)} en ${d.venue.name}.`, eventId: d.eventId },
      opts(e),
      db,
    );
  },

  'event.cancelled': async (d, e, db) => {
    const attendees = await attendeesOf(db, d.eventId);
    await db.collection('reminders').updateMany({ eventId: d.eventId }, { $set: { cancelled: true } });
    await notifyUsers(
      attendees,
      { kind: 'event_cancelled', title: `Se canceló ${d.title}`, body: d.reason, eventId: d.eventId },
      opts(e),
      db,
    );
  },

  // ---------------------------------------------------------------- asistencia (RF7, RF10)
  'attendance.confirmed': async (d, e, db) => {
    await db.collection('attendees').updateOne(
      { _id: d.attendanceId },
      { $set: { eventId: d.eventId, userId: d.userId } },
      { upsert: true },
    );
    await scheduleReminder(db, { attendanceId: d.attendanceId, userId: d.userId, eventId: d.eventId, title: d.eventTitle, startsAt: d.eventStartsAt });
    const tickets = d.passIds.length;
    await notifyUsers(
      [d.userId],
      {
        kind: d.source === 'ticket' ? 'ticket' : 'other',
        title: d.source === 'ticket' ? `Tus boletas para ${d.eventTitle}` : `¡Vas a ${d.eventTitle}!`,
        body:
          d.source === 'ticket'
            ? `Tienes ${tickets} ${tickets === 1 ? 'boleta' : 'boletas'} con QR. Muéstralas en la entrada.`
            : `Tu asistencia quedó confirmada para el ${formatDate(d.eventStartsAt)}. Tu QR está en la app.`,
        eventId: d.eventId,
        data: { attendanceId: d.attendanceId },
      },
      opts(e),
      db,
    );
  },

  'attendance.cancelled': async (d, e, db) => {
    await db.collection('attendees').deleteOne({ _id: d.attendanceId });
    await db.collection('reminders').updateOne({ _id: d.attendanceId }, { $set: { cancelled: true } });
  },

  'pass.checked_in': async (d, e, db) => {
    const event = await db.collection('events').findOne({ _id: d.eventId });
    await notifyUsers(
      [d.userId],
      { kind: 'other', title: '¡Bienvenido!', body: event ? `Disfruta ${event.title}.` : 'Tu ingreso quedó registrado.', eventId: d.eventId },
      opts(e),
      db,
    );
  },

  // ---------------------------------------------------------------- pagos (RF11)
  'order.approved': (d, e, db) =>
    notifyUsers(
      [d.buyerId],
      {
        kind: 'ticket',
        title: 'Pago aprobado',
        body: `Pagaste ${formatCop(d.totalCents)} por ${d.quantity} ${d.quantity === 1 ? 'boleta' : 'boletas'}. En breve verás tu QR.`,
        eventId: d.eventId,
        data: { orderId: d.orderId },
      },
      opts(e),
      db,
    ),
  'order.failed': (d, e, db) =>
    notifyUsers(
      [d.buyerId],
      { kind: 'ticket', title: 'Pago no aprobado', body: d.reason ? `Wompi respondió: ${d.reason}.` : 'Tu pago no se pudo completar. Intenta de nuevo.', eventId: d.eventId, data: { orderId: d.orderId } },
      opts(e),
      db,
    ),
  'order.expired': (d, e, db) =>
    notifyUsers(
      [d.buyerId],
      { kind: 'ticket', title: 'Tu reserva venció', body: 'No recibimos el pago a tiempo y liberamos los cupos.', eventId: d.eventId, data: { orderId: d.orderId } },
      opts(e),
      db,
    ),
  'order.refund_requested': (d, e, db) =>
    notifyUsers(
      [d.buyerId],
      { kind: 'ticket', title: 'Reembolso en trámite', body: `Vamos a devolverte ${formatCop(d.amountCents)}. Te avisamos cuando esté listo.`, eventId: d.eventId, data: { orderId: d.orderId } },
      opts(e),
      db,
    ),
  'order.refunded': (d, e, db) =>
    notifyUsers(
      [d.buyerId],
      { kind: 'ticket', title: 'Reembolso realizado', body: `Te devolvimos ${formatCop(d.amountCents)}.`, eventId: d.eventId, data: { orderId: d.orderId } },
      opts(e),
      db,
    ),
  'payout.recorded': (d, e, db) =>
    notifyUsers(
      [d.organizerId],
      { kind: 'merchant_status', title: 'Recibiste una liquidación', body: `Transferimos ${formatCop(d.amountCents)} por ${d.orderCount} órdenes.`, data: { payoutId: d.payoutId } },
      opts(e),
      db,
    ),
};
