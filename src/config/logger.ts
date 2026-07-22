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

const sensitiveQueryParamPattern = /([?&](?:hub\.verify_token|verify_token|access_token|token|api[_-]?key|secret|password|signature)=)[^&#]*/gi;

export function sanitizeUrl(value: unknown): string {
  return String(value ?? '')
    .replace(sensitiveQueryParamPattern, '$1[REDACTED]')
    .replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
}

export function sanitizeSensitiveText(value: unknown): string {
  return sanitizeUrl(value)
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(WHATSAPP_ACCESS_TOKEN|WHATSAPP_APP_SECRET|WHATSAPP_VERIFY_TOKEN|DEEPSEEK_API_KEY|TELEGRAM_BOT_TOKEN|ADMIN_SECRET)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function serializeRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const request = value as Record<string, unknown>;
  const raw = typeof request.raw === 'object' && request.raw !== null
    ? request.raw as Record<string, unknown>
    : request;

  return {
    id: request.id,
    method: request.method ?? raw.method,
    url: sanitizeUrl(request.url ?? raw.url),
    host: request.hostname ?? raw.host,
    remoteAddress: request.ip ?? raw.remoteAddress,
    remotePort: raw.remotePort,
  };
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
    req: serializeRequest,
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
