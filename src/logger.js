import pino from 'pino';
import { config } from './config.js';

// Lo que no debe quedar en el log de una petición: el token y las cookies. Con `pinoHttp({ logger })` la
// redacción tiene que ir en este logger: las opciones de redacción de pino-http se ignoran.
export const redact = {
  paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  censor: '[REDACTED]',
};

export function createLogger(destination, level = config.logLevel) {
  return pino({ level, redact }, destination);
}

export const logger = createLogger();
