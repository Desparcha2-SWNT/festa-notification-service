// Configuración, conexión a MongoDB (cliente simulado) y temporizador de recordatorios.
import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), createIndex: vi.fn(), urls: [], sendDue: vi.fn() }));
vi.mock('mongodb', () => ({
  MongoClient: class {
    constructor(url) { m.urls.push(url); }
    connect() { return m.connect(); }
    close() { return m.close(); }
    db() { return { collection: (name) => ({ createIndex: (...a) => m.createIndex(name, ...a) }) }; }
  },
}));
vi.mock('../src/logger.js', () => ({ logger: { info: () => {}, error: vi.fn(), warn: () => {} } }));

const { parseTrustProxy } = await import('../src/config.js');
const mongo = await import('../src/db/mongo.js');

describe('parseTrustProxy', () => {
  it('interpreta vacío, números, booleanos y listas de subredes', () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy('')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});

describe('mongo', () => {
  afterEach(() => mongo.closeMongo());

  it('getDb falla antes de conectar', () => {
    expect(() => mongo.getDb()).toThrow(/no está conectado/);
  });

  it('conecta una sola vez, crea los índices propios y los del llamador', async () => {
    const ensureIndexes = vi.fn();
    const db = await mongo.connectMongo({ ensureIndexes });
    expect(await mongo.connectMongo()).toBe(db);
    expect(m.connect).toHaveBeenCalledOnce();
    expect(mongo.getDb()).toBe(db);
    expect(ensureIndexes).toHaveBeenCalledWith(db);
    const ttl = m.createIndex.mock.calls.find((c) => c[0] === 'processed_events');
    expect(ttl[2]).toEqual({ expireAfterSeconds: 30 * 24 * 3600 });
    expect(m.createIndex.mock.calls.some((c) => c[0] === 'outbox')).toBe(true);
    await mongo.closeMongo();
    expect(m.close).toHaveBeenCalled();
    expect(() => mongo.getDb()).toThrow();
  });
});
