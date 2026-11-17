import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { countRequests, registry } from './metrics.js';
import { notificationsRouter } from './notifications/routes.js';

export function createApp({ trustProxy = config.trustProxy } = {}) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '64kb' }));
  app.use(countRequests);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  // El cliente llama a /api/notifications; Kong quita el "/api".
  app.use('/notifications', notificationsRouter);

  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    req.log.error(err);
    res.status(500).json({ error: 'error interno' });
  });
  return app;
}
