// Outbox: ids deterministas, encolado idempotente y publicador con publisher confirms.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const o = vi.hoisted(() => ({ db: null }));
vi.mock('../src/db/mongo.js', () => ({ getDb: () => o.db }));
vi.mock('../src/logger.js', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {} } }));

const { deterministicUuid, enqueue } = await import('../src/messaging/outboxRepository.js');
const { startOutboxPublisher } = await import('../src/messaging/outboxPublisher.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deterministicUuid', () => {
  it('es estable para el mismo texto, distinto para otro y con formato UUID v8', () => {
    expect(deterministicUuid('a')).toBe(deterministicUuid('a'));
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'));
    expect(deterministicUuid('a')).toMatch(UUID);
  });
});

describe('enqueue', () => {
  function fakeDb() {
    const col = { updateOne: vi.fn(async () => ({})) };
    return { col, db: { collection: vi.fn(() => col) } };
  }

  it('con causationId deriva el mismo eventId en un reintento y usa $setOnInsert', async () => {
    const { col, db } = fakeDb();
    const msg = { exchange: 'festa.notification', routingKey: 'push.sent', payload: { x: 1 }, causationId: 'c1', key: 'u1' };
    const id1 = await enqueue(msg, db);
    const id2 = await enqueue(msg, db);
    expect(id1).toBe(id2);
    expect(id1).toBe(deterministicUuid('c1:push.sent:u1'));
    const [filter, update, options] = col.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: id1 });
    expect(update.$setOnInsert).toMatchObject({ exchange: 'festa.notification', routingKey: 'push.sent', payload: { x: 1 }, sentAt: null });
    expect(options).toEqual({ upsert: true });
    expect(db.collection).toHaveBeenCalledWith('outbox');
  });

  it('sin causationId genera un id aleatorio distinto cada vez', async () => {
    const { db } = fakeDb();
    const msg = { exchange: 'x', routingKey: 'r', payload: {} };
    expect(await enqueue(msg, db)).not.toBe(await enqueue(msg, db));
  });
});

describe('startOutboxPublisher', () => {
  let rows;
  let outbox;
  beforeEach(() => {
    vi.useFakeTimers();
    rows = [];
    outbox = {
      findOneAndUpdate: vi.fn(async () => rows.shift() ?? null),
      updateOne: vi.fn(async () => ({})),
    };
    o.db = { collection: () => outbox };
  });
  afterEach(() => vi.useRealTimers());

  const row = (id, extra = {}) => ({
    _id: id,
    exchange: 'festa.notification',
    routingKey: 'push.sent',
    payload: { id },
    createdAt: new Date('2026-11-20T00:00:00Z'),
    ...extra,
  });

  it('publica cada fila con el sobre del contrato y la marca enviada tras el confirm', async () => {
    rows.push(row('e1', { correlationId: 'corr-1', causationId: 'cause-1' }), row('e2'));
    const published = [];
    const channel = {
      publish: vi.fn((ex, rk, buf, props, cb) => {
        published.push({ ex, rk, body: JSON.parse(buf), props });
        cb();
      }),
    };
    const connection = { createConfirmChannel: vi.fn(async () => channel) };
    const pub = startOutboxPublisher(connection, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    pub.stop();

    expect(published).toHaveLength(2);
    expect(published[0].ex).toBe('festa.notification');
    expect(published[0].body).toMatchObject({
      eventId: 'e1',
      eventType: 'push.sent',
      version: 1,
      producer: 'notification-service',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      data: { id: 'e1' },
      occurredAt: '2026-11-20T00:00:00.000Z',
    });
    expect(published[0].props).toMatchObject({ persistent: true, messageId: 'e1', headers: { 'x-correlation-id': 'corr-1' } });
    expect(published[1].props.headers).toEqual({});
    expect(published[1].body.correlationId).toBeNull();
    expect(outbox.updateOne).toHaveBeenCalledTimes(2);
    expect(outbox.updateOne.mock.calls[0][0]).toEqual({ _id: 'e1' });
    expect(outbox.updateOne.mock.calls[0][1].$set.sentAt).toBeInstanceOf(Date);
  });

  it('si el broker rechaza no marca la fila y abre un canal nuevo para reintentar', async () => {
    rows.push(row('e1'));
    const channel = { publish: vi.fn((ex, rk, buf, props, cb) => cb(new Error('nack'))) };
    const connection = { createConfirmChannel: vi.fn(async () => channel) };
    const pub = startOutboxPublisher(connection, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.updateOne).not.toHaveBeenCalled();
    expect(connection.createConfirmChannel).toHaveBeenCalledTimes(2);
    const before = outbox.findOneAndUpdate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(outbox.findOneAndUpdate.mock.calls.length).toBeGreaterThan(before);
    pub.stop();
    const after = outbox.findOneAndUpdate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(outbox.findOneAndUpdate.mock.calls.length).toBe(after);
  });

  it('la consulta solo toma filas sin enviar y sin lease vigente', async () => {
    const connection = { createConfirmChannel: vi.fn(async () => ({ publish: vi.fn() })) };
    const pub = startOutboxPublisher(connection);
    await vi.advanceTimersByTimeAsync(0);
    pub.stop();
    const [filter, update, opts] = outbox.findOneAndUpdate.mock.calls[0];
    expect(filter.sentAt).toBeNull();
    expect(update.$set.lockedUntil).toBeInstanceOf(Date);
    expect(opts.sort).toEqual({ createdAt: 1 });
  });
});
