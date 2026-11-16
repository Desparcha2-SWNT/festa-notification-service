// Notificaciones: el push se reintenta si nunca se confirmó (pushedAt), aunque la bandeja ya tenga la fila.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sendPush: vi.fn(), enqueue: vi.fn() }));
vi.mock('../src/push/fcm.js', () => ({ sendPush: m.sendPush }));
vi.mock('../src/messaging/outboxRepository.js', () => ({
  enqueue: m.enqueue,
  deterministicUuid: (s) => `id-${s}`,
}));
vi.mock('../src/logger.js', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {} } }));

const { notifyUsers } = await import('../src/notifications/notifier.js');

const message = { kind: 'ticket', title: 'Tu boleta', body: 'Lista' };

// bandeja: `existing` simula filas que ya estaban (de un intento anterior).
function fakeDb(existing = {}) {
  const inbox = {
    docs: { ...existing },
    updateOne: vi.fn(async (filter, update) => {
      if (inbox.docs[filter._id]) return { upsertedCount: 0 };
      inbox.docs[filter._id] = { _id: filter._id, ...update.$setOnInsert };
      return { upsertedCount: 1 };
    }),
    findOne: vi.fn(async (filter) => inbox.docs[filter._id] ?? null),
    updateMany: vi.fn(async (filter, update) => {
      for (const id of filter._id.$in) if (inbox.docs[id]) Object.assign(inbox.docs[id], update.$set);
      return {};
    }),
  };
  const users = {
    find: vi.fn((filter) => ({
      toArray: async () => (filter.suspended ? [] : [{ _id: 'u1', devices: [{ token: 'tok-1' }] }]),
    })),
    updateMany: vi.fn(async () => ({})),
  };
  return { collection: (name) => (name === 'users' ? users : inbox), inbox };
}

describe('notifyUsers: push pendiente', () => {
  beforeEach(() => {
    m.sendPush.mockReset().mockResolvedValue({ failed: 0, invalidTokens: [] });
    m.enqueue.mockReset();
  });

  it('una notificación nueva se envía y queda marcada con pushedAt', async () => {
    const db = fakeDb();
    const res = await notifyUsers(['u1'], message, { dedupeKey: 'k1' }, db);
    expect(m.sendPush).toHaveBeenCalledTimes(1);
    expect(db.inbox.docs['id-k1:u1'].pushedAt).toBeInstanceOf(Date);
    expect(res.failedCount).toBe(0);
  });

  it('si la fila ya existe pero el push nunca se confirmó (caída tras guardar), lo reintenta', async () => {
    const db = fakeDb({ 'id-k1:u1': { _id: 'id-k1:u1', userId: 'u1' } });
    await notifyUsers(['u1'], message, { dedupeKey: 'k1' }, db);
    expect(m.sendPush).toHaveBeenCalledTimes(1);
    expect(db.inbox.docs['id-k1:u1'].pushedAt).toBeInstanceOf(Date);
  });

  it('si el push ya se confirmó, no se repite', async () => {
    const db = fakeDb({ 'id-k1:u1': { _id: 'id-k1:u1', userId: 'u1', pushedAt: new Date() } });
    await notifyUsers(['u1'], message, { dedupeKey: 'k1' }, db);
    expect(m.sendPush).not.toHaveBeenCalled();
  });

  it('si FCM reporta fallos, no marca pushedAt y devuelve failedCount', async () => {
    m.sendPush.mockResolvedValue({ failed: 1, invalidTokens: [] });
    const db = fakeDb();
    const res = await notifyUsers(['u1'], message, { dedupeKey: 'k1' }, db);
    expect(res.failedCount).toBe(1);
    expect(db.inbox.docs['id-k1:u1'].pushedAt).toBeUndefined();
    expect(res.retryableFailed).toBe(1);
  });

  it('un token inválido (permanente) se descarta y no deja el push pendiente para siempre', async () => {
    m.sendPush.mockResolvedValue({ failed: 1, invalidTokens: ['tok-1'] });
    const db = fakeDb();
    const res = await notifyUsers(['u1'], message, { dedupeKey: 'k1' }, db);
    expect(res).toMatchObject({ failedCount: 1, retryableFailed: 0 });
    expect(db.inbox.docs['id-k1:u1'].pushedAt).toBeInstanceOf(Date);
  });

  it('si FCM lanza, todo cuenta como reintentable', async () => {
    m.sendPush.mockRejectedValue(new Error('FCM caído'));
    const db = fakeDb();
    const res = await notifyUsers(['u1'], message, { dedupeKey: 'k1' }, db);
    expect(res.retryableFailed).toBe(1);
    expect(db.inbox.docs['id-k1:u1'].pushedAt).toBeUndefined();
  });
});
