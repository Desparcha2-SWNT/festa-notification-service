// Recordatorios con lease: sentAt solo se marca tras confirmar el envío.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const n = vi.hoisted(() => ({ notifyUsers: vi.fn() }));
vi.mock('../src/notifications/notifier.js', () => ({ notifyUsers: n.notifyUsers, formatDate: () => '19:00' }));
vi.mock('../src/db/mongo.js', () => ({ getDb: () => ({}) }));

const { sendDueReminders } = await import('../src/jobs/reminders.js');

const now = new Date('2026-11-20T18:00:00Z');
const reminder = {
  _id: 'r1',
  userId: 'u1',
  title: 'Feria',
  eventId: 'e1',
  startsAt: new Date('2026-11-20T19:00:00Z'),
  sendAt: new Date('2026-11-20T17:00:00Z'),
};

function fakeDb(rows) {
  const queue = [...rows];
  const updates = [];
  const col = {
    findOneAndUpdate: vi.fn(async () => (queue.length ? { ...queue.shift() } : null)),
    updateOne: vi.fn(async (filter, update) => {
      updates.push({ filter, update });
      return {};
    }),
    updateMany: vi.fn(async () => ({})),
  };
  return { db: { collection: () => col }, col, updates };
}

describe('sendDueReminders (lease)', () => {
  beforeEach(() => {
    n.notifyUsers.mockReset();
  });

  it('marca sentAt solo después de confirmar el envío', async () => {
    n.notifyUsers.mockResolvedValue();
    const { db, updates } = fakeDb([reminder]);
    const sent = await sendDueReminders(db, now);
    expect(sent).toBe(1);
    expect(n.notifyUsers).toHaveBeenCalledTimes(1);
    const marked = updates.find((u) => u.update.$set?.sentAt);
    expect(marked).toBeDefined();
    expect(marked.filter).toEqual({ _id: 'r1' });
  });

  it('si la notificación falla, libera el lease y no marca sentAt', async () => {
    n.notifyUsers.mockRejectedValue(new Error('fcm caído'));
    const { db, updates } = fakeDb([reminder]);
    const sent = await sendDueReminders(db, now);
    expect(sent).toBe(0);
    expect(updates.some((u) => u.update.$set?.sentAt)).toBe(false);
    expect(updates.some((u) => u.update.$set?.claimedUntil === null)).toBe(true);
  });

  it('si FCM no confirma el push (failedCount), no se marca enviado aunque notifyUsers no lance', async () => {
    n.notifyUsers.mockResolvedValue({ recipients: 1, failedCount: 1 });
    const { db, updates } = fakeDb([reminder]);
    const sent = await sendDueReminders(db, now);
    expect(sent).toBe(0);
    expect(updates.some((u) => u.update.$set?.sentAt)).toBe(false);
  });

  it('un recordatorio que falla no bloquea a los siguientes', async () => {
    n.notifyUsers.mockRejectedValueOnce(new Error('fcm caído')).mockResolvedValue({ recipients: 1, failedCount: 0 });
    const { db } = fakeDb([reminder, { ...reminder, _id: 'r2' }]);
    const sent = await sendDueReminders(db, now);
    expect(sent).toBe(1);
  });

  it('reclama con lease vencible en vez de marcar sentAt antes de enviar', async () => {
    n.notifyUsers.mockResolvedValue();
    const { db, col } = fakeDb([reminder]);
    await sendDueReminders(db, now);
    const claimCall = col.findOneAndUpdate.mock.calls[0];
    expect(claimCall[1].$set.claimedUntil).toBeInstanceOf(Date);
    expect(claimCall[1].$set.sentAt).toBeUndefined();
    expect(claimCall[0].$or).toEqual([{ claimedUntil: null }, { claimedUntil: { $lte: now } }]);
  });
});
