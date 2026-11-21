// Flujos completos de notification-service contra un MongoDB real. Se salta si no hay TEST_MONGO_URL
// (p. ej. `docker run -d -p 27018:27017 mongo:7.0` y TEST_MONGO_URL=mongodb://localhost:27018/notif_test).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { jwtPrivateKeyPem } from './fixtures/jwtKeys.js';

const push = vi.hoisted(() => ({ sendPush: vi.fn() }));
vi.mock('../src/push/fcm.js', () => push);

const MONGO = process.env.TEST_MONGO_URL;
if (MONGO) process.env.MONGO_URL = MONGO;

const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const pushSchema = path.join(contractsDir, 'events/notification/push.sent.schema.json');

const ADMIN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const USER = '0b9c7d6e-5f4a-4b3c-8d2e-1a0b9c8d7e6f';
const FAR_USER = '2b9c7d6e-5f4a-4b3c-8d2e-1a0b9c8d7e6f';
const ORGANIZER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const EVENT_ID = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const ECI = { lat: 4.7826, lng: -74.0426 };

let db;
let handlers;
let mongo;
let createApp;
let sendDueReminders;
let n = 0;
const env = (eventType) => ({ eventId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, eventType, correlationId: null });

describe.skipIf(!MONGO)('notification-service con MongoDB', () => {
  beforeAll(async () => {
    mongo = await import('../src/db/mongo.js');
    db = await mongo.connectMongo();
    await db.collection('users').createIndex({ location: '2dsphere' });
    ({ handlers } = await import('../src/messaging/handlers.js'));
    ({ createApp } = await import('../src/app.js'));
    ({ sendDueReminders } = await import('../src/jobs/reminders.js'));
  });
  afterAll(async () => {
    await db?.dropDatabase();
    await mongo?.closeMongo();
  });
  beforeEach(async () => {
    for (const c of ['users', 'notifications', 'outbox', 'reminders', 'attendees', 'events']) await db.collection(c).deleteMany({});
    push.sendPush.mockReset().mockResolvedValue({ sent: 1, failed: 0, invalidTokens: [] });
  });

  it('avisa a los admins de un comercio por verificar, una sola vez aunque se repita el mensaje', async () => {
    await handlers['account.registered']({ userId: ADMIN, role: 'admin', displayName: 'Admin' }, env('account.registered'), db);
    const e = env('merchant.submitted');
    const data = { merchantId: ORGANIZER, userId: ORGANIZER, businessName: 'Café Bohemio', category: 'gastronomico', submittedAt: new Date().toISOString() };
    await handlers['merchant.submitted'](data, e, db);
    await handlers['merchant.submitted'](data, e, db);

    expect(await db.collection('notifications').countDocuments({ userId: ADMIN })).toBe(1);
    expect(await db.collection('outbox').countDocuments({ routingKey: 'push.sent' })).toBe(1);
  });

  it('RF12: solo notifica eventos cercanos a quien dio consentimiento e intereses afines', async () => {
    for (const [id, loc] of [[USER, ECI], [FAR_USER, { lat: 4.6, lng: -74.08 }]]) {
      await handlers['location_consent.granted']({ userId: id, policyVersion: 'v1', grantedAt: new Date().toISOString() }, env('location_consent.granted'), db);
      await handlers['profile.updated']({ userId: id, displayName: 'X', interests: ['musical'], updatedAt: new Date().toISOString() }, env('profile.updated'), db);
      await db.collection('users').updateOne({ _id: id }, { $set: { location: { type: 'Point', coordinates: [loc.lng, loc.lat] }, locationUpdatedAt: new Date(), devices: [{ token: `tok-${id}` }] } });
    }
    const event = {
      eventId: EVENT_ID, organizerId: ORGANIZER, title: 'Jazz en la ECI', category: 'musical', isLive: true, status: 'published',
      startsAt: new Date(Date.now() + 3600_000).toISOString(), endsAt: new Date(Date.now() + 7200_000).toISOString(),
      venue: { name: 'Bloque G', address: 'ECI', location: { lat: ECI.lat + 0.001, lng: ECI.lng } },
    };
    await handlers['event.published'](event, env('event.published'), db);

    const notified = await db.collection('notifications').find({ kind: 'nearby_event' }).toArray();
    expect(notified.map((x) => x.userId)).toEqual([USER]);
    expect(push.sendPush).toHaveBeenCalledWith([`tok-${USER}`], expect.objectContaining({ title: expect.stringContaining('Parche en vivo') }));

    // Al revocar el consentimiento se borra la ubicación.
    await handlers['location_consent.revoked']({ userId: USER, revokedAt: new Date().toISOString() }, env('location_consent.revoked'), db);
    expect((await db.collection('users').findOne({ _id: USER })).location).toBeUndefined();
  });

  it.skipIf(!fs.existsSync(pushSchema))('push.sent cumple el contrato', async () => {
    await handlers['merchant.verified'](
      { merchantId: ORGANIZER, userId: ORGANIZER, businessName: 'Café', category: 'gastronomico', place: { name: 'a', address: 'b', location: ECI }, verifiedBy: ADMIN, verifiedAt: new Date().toISOString() },
      env('merchant.verified'),
      db,
    );
    const row = await db.collection('outbox').findOne({ routingKey: 'push.sent' });
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(fs.readFileSync(pushSchema, 'utf8')));
    expect(validate(row.payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it('confirmar asistencia programa el recordatorio y se envía cuando toca; cancelar el evento lo anula', async () => {
    const startsAt = new Date(Date.now() + 3600_000).toISOString();
    await handlers['attendance.confirmed'](
      { attendanceId: 'a1', eventId: EVENT_ID, eventTitle: 'Jazz', eventStartsAt: startsAt, userId: USER, source: 'rsvp', passIds: ['p1'], attendeeCount: 1, confirmedAt: new Date().toISOString() },
      env('attendance.confirmed'),
      db,
    );
    expect(await db.collection('notifications').countDocuments({ userId: USER })).toBe(1);
    expect(await sendDueReminders(db)).toBe(1); // faltan menos de 2 h
    expect(await sendDueReminders(db)).toBe(0); // no se repite
    expect(await db.collection('notifications').countDocuments({ userId: USER, kind: 'reminder' })).toBe(1);

    await handlers['event.cancelled']({ eventId: EVENT_ID, organizerId: ORGANIZER, title: 'Jazz', reason: 'Lluvia', cancelledAt: new Date().toISOString(), version: 2 }, env('event.cancelled'), db);
    expect(await db.collection('notifications').countDocuments({ userId: USER, kind: 'event_cancelled' })).toBe(1);
  });

  it('account.deleted borra todo lo del usuario', async () => {
    await db.collection('users').insertOne({ _id: USER, devices: [{ token: 't' }] });
    await db.collection('notifications').insertOne({ _id: 'n1', userId: USER });
    await handlers['account.deleted']({ userId: USER, deletedAt: new Date().toISOString() }, env('account.deleted'), db);
    expect(await db.collection('users').countDocuments({ _id: USER })).toBe(0);
    expect(await db.collection('notifications').countDocuments({ userId: USER })).toBe(0);
  });

  describe('API', () => {
    const token = jwt.sign({ role: 'user' }, jwtPrivateKeyPem, { algorithm: 'RS256', issuer: process.env.JWT_ISSUER, subject: USER, expiresIn: '5m' });
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);

    it('registra un dispositivo y lista la bandeja', async () => {
      const app = createApp();
      expect((await auth(request(app).post('/notifications/devices')).send({ token: 'x'.repeat(40), platform: 'android' })).status).toBe(204);
      expect((await db.collection('users').findOne({ _id: USER })).devices).toHaveLength(1);

      await db.collection('notifications').insertOne({ _id: '11111111-1111-4111-8111-111111111111', userId: USER, kind: 'other', title: 't', body: 'b', createdAt: new Date(), readAt: null });
      expect((await auth(request(app).get('/notifications/unread-count'))).body.count).toBe(1);
      expect((await auth(request(app).post('/notifications/11111111-1111-4111-8111-111111111111/read'))).status).toBe(204);
      const list = await auth(request(app).get('/notifications'));
      expect(list.body.items[0].read).toBe(true);
    });

    it('no guarda la ubicación sin consentimiento (RNF5)', async () => {
      const app = createApp();
      expect((await auth(request(app).put('/notifications/location')).send(ECI)).status).toBe(403);
      await db.collection('users').updateOne({ _id: USER }, { $set: { locationConsent: true } }, { upsert: true });
      expect((await auth(request(app).put('/notifications/location')).send(ECI)).status).toBe(204);
    });
  });
});
