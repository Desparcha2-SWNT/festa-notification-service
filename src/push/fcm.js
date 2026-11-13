import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

let messagingPromise;

/**
 * Cliente de Firebase Cloud Messaging (RF12). Se inicializa perezosamente y solo si hay una cuenta
 * de servicio real; si no, devuelve null y el servicio trabaja en modo "solo bandeja".
 */
async function getMessaging() {
  messagingPromise ??= (async () => {
    const file = config.fcmServiceAccountPath;
    if (!file || !fs.existsSync(file)) {
      logger.warn('sin FCM_SERVICE_ACCOUNT_PATH: las notificaciones solo quedan en la bandeja de la app');
      return null;
    }
    const account = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!account.project_id || !account.private_key) {
      logger.warn('la cuenta de servicio de Firebase es un placeholder: sin push, solo bandeja');
      return null;
    }
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getMessaging: messaging } = await import('firebase-admin/messaging');
    const app = initializeApp({ credential: cert(account) }, 'festa-notification');
    logger.info({ projectId: account.project_id }, 'FCM inicializado');
    return messaging(app);
  })();
  return messagingPromise;
}

/**
 * Envía un push a un conjunto de tokens. Devuelve cuántos fallaron y qué tokens ya no sirven
 * (para borrarlos). Sin FCM configurado no envía nada y no cuenta fallos.
 */
export async function sendPush(tokens, { title, body, data = {} }) {
  if (tokens.length === 0) return { sent: 0, failed: 0, invalidTokens: [] };
  const messaging = await getMessaging();
  if (!messaging) return { sent: 0, failed: 0, invalidTokens: [], disabled: true };

  const stringData = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  let sent = 0;
  let failed = 0;
  const invalidTokens = [];
  // FCM acepta hasta 500 tokens por llamada.
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title, body },
      data: stringData,
      android: { priority: 'high' },
    });
    sent += res.successCount;
    failed += res.failureCount;
    res.responses.forEach((r, idx) => {
      if (!r.success && INVALID_TOKEN_CODES.has(r.error?.code)) invalidTokens.push(batch[idx]);
    });
  }
  return { sent, failed, invalidTokens };
}

export function _resetForTests() {
  messagingPromise = undefined;
}
