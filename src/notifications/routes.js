import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/mongo.js';

export const notificationsRouter = Router();
notificationsRouter.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
notificationsRouter.use(requireAuth);

const badRequest = (res, error) => res.status(400).json({ error: 'cuerpo inválido', issues: z.treeifyError(error) });

function toApi(n) {
  return {
    id: n._id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    eventId: n.eventId ?? undefined,
    data: n.data ?? {},
    createdAt: n.createdAt.toISOString(),
    read: Boolean(n.readAt),
  };
}

// ---------------------------------------------------------------- dispositivos (FCM)
const deviceSchema = z.object({ token: z.string().min(20).max(4096), platform: z.enum(['android', 'ios', 'web']) }).strict();

/** Registra el token FCM del dispositivo. Un token pertenece a un solo usuario (el último que lo registró). */
notificationsRouter.post('/devices', async (req, res, next) => {
  const parsed = deviceSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const users = getDb().collection('users');
    const { token, platform } = parsed.data;
    await users.updateMany({ _id: { $ne: req.auth.userId } }, { $pull: { devices: { token } } });
    await users.updateOne({ _id: req.auth.userId }, { $pull: { devices: { token } } }, { upsert: true });
    await users.updateOne(
      { _id: req.auth.userId },
      { $push: { devices: { $each: [{ token, platform, registeredAt: new Date() }], $slice: -5 } } },
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

notificationsRouter.delete('/devices', async (req, res, next) => {
  const parsed = z.object({ token: z.string().min(1) }).safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    await getDb().collection('users').updateOne({ _id: req.auth.userId }, { $pull: { devices: { token: parsed.data.token } } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- ubicación (RF12 + RNF5)
const locationSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();

/**
 * Última ubicación conocida para avisar de eventos cercanos. Solo se guarda si el usuario dio el
 * consentimiento explícito (location_consent.granted desde user-service); si no, 403.
 */
notificationsRouter.put('/location', async (req, res, next) => {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const users = getDb().collection('users');
    const result = await users.updateOne(
      { _id: req.auth.userId, locationConsent: true },
      {
        $set: {
          location: { type: 'Point', coordinates: [parsed.data.lng, parsed.data.lat] },
          locationUpdatedAt: new Date(),
        },
      },
    );
    if (result.matchedCount === 0) {
      return res.status(403).json({ error: 'necesitamos tu consentimiento de ubicación', code: 'no_location_consent' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

notificationsRouter.delete('/location', async (req, res, next) => {
  try {
    await getDb().collection('users').updateOne({ _id: req.auth.userId }, { $unset: { location: '', locationUpdatedAt: '' } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- bandeja
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.iso.datetime().optional(),
  unread: z.enum(['true', 'false']).optional(),
});

notificationsRouter.get('/', async (req, res, next) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'parámetros inválidos' });
  try {
    const filter = { userId: req.auth.userId };
    if (parsed.data.before) filter.createdAt = { $lt: new Date(parsed.data.before) };
    if (parsed.data.unread === 'true') filter.readAt = null;
    const items = await getDb().collection('notifications').find(filter).sort({ createdAt: -1 }).limit(parsed.data.limit).toArray();
    res.json({ items: items.map(toApi) });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/unread-count', async (req, res, next) => {
  try {
    const count = await getDb().collection('notifications').countDocuments({ userId: req.auth.userId, readAt: null });
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    const r = await getDb().collection('notifications').updateMany({ userId: req.auth.userId, readAt: null }, { $set: { readAt: new Date() } });
    res.json({ updated: r.modifiedCount });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/:id/read', async (req, res, next) => {
  if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'id inválido' });
  try {
    const r = await getDb().collection('notifications').updateOne({ _id: req.params.id, userId: req.auth.userId }, { $set: { readAt: new Date() } });
    if (r.matchedCount === 0) return res.status(404).json({ error: 'notificación no encontrada' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
