// Despacho del inbox (sobre -> productor/exchange -> data -> handler -> idempotencia) sin RabbitMQ.
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock('../../src/messaging/handlers.js', () => ({ handlers: { 'account.registered': h.handler } }));

const { _internal } = await import('../../src/messaging/inboxConsumer.js');

const fakeChannel = () => ({ ack: vi.fn(), nack: vi.fn(), sendToQueue: vi.fn() });
function fakeRegistry({ validEnvelope = true, dataValid = true, producer = 'auth-service', exchange = 'festa.auth' } = {}) {
  const validateEnvelope = vi.fn().mockReturnValue(validEnvelope);
  return {
    validateEnvelope,
    getExpectedProducer: () => producer,
    getExpectedExchange: () => exchange,
    getDataValidator: () => vi.fn().mockReturnValue(dataValid),
  };
}
const msgWith = (envelope, exchange = 'festa.auth', headers = {}) => ({
  content: Buffer.from(JSON.stringify(envelope)),
  properties: { headers },
  fields: { exchange },
});
function fakeDb(alreadyProcessed = false) {
  const processed = { findOne: vi.fn().mockResolvedValue(alreadyProcessed ? { _id: 'x' } : null), updateOne: vi.fn() };
  return { collection: vi.fn(() => processed), processed };
}
const envelope = { eventId: 'e1', eventType: 'account.registered', producer: 'auth-service', data: { userId: 'u' } };

describe('handle', () => {
  it('JSON inválido va a la DLQ', async () => {
    const channel = fakeChannel();
    const msg = { content: Buffer.from('no-json'), properties: {}, fields: {} };
    await _internal.handle(channel, msg, fakeRegistry());
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('productor falso va a la DLQ', async () => {
    const channel = fakeChannel();
    const msg = msgWith({ ...envelope, producer: 'event-service' });
    await _internal.handle(channel, msg, fakeRegistry());
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('exchange equivocado va a la DLQ', async () => {
    const channel = fakeChannel();
    const msg = msgWith(envelope, 'festa.user');
    await _internal.handle(channel, msg, fakeRegistry());
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('data inválida va a la DLQ sin reintentos', async () => {
    const channel = fakeChannel();
    const msg = msgWith(envelope);
    await _internal.handle(channel, msg, fakeRegistry({ dataValid: false }));
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(h.handler).not.toHaveBeenCalled();
  });

  it('ejecuta el handler, marca el evento como procesado y confirma', async () => {
    h.handler.mockReset().mockResolvedValue();
    const channel = fakeChannel();
    const db = fakeDb();
    const msg = msgWith(envelope);
    await _internal.handle(channel, msg, fakeRegistry(), db);
    expect(h.handler).toHaveBeenCalledWith(envelope.data, envelope, db);
    expect(db.processed.updateOne).toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('un duplicado se confirma sin repetir el efecto', async () => {
    h.handler.mockReset();
    const channel = fakeChannel();
    const msg = msgWith(envelope);
    await _internal.handle(channel, msg, fakeRegistry(), fakeDb(true));
    expect(h.handler).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('una falla transitoria se reintenta por inbox.retry', async () => {
    h.handler.mockReset().mockRejectedValue(new Error('mongo caído'));
    const channel = fakeChannel();
    channel.sendToQueue.mockImplementation((q, c, o, cb) => cb(null));
    const msg = msgWith(envelope);
    await _internal.handle(channel, msg, fakeRegistry(), fakeDb());
    expect(channel.sendToQueue.mock.calls[0][0]).toBe('notification-service.inbox.retry');
    expect(channel.sendToQueue.mock.calls[0][2].headers['x-retry-count']).toBe(1);
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('agotados los reintentos va a la DLQ', async () => {
    const channel = fakeChannel();
    const msg = msgWith(envelope, 'festa.auth', { 'x-retry-count': 3 });
    await _internal.handleFailure(channel, msg, envelope, new Error('x'));
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });
});
