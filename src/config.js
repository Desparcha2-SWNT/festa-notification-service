import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export function parseTrustProxy(value) {
  if (value === undefined || value === '') return 1;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export const config = {
  serviceName: 'notification-service',
  port: Number(process.env.PORT ?? 8087),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  mongoUrl: required('MONGO_URL'),
  amqpUrl: required('AMQP_URL'),
  jwtIssuer: required('JWT_ISSUER'),
  jwtPublicKeyPath: required('JWT_PUBLIC_KEY_PATH'),
  contractsDir: process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts'),
  // JSON de la cuenta de servicio de Firebase. Si no existe o es el placeholder `{}` que crea
  // festa-infra/scripts/gen-secrets.sh, el servicio funciona igual pero solo guarda las
  // notificaciones en la bandeja de la app (sin push).
  fcmServiceAccountPath: process.env.FCM_SERVICE_ACCOUNT_PATH ?? '',
  // RF12: radio para "eventos cercanos" y antigüedad máxima de la última ubicación conocida.
  nearbyRadiusMeters: Number(process.env.NEARBY_RADIUS_METERS ?? 3000),
  locationMaxAgeHours: Number(process.env.LOCATION_MAX_AGE_HOURS ?? 72),
  nearbyMaxRecipients: Number(process.env.NEARBY_MAX_RECIPIENTS ?? 500),
  // RF12: recordatorio de asistencia, cuántas horas antes del evento.
  reminderHoursBefore: Number(process.env.REMINDER_HOURS_BEFORE ?? 2),
};
