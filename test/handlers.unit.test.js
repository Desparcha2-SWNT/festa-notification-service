// Handlers de mensajes con dobles: qué colecciones tocan y qué notificación arman (sin MongoDB).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const n = vi.hoisted(() => ({ notifyUsers: vi.fn(async () => ({})), adminIds: vi.fn(async () => ['admin-1']) }));
vi.mock('../src/notifications/notifier.js', async (orig) => ({ ...(await orig()), notifyUsers: n.notifyUsers, adminIds: n.adminIds }));
vi.mock('../src/db/mongo.js', () => ({ getDb: () => ({}) }));

const { handlers } = await import('../src/messaging/handlers.js');

const env = { eventId: 'env-1', correlationId: 'corr-1' };

function fakeDb({ attendees = [], reminders = [], event = null, nearby = [] } = {}) {
  const calls = [];
  const make = (name) => ({
    updateOne: vi.fn(async (...a) => {
      calls.push([name, 'updateOne', ...a]);
      return {};
    }),
    updateMany: vi.fn(async (...a) => {
      calls.push([name, 'updateMany', ...a]);
      return {};
    }),
    deleteOne: vi.fn(async (...a) => {
      calls.push([name, 'deleteOne', ...a]);
      return {};
    }),
    deleteMany: vi.fn(async (...a) => {
      calls.push([name, 'deleteMany', ...a]);
      return {};
    }),
    findOne: vi.fn(async () => event),
    aggregate: vi.fn(() => ({ toArray: async () => [] })),
    find: vi.fn((filter) => {
      calls.push([name, 'find', filter]);
      const rows = name === 'attendees' ? attendees : name === 'reminders' ? reminders : nearby;
      return { limit: () => ({ toArray: async () => rows }), toArray: async () => rows };
    }),
  });
  const cols = {};
  return { calls, db: { collection: (c) => (cols[c] ??= make(c)) } };
}

const lastMessage = () => n.notifyUsers.mock.calls.at(-1);

describe('handlers', () => {
  beforeEach(() => n.notifyUsers.mockClear());

  it('las opciones llevan dedupeKey, causationId y correlationId del sobre', async () => {
    const { db } = fakeDb();
    await handlers['merchant.verified']({ userId: 'u1', businessName: 'Café', merchantId: 'm1' }, env, db);
    const [ids, message, opts] = lastMessage();
    expect(ids).toEqual(['u1']);
    expect(message).toMatchObject({ kind: 'merchant_status', data: { merchantId: 'm1' } });
    expect(message.body).toContain('Café');
    expect(opts).toEqual({ dedupeKey: 'env-1', causationId: 'env-1', correlationId: 'corr-1' });
    await handlers['merchant.verified']({ userId: 'u1', businessName: 'Café', merchantId: 'm1' }, { eventId: 'env-2' }, db);
    expect(lastMessage()[2].correlationId).toBeNull();
  });

  it('cuentas, perfiles, consentimiento y moderación actualizan el usuario', async () => {
    const { db, calls } = fakeDb();
    await handlers['account.registered']({ userId: 'u1', role: 'user', displayName: 'Ana' }, env, db);
    await handlers['account.role_changed']({ userId: 'u1', newRole: 'merchant' }, env, db);
    await handlers['profile.updated']({ userId: 'u1', displayName: 'Ana', interests: ['musical'] }, env, db);
    await handlers['location_consent.granted']({ userId: 'u1' }, env, db);
    await handlers['location_consent.revoked']({ userId: 'u1' }, env, db);
    await handlers['moderation.user_suspended']({ userId: 'u1' }, env, db);
    await handlers['moderation.user_reinstated']({ userId: 'u1' }, env, db);
    const userCalls = calls.filter((c) => c[0] === 'users');
    // eslint-disable-next-line no-unused-vars
    const sets = userCalls.map((c) => c[3].$set).map(({ updatedAt, ...rest }) => rest);
    expect(sets).toEqual([
      { role: 'user', displayName: 'Ana' },
      { role: 'merchant' },
      { displayName: 'Ana', interests: ['musical'] },
      { locationConsent: true },
      { locationConsent: false },
      { suspended: true },
      { suspended: false },
    ]);
    // Revocar el consentimiento borra la ubicación guardada (RNF5).
    expect(userCalls[4][3].$unset).toEqual({ location: '', locationUpdatedAt: '' });
    expect(userCalls.every((c) => c[4]?.upsert === true)).toBe(true);
  });

  it('account.deleted borra el usuario y todo lo suyo (Ley 1581)', async () => {
    const { db, calls } = fakeDb();
    await handlers['account.deleted']({ userId: 'u1' }, env, db);
    expect(calls.map((c) => `${c[0]}.${c[1]}`)).toEqual(['users.deleteOne', 'notifications.deleteMany', 'reminders.deleteMany', 'attendees.deleteMany']);
  });

  it('merchant.submitted y report.created avisan a los administradores', async () => {
    const { db } = fakeDb();
    await handlers['merchant.submitted']({ businessName: 'Café', merchantId: 'm1' }, env, db);
    expect(lastMessage()[0]).toEqual(['admin-1']);
    expect(lastMessage()[1].kind).toBe('admin');
    await handlers['report.created']({ targetType: 'event', reason: 'spam', reportId: 'r1' }, env, db);
    expect(lastMessage()[1].body).toBe('Reporte de evento por spam.');
    await handlers['report.created']({ targetType: 'user', reason: 'spam', reportId: 'r1' }, env, db);
    expect(lastMessage()[1].body).toContain('usuario');
  });

  it('merchant.rejected incluye el motivo y report.resolved cambia el texto según el resultado', async () => {
    const { db } = fakeDb();
    await handlers['merchant.rejected']({ userId: 'u1', reason: 'falta RUT', merchantId: 'm1' }, env, db);
    expect(lastMessage()[1].body).toContain('falta RUT');
    await handlers['report.resolved']({ reporterId: 'u2', outcome: 'action_taken', reportId: 'r1' }, env, db);
    expect(lastMessage()[0]).toEqual(['u2']);
    expect(lastMessage()[1].body).toMatch(/Tomamos medidas/);
    await handlers['report.resolved']({ reporterId: 'u2', outcome: 'dismissed', reportId: 'r1' }, env, db);
    expect(lastMessage()[1].body).toMatch(/no encontramos/);
  });

  const published = (extra = {}) => ({
    eventId: 'ev1',
    title: 'Concierto',
    startsAt: '2099-01-01T20:00:00Z',
    endsAt: '2099-01-01T23:00:00Z',
    category: 'musical',
    organizerId: 'org',
    status: 'published',
    isLive: false,
    venue: { name: 'Teatro', location: { lat: 4.7, lng: -74 } },
    ...extra,
  });

  it('event.published guarda el evento y avisa a los cercanos con interés afín', async () => {
    const { db, calls } = fakeDb({ nearby: [{ _id: 'u1' }, { _id: 'u2' }] });
    await handlers['event.published'](published(), env, db);
    expect(calls[0].slice(0, 3)).toEqual(['events', 'updateOne', { _id: 'ev1' }]);
    const query = calls.find((c) => c[0] === 'users' && c[1] === 'find')[2];
    expect(query).toMatchObject({ _id: { $ne: 'org' }, locationConsent: true, interests: 'musical', suspended: { $ne: true } });
    expect(query.location.$geoWithin.$centerSphere[0]).toEqual([-74, 4.7]);
    const [ids, message] = lastMessage();
    expect(ids).toEqual(['u1', 'u2']);
    expect(message).toMatchObject({ kind: 'nearby_event', title: 'Nuevo plan cerca de ti: Concierto', eventId: 'ev1' });
    expect(message.body.startsWith('Teatro · ')).toBe(true);
    await handlers['event.published'](published({ isLive: true }), env, db);
    expect(lastMessage()[1].title).toMatch(/Parche en vivo/);
  });

  it('event.published no avisa si el evento no está publicado o ya terminó', async () => {
    const { db } = fakeDb({ nearby: [{ _id: 'u1' }] });
    await handlers['event.published'](published({ status: 'draft' }), env, db);
    await handlers['event.published'](published({ endsAt: '2000-01-01T00:00:00Z' }), env, db);
    expect(n.notifyUsers).not.toHaveBeenCalled();
  });

  it('event.rescheduled reprograma los recordatorios y avisa a los asistentes', async () => {
    const { db, calls } = fakeDb({ attendees: [{ userId: 'u1' }], reminders: [{ _id: 'att1', userId: 'u1' }] });
    await handlers['event.rescheduled']({ eventId: 'ev1', title: 'Concierto', startsAt: '2099-01-01T20:00:00Z', venue: { name: 'Teatro' } }, env, db);
    const rem = calls.find((c) => c[0] === 'reminders' && c[1] === 'updateOne');
    expect(rem[2]).toEqual({ _id: 'att1' });
    // REMINDER_HOURS_BEFORE = 2 por defecto.
    expect(rem[3].$set.sendAt.toISOString()).toBe('2099-01-01T18:00:00.000Z');
    expect(rem[3].$set).toMatchObject({ sentAt: null, cancelled: false, title: 'Concierto' });
    expect(lastMessage()[0]).toEqual(['u1']);
    expect(lastMessage()[1].kind).toBe('event_rescheduled');
  });

  it('event.cancelled anula los recordatorios y avisa con el motivo', async () => {
    const { db, calls } = fakeDb({ attendees: [{ userId: 'u1' }] });
    await handlers['event.cancelled']({ eventId: 'ev1', title: 'Concierto', reason: 'lluvia' }, env, db);
    const rem = calls.find((c) => c[0] === 'reminders');
    expect(rem[2]).toEqual({ eventId: 'ev1' });
    expect(rem[3]).toEqual({ $set: { cancelled: true, cancelledBy: 'event' } });
    expect(lastMessage()[0]).toEqual(['u1']);
    expect(lastMessage()[1]).toMatchObject({ kind: 'event_cancelled', body: 'lluvia' });
  });

  it('attendance.confirmed distingue boletas pagadas de asistencia gratis', async () => {
    const { db, calls } = fakeDb();
    const base = { attendanceId: 'a1', eventId: 'ev1', userId: 'u1', eventTitle: 'Feria', eventStartsAt: '2099-01-01T20:00:00Z' };
    await handlers['attendance.confirmed']({ ...base, source: 'ticket', passIds: ['p1', 'p2'] }, env, db);
    expect(lastMessage()[1]).toMatchObject({ kind: 'ticket', body: 'Tienes 2 boletas con QR. Muéstralas en la entrada.', data: { attendanceId: 'a1' } });
    await handlers['attendance.confirmed']({ ...base, source: 'ticket', passIds: ['p1'] }, env, db);
    expect(lastMessage()[1].body).toContain('1 boleta ');
    await handlers['attendance.confirmed']({ ...base, source: 'rsvp', passIds: ['p1'] }, env, db);
    expect(lastMessage()[1]).toMatchObject({ kind: 'other', title: '¡Vas a Feria!' });
    const att = calls.find((c) => c[0] === 'attendees' && c[1] === 'updateOne');
    expect(att[3]).toEqual({ $set: { eventId: 'ev1', userId: 'u1' } });
    const rem = calls.find((c) => c[0] === 'reminders' && c[1] === 'updateOne');
    expect(rem[2]).toEqual({ _id: 'a1' });
  });

  it('attendance.cancelled quita al asistente y anula su recordatorio sin notificar', async () => {
    const { db, calls } = fakeDb();
    await handlers['attendance.cancelled']({ attendanceId: 'a1' }, env, db);
    expect(calls.map((c) => `${c[0]}.${c[1]}`)).toEqual(['attendees.deleteOne', 'reminders.updateOne']);
    expect(n.notifyUsers).not.toHaveBeenCalled();
  });

  it('pass.checked_in da la bienvenida con o sin el evento conocido', async () => {
    await handlers['pass.checked_in']({ userId: 'u1', eventId: 'ev1' }, env, fakeDb({ event: { title: 'Feria' } }).db);
    expect(lastMessage()[1].body).toBe('Disfruta Feria.');
    await handlers['pass.checked_in']({ userId: 'u1', eventId: 'ev1' }, env, fakeDb().db);
    expect(lastMessage()[1].body).toBe('Tu ingreso quedó registrado.');
  });

  it('los mensajes de pagos van al comprador u organizador con montos en pesos', async () => {
    const { db } = fakeDb();
    const order = { buyerId: 'b1', eventId: 'ev1', orderId: 'o1' };
    await handlers['order.approved']({ ...order, totalCents: 5000000, quantity: 2 }, env, db);
    expect(lastMessage()[0]).toEqual(['b1']);
    expect(lastMessage()[1]).toMatchObject({ kind: 'ticket', data: { orderId: 'o1' } });
    expect(lastMessage()[1].body).toMatch(/50\.000.*2 boletas/);
    await handlers['order.approved']({ ...order, totalCents: 100, quantity: 1 }, env, db);
    expect(lastMessage()[1].body).toContain('1 boleta.');
    await handlers['order.failed']({ ...order, reason: 'DECLINED' }, env, db);
    expect(lastMessage()[1].body).toBe('Wompi respondió: DECLINED.');
    await handlers['order.failed'](order, env, db);
    expect(lastMessage()[1].body).toMatch(/no se pudo completar/);
    await handlers['order.expired'](order, env, db);
    expect(lastMessage()[1].title).toBe('Tu reserva venció');
    await handlers['order.refund_requested']({ ...order, amountCents: 1000000 }, env, db);
    expect(lastMessage()[1].body).toMatch(/10\.000/);
    await handlers['order.refunded']({ ...order, amountCents: 1000000 }, env, db);
    expect(lastMessage()[1].title).toBe('Reembolso realizado');
    await handlers['payout.recorded']({ organizerId: 'org', amountCents: 2000000, orderCount: 3, payoutId: 'p1' }, env, db);
    expect(lastMessage()[0]).toEqual(['org']);
    expect(lastMessage()[1].body).toMatch(/3 órdenes/);
  });
});
