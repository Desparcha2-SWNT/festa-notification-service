// Envío por FCM con firebase-admin simulado: inicialización perezosa, modo "solo bandeja" y
// clasificación de cada token (ok, reintentable, inválido, permanente).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ cfg: { fcmServiceAccountPath: '' }, send: vi.fn(), initializeApp: vi.fn(() => 'app') }));
vi.mock('../src/config.js', () => ({ config: f.cfg }));
vi.mock('../src/logger.js', () => ({ logger: { warn: () => {}, info: () => {}, error: () => {} } }));
vi.mock('firebase-admin/app', () => ({ initializeApp: f.initializeApp, cert: (a) => ({ cert: a.project_id }) }));
vi.mock('firebase-admin/messaging', () => ({ getMessaging: () => ({ sendEachForMulticast: f.send }) }));

const { sendPush, _resetForTests } = await import('../src/push/fcm.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-test-'));
let seq = 0;
function account(content) {
  const file = path.join(dir, `sa-${++seq}.json`);
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}
const msg = { title: 'Hola', body: 'Cuerpo' };

describe('sendPush', () => {
  beforeEach(() => {
    _resetForTests();
    f.send.mockReset();
    f.initializeApp.mockClear();
    f.cfg.fcmServiceAccountPath = account({ project_id: 'festa', private_key: 'k' });
  });
  afterEach(() => _resetForTests());

  it('sin tokens no inicializa FCM ni envía nada', async () => {
    const r = await sendPush([], msg);
    expect(r).toMatchObject({ sent: 0, failed: 0, okTokens: [] });
    expect(f.initializeApp).not.toHaveBeenCalled();
  });

  it('sin cuenta de servicio trabaja en modo solo bandeja', async () => {
    f.cfg.fcmServiceAccountPath = '';
    const r = await sendPush(['t1'], msg);
    expect(r.disabled).toBe(true);
    expect(r.failed).toBe(0);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('con la cuenta placeholder {} tampoco envía', async () => {
    f.cfg.fcmServiceAccountPath = account({});
    expect((await sendPush(['t1'], msg)).disabled).toBe(true);
    expect(f.initializeApp).not.toHaveBeenCalled();
  });

  it('clasifica cada token según el código de error y convierte data a texto', async () => {
    f.send.mockResolvedValue({
      successCount: 1,
      failureCount: 3,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/invalid-argument' } },
        { success: false, error: { code: 'messaging/internal-error' } },
      ],
    });
    const r = await sendPush(['a', 'b', 'c', 'd'], { ...msg, data: { eventId: 'e1', n: 3, nada: null } });
    expect(r).toMatchObject({ sent: 1, failed: 3, okTokens: ['a'], invalidTokens: ['b'], permanentTokens: ['c'], retryableTokens: ['d'] });
    const call = f.send.mock.calls[0][0];
    expect(call.data).toEqual({ eventId: 'e1', n: '3' });
    expect(call.notification).toEqual(msg);
    expect(call.android.priority).toBe('high');
  });

  it('parte los envíos en lotes de 500 tokens e inicializa FCM una sola vez', async () => {
    f.send.mockImplementation(async ({ tokens }) => ({ successCount: tokens.length, failureCount: 0, responses: tokens.map(() => ({ success: true })) }));
    const tokens = Array.from({ length: 1201 }, (_, i) => `t${i}`);
    const r = await sendPush(tokens, msg);
    expect(f.send.mock.calls.map((c) => c[0].tokens.length)).toEqual([500, 500, 201]);
    expect(r.sent).toBe(1201);
    await sendPush(['x'], msg);
    expect(f.initializeApp).toHaveBeenCalledTimes(1);
  });
});
