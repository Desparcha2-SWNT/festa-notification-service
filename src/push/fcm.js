import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Solo estos códigos significan que el token ya no sirve: el dispositivo se da de baja.
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

// Error del payload o de la petición, no del token: FCM lo marca como INVALID_ARGUMENT. Es permanente,
// pero no implica un token vencido, así que no se borra ningún dispositivo y tampoco se reintenta.
const PERMANENT_CODES = new Set(['messaging/invalid-argument']);

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
/**
 * Resultado por token: `okTokens` ya recibieron el push; `retryableTokens` fallaron de forma reintentable;
 * `invalidTokens` deben darse de baja; `permanentTokens` fallaron por el payload y no se reintentan.
 */
export async function sendPush(tokens, { title, body, data = {} }) {
  const empty = { sent: 0, failed: 0, invalidTokens: [], permanentTokens: [], okTokens: [], retryableTokens: [] };
  if (tokens.length === 0) return empty;
  const messaging = await getMessaging();
  if (!messaging) return { ...empty, disabled: true };

  const stringData = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  const result = { ...empty, invalidTokens: [], permanentTokens: [], okTokens: [], retryableTokens: [] };
  // FCM acepta hasta 500 tokens por llamada.
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title, body },
      data: stringData,
      android: { priority: 'high' },
    });
    result.sent += res.successCount;
    result.failed += res.failureCount;
    res.responses.forEach((r, idx) => {
      const token = batch[idx];
      if (r.success) return result.okTokens.push(token);
      const code = r.error?.code;
      if (INVALID_TOKEN_CODES.has(code)) result.invalidTokens.push(token);
      else if (PERMANENT_CODES.has(code)) result.permanentTokens.push(token);
      else result.retryableTokens.push(token);
    });
  }
  return result;
}

export function _resetForTests() {
  messagingPromise = undefined;
}
