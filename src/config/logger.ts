import pino from 'pino';
import { env } from './env.js';

function maskPhone(value: unknown): string {
  const str = String(value ?? '');
  if (str.length <= 6) return str;
  return str.slice(0, 3) + '***' + str.slice(-3);
}

function maskPhonesInText(value: string): string {
  return value.replace(/\+?\d[\d\s-]{8,}\d/g, match => maskPhone(match.replace(/\D/g, '')));
}

function truncateBody(value: unknown): string {
  const str = maskPhonesInText(String(value ?? ''));
  if (str.length <= 80) return str;
  return str.slice(0, 80) + '\u2026';
}

function truncateReply(value: unknown): string {
  const str = maskPhonesInText(String(value ?? ''));
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
    from: maskPhone,
    to: maskPhone,
    chatId: maskPhone,
    agentChatId: maskPhone,
    assignedAgentChat: maskPhone,
    customerPhone: maskPhone,
    customer_phone: maskPhone,
    displayPhoneNumber: maskPhone,
    display_phone_number: maskPhone,
    phones: (value: unknown) => Array.isArray(value)
      ? value.map(phone => typeof phone === 'object' && phone !== null
        ? { ...phone, display_phone_number: maskPhone((phone as { display_phone_number?: unknown }).display_phone_number) }
        : phone)
      : value,
    body: truncateBody,
    message: truncateBody,
    preview: truncateBody,
    reply: truncateReply,
    text: truncateBody,
    url: sanitizeUrl,
  },
});
