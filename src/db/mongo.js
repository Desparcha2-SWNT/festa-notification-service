import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../logger.js';

let client;
let db;

/** Conecta (una vez por proceso) y crea los índices que el servicio necesita. */
export async function connectMongo({ ensureIndexes } = {}) {
  if (db) return db;
  client = new MongoClient(config.mongoUrl, { maxPoolSize: 20 });
  await client.connect();
  db = client.db();
  await db.collection('outbox').createIndex({ sentAt: 1, createdAt: 1 });
  // Los ids procesados se guardan 30 días: suficiente para cubrir reintentos y reinyecciones de la DLQ.
  await db.collection('processed_events').createIndex({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
  if (ensureIndexes) await ensureIndexes(db);
  logger.info('conectado a MongoDB');
  return db;
}

export function getDb() {
  if (!db) throw new Error('MongoDB no está conectado todavía');
  return db;
}

export async function closeMongo() {
  await client?.close();
  client = undefined;
  db = undefined;
}
