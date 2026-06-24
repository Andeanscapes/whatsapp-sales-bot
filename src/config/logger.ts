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

function sanitizeUrl(value: unknown): string {
  return String(value ?? '').replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
}

const redactPaths = [
  'authorization',
  '*.authorization',
  'headers.authorization',
  'access_token',
  '*.access_token',
  'accessToken',
  '*.accessToken',
  'token',
  '*.token',
  'botToken',
  '*.botToken',
  'apiKey',
  '*.apiKey',
  'deepseekApiKey',
  '*.deepseekApiKey',
  'appSecret',
  '*.appSecret',
  'WHATSAPP_ACCESS_TOKEN',
  '*.WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  '*.WHATSAPP_APP_SECRET',
  'DEEPSEEK_API_KEY',
  '*.DEEPSEEK_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  '*.TELEGRAM_BOT_TOKEN',
  'ADMIN_SECRET',
  '*.ADMIN_SECRET',
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
    url: sanitizeUrl,
  },
});
