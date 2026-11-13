import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { closeMongo, connectMongo } from './db/mongo.js';
import { startMessaging } from './messaging/supervisor.js';
import { startReminderJob } from './jobs/reminders.js';

async function ensureIndexes(db) {
  await db.collection('users').createIndex({ location: '2dsphere' });
  await db.collection('users').createIndex({ role: 1 });
  await db.collection('users').createIndex({ 'devices.token': 1 });
  await db.collection('notifications').createIndex({ userId: 1, createdAt: -1 });
  await db.collection('reminders').createIndex({ sentAt: 1, cancelled: 1, sendAt: 1 });
  await db.collection('reminders').createIndex({ eventId: 1 });
  await db.collection('attendees').createIndex({ eventId: 1 });
}

async function main() {
  await connectMongo({ ensureIndexes });
  const messaging = await startMessaging();
  const reminders = startReminderJob();

  const server = createApp().listen(config.port, () => {
    logger.info({ port: config.port }, 'festa-notification-service arriba');
  });

  const shutdown = async () => {
    logger.info('apagando...');
    server.close();
    reminders.stop();
    await messaging.stop();
    await closeMongo();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error(err, 'no se pudo arrancar el servicio');
  process.exit(1);
});
