import pino from 'pino';
import { env } from './env.js';

function maskPhone(value: unknown): string {
  const str = String(value ?? '');
  if (str.length <= 6) return str;
  return str.slice(0, 3) + '***' + str.slice(-3);
}

function truncateBody(value: unknown): string {
  const str = String(value ?? '');
  if (str.length <= 80) return str;
  return str.slice(0, 80) + '\u2026';
}

function truncateReply(value: unknown): string {
  const str = String(value ?? '');
  if (str.length <= 120) return str;
  return str.slice(0, 120) + '\u2026';
}

const redactPaths = [
  'authorization',
  '*.authorization',
  'headers.authorization',
  'access_token',
  '*.access_token',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  serializers: {
    phone: maskPhone,
    customerPhone: maskPhone,
    customer_phone: maskPhone,
    body: truncateBody,
    message: truncateBody,
    reply: truncateReply,
    text: truncateBody,
  },
});
