// API HTTP con la base simulada: autenticación, validación, errores y respuestas de la bandeja.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtPrivateKeyPem } from './fixtures/jwtKeys.js';

const s = vi.hoisted(() => ({ cols: {} }));
vi.mock('../src/db/mongo.js', () => ({ getDb: () => ({ collection: (name) => s.cols[name] }) }));

const { createApp } = await import('../src/app.js');
const { requireAdmin } = await import('../src/middleware/auth.js');

const USER = '0b9c7d6e-5f4a-4b3c-8d2e-1a0b9c8d7e6f';
const NID = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const sign = (claims = {}, opts = {}) =>
  jwt.sign({ sub: USER, role: 'user', ...claims }, jwtPrivateKeyPem, { algorithm: 'RS256', issuer: 'festa-auth', ...opts });
const auth = (claims) => ({ Authorization: `Bearer ${sign(claims)}` });
const TOKEN = 'x'.repeat(40);

let app;
beforeEach(() => {
  s.cols = {
    users: { updateOne: vi.fn(async () => ({ matchedCount: 1 })), updateMany: vi.fn(async () => ({})) },
    notifications: {
      find: vi.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) })),
      countDocuments: vi.fn(async () => 4),
      updateMany: vi.fn(async () => ({ modifiedCount: 2 })),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    },
  };
  app = createApp();
});

describe('app', () => {
  it('/health y /metrics responden sin token y las métricas cuentan por ruta', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
    const m = await request(app).get('/metrics');
    expect(m.status).toBe(200);
    expect(m.text).toMatch(/http_requests_total\{[^}]*route="\/health"/);
    expect(m.text).toMatch(/service="notification-service"/);
  });

  it('JSON mal formado da 400 y un error inesperado da 500 sin detalles', async () => {
    const bad = await request(app).post('/notifications/devices').set(auth()).set('Content-Type', 'application/json').send('{no');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'JSON inválido' });
    s.cols.notifications.countDocuments.mockRejectedValue(new Error('mongo caído'));
    const err = await request(app).get('/notifications/unread-count').set(auth());
    expect(err.status).toBe(500);
    expect(err.body).toEqual({ error: 'error interno' });
  });
});

describe('autenticación', () => {
  it('rechaza sin token, con otro esquema, con firma ajena o con otro emisor', async () => {
    expect((await request(app).get('/notifications')).body).toEqual({ error: 'falta el token' });
    expect((await request(app).get('/notifications').set('Authorization', 'Basic abc')).status).toBe(401);
    const other = jwt.sign({ sub: USER }, 'secreto', { algorithm: 'HS256', issuer: 'festa-auth' });
    expect((await request(app).get('/notifications').set('Authorization', `Bearer ${other}`)).body).toEqual({ error: 'token inválido' });
    const wrongIss = sign({}, { issuer: 'otro' });
    expect((await request(app).get('/notifications').set('Authorization', `Bearer ${wrongIss}`)).status).toBe(401);
    expect(s.cols.notifications.find).not.toHaveBeenCalled();
  });

  it('requireAdmin deja pasar solo al rol admin', () => {
    const res = { status: vi.fn(() => res), json: vi.fn() };
    const next = vi.fn();
    requireAdmin({ auth: { role: 'user' } }, res, next);
    requireAdmin({}, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    requireAdmin({ auth: { role: 'admin' } }, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('dispositivos', () => {
  it('valida el cuerpo', async () => {
    const r = await request(app).post('/notifications/devices').set(auth()).send({ token: 'corto', platform: 'android' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cuerpo inválido');
    expect((await request(app).post('/notifications/devices').set(auth()).send({ token: TOKEN, platform: 'android', extra: 1 })).status).toBe(400);
    expect((await request(app).post('/notifications/devices').set(auth()).send({ token: TOKEN, platform: 'symbian' })).status).toBe(400);
    expect(s.cols.users.updateOne).not.toHaveBeenCalled();
  });

  it('quita el token a las otras cuentas y lo agrega al usuario (máximo 5)', async () => {
    const r = await request(app).post('/notifications/devices').set(auth()).send({ token: TOKEN, platform: 'android' });
    expect(r.status).toBe(204);
    expect(s.cols.users.updateMany).toHaveBeenCalledWith({ _id: { $ne: USER } }, { $pull: { devices: { token: TOKEN } } });
    const push = s.cols.users.updateOne.mock.calls[1][1].$push.devices;
    expect(push.$slice).toBe(-5);
    expect(push.$each[0]).toMatchObject({ token: TOKEN, platform: 'android' });
  });

  it('repite la secuencia ante un choque de índice único y se rinde al tercer intento', async () => {
    const dup = Object.assign(new Error('dup'), { code: 11000 });
    s.cols.users.updateMany.mockRejectedValueOnce(dup);
    expect((await request(app).post('/notifications/devices').set(auth()).send({ token: TOKEN, platform: 'ios' })).status).toBe(204);
    expect(s.cols.users.updateMany).toHaveBeenCalledTimes(2);

    s.cols.users.updateMany.mockReset().mockRejectedValue(dup);
    expect((await request(app).post('/notifications/devices').set(auth()).send({ token: TOKEN, platform: 'ios' })).status).toBe(500);
    expect(s.cols.users.updateMany).toHaveBeenCalledTimes(3);

    s.cols.users.updateMany.mockReset().mockRejectedValue(new Error('otro'));
    expect((await request(app).post('/notifications/devices').set(auth()).send({ token: TOKEN, platform: 'ios' })).status).toBe(500);
    expect(s.cols.users.updateMany).toHaveBeenCalledTimes(1);
  });

  it('DELETE /devices valida y saca el token', async () => {
    expect((await request(app).delete('/notifications/devices').set(auth()).send({})).status).toBe(400);
    expect((await request(app).delete('/notifications/devices').set(auth()).send({ token: 'abc' })).status).toBe(204);
    expect(s.cols.users.updateOne).toHaveBeenCalledWith({ _id: USER }, { $pull: { devices: { token: 'abc' } } });
  });
});

describe('ubicación', () => {
  it('guarda el punto GeoJSON solo con consentimiento (RNF5)', async () => {
    const r = await request(app).put('/notifications/location').set(auth()).send({ lat: 4.78, lng: -74.04 });
    expect(r.status).toBe(204);
    const [filter, update] = s.cols.users.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: USER, locationConsent: true });
    expect(update.$set.location).toEqual({ type: 'Point', coordinates: [-74.04, 4.78] });

    s.cols.users.updateOne.mockResolvedValue({ matchedCount: 0 });
    const denied = await request(app).put('/notifications/location').set(auth()).send({ lat: 4.78, lng: -74.04 });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('no_location_consent');
  });

  it('rechaza coordenadas fuera de rango y DELETE borra la ubicación', async () => {
    expect((await request(app).put('/notifications/location').set(auth()).send({ lat: 91, lng: 0 })).status).toBe(400);
    expect(s.cols.users.updateOne).not.toHaveBeenCalled();
    expect((await request(app).delete('/notifications/location').set(auth())).status).toBe(204);
    expect(s.cols.users.updateOne.mock.calls.at(-1)).toEqual([{ _id: USER }, { $unset: { location: '', locationUpdatedAt: '' } }]);
  });
});

describe('bandeja', () => {
  it('lista con filtros y convierte al formato de la API', async () => {
    let captured;
    let limit;
    const rows = [
      { _id: NID, kind: 'ticket', title: 'T', body: 'B', createdAt: new Date('2026-11-20T10:00:00Z'), readAt: null },
      { _id: 'n2', kind: 'other', title: 'T2', body: 'B2', eventId: 'ev1', data: { a: '1' }, createdAt: new Date('2026-11-19T10:00:00Z'), readAt: new Date() },
    ];
    s.cols.notifications.find.mockImplementation((filter) => {
      captured = filter;
      return {
        sort: () => ({
          limit: (l) => {
            limit = l;
            return { toArray: async () => rows };
          },
        }),
      };
    });
    const r = await request(app).get('/notifications?limit=5&unread=true&before=2026-11-21T00:00:00Z').set(auth());
    expect(r.status).toBe(200);
    expect(captured).toEqual({ userId: USER, readAt: null, createdAt: { $lt: new Date('2026-11-21T00:00:00Z') } });
    expect(limit).toBe(5);
    expect(r.body.items[0]).toEqual({ id: NID, kind: 'ticket', title: 'T', body: 'B', data: {}, createdAt: '2026-11-20T10:00:00.000Z', read: false });
    expect(r.body.items[1]).toMatchObject({ eventId: 'ev1', data: { a: '1' }, read: true });

    await request(app).get('/notifications').set(auth());
    expect(captured).toEqual({ userId: USER });
    expect(limit).toBe(30);
  });

  it('rechaza parámetros inválidos', async () => {
    expect((await request(app).get('/notifications?limit=500').set(auth())).status).toBe(400);
    expect((await request(app).get('/notifications?before=ayer').set(auth())).status).toBe(400);
    expect((await request(app).get('/notifications?unread=si').set(auth())).status).toBe(400);
  });

  it('cuenta no leídas y marca todas como leídas', async () => {
    expect((await request(app).get('/notifications/unread-count').set(auth())).body).toEqual({ count: 4 });
    expect(s.cols.notifications.countDocuments).toHaveBeenCalledWith({ userId: USER, readAt: null });
    expect((await request(app).post('/notifications/read-all').set(auth())).body).toEqual({ updated: 2 });
    expect(s.cols.notifications.updateMany.mock.calls[0][0]).toEqual({ userId: USER, readAt: null });
  });

  it('marca una como leída: 400 con id no UUID, 404 si no es del usuario', async () => {
    expect((await request(app).post('/notifications/abc/read').set(auth())).status).toBe(400);
    expect((await request(app).post(`/notifications/${NID}/read`).set(auth())).status).toBe(204);
    expect(s.cols.notifications.updateOne.mock.calls[0][0]).toEqual({ _id: NID, userId: USER });
    s.cols.notifications.updateOne.mockResolvedValue({ matchedCount: 0 });
    expect((await request(app).post(`/notifications/${NID}/read`).set(auth())).status).toBe(404);
  });

  it('los errores de la base terminan en 500 en cada ruta', async () => {
    s.cols.notifications.find.mockImplementation(() => {
      throw new Error('x');
    });
    s.cols.notifications.updateMany.mockRejectedValue(new Error('x'));
    s.cols.notifications.updateOne.mockRejectedValue(new Error('x'));
    s.cols.users.updateOne.mockRejectedValue(new Error('x'));
    const cases = [
      ['get', '/notifications'],
      ['post', '/notifications/read-all'],
      ['post', `/notifications/${NID}/read`],
      ['put', '/notifications/location', { lat: 1, lng: 1 }],
      ['delete', '/notifications/location'],
      ['delete', '/notifications/devices', { token: 'a' }],
    ];
    for (const [method, url, body] of cases) {
      const r = await request(app)[method](url).set(auth()).send(body);
      expect(r.status, `${method} ${url}`).toBe(500);
    }
  });
});
