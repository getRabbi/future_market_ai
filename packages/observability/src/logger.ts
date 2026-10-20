import pino, { type Logger } from 'pino';

/** Paths that must never reach logs (tokens, secrets, credentials, raw personal data). */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'authorization',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'credentials',
  '*.credentials',
];

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info', destination?: pino.DestinationStream): Logger {
  const opts = {
    name: service,
    level,
    base: { service, env: process.env.NODE_ENV ?? 'development' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(opts, destination) : pino(opts);
}

export type { Logger };
