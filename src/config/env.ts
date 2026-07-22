import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.ENV_FILE ?? '.env.dev' });

function boolFromEnv(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
  return Boolean(v);
}

const boolSchema = z.preprocess(boolFromEnv, z.boolean());

const KNOWN_PLACEHOLDER_URLS = new Set(['https://bot.yourdomain.com']);
const PRODUCTION_SECRET_KEYS = [
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'DEEPSEEK_API_KEY',
] as const;

const deepseekBaseUrlSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'api.deepseek.com';
}, 'DEEPSEEK_BASE_URL must use https://api.deepseek.com');

export const envSchema = z.object({
  APP_VERSION: z.string().default('1.0'),
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  PORT: z.coerce.number().catch(3000),
  HOST: z.string().default('127.0.0.1'),
  STARTUP_DIAGNOSTICS_ENABLED: boolSchema.default(false),
  PUBLIC_BASE_URL: z.string().default('https://bot.yourdomain.com'),
  PUBLIC_TOUR_URL: z.string().default('https://your-public-site.com/experiences/emerald-mining-tour'),

  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().min(1),
  WHATSAPP_GRAPH_API_VERSION: z.string().default('v24.0'),

  OWNER_NAME: z.string().min(1),
  PARTNER_NAME: z.string().min(1),

  OWNER_PERSONAL_WHATSAPP_NUMBER: z.string().min(1),
  ALERT_CHANNEL: z.enum(['telegram', 'whatsapp', 'log']).default('telegram'),
  HOT_LEAD_THRESHOLD: z.coerce.number().catch(85),
  URGENT_LEAD_THRESHOLD: z.coerce.number().catch(95),
  MAX_OWNER_WHATSAPP_ALERTS_PER_CUSTOMER_PER_DAY: z.coerce.number().catch(1),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_POLLING_ENABLED: boolSchema.default(true),
  LEAD_ROUTING_JSON: z.string().default(''),
  REPORT_EXCLUDED_PHONES: z.string().default(''),
  BRIDGE_FLOW: z.coerce.number().refine(n => n >= 0 && n <= 100, 'must be 0-100').catch(-1),
  BRIDGE_SCORE_THRESHOLD: z.coerce.number().refine(n => n >= 0 && n <= 100, 'must be 0-100').catch(75),
  AI_ENABLED: boolSchema.default(true),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_BASE_URL: deepseekBaseUrlSchema.default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().default('deepseek-v4-flash'),
  DEEPSEEK_MAX_OUTPUT_TOKENS: z.coerce.number().catch(450),
  DEEPSEEK_TEMPERATURE: z.coerce.number().catch(0.35),

  DAILY_AI_BUDGET_USD: z.coerce.number().catch(1.00),
  MONTHLY_AI_BUDGET_USD: z.coerce.number().catch(20.00),
  MAX_AI_CALLS_PER_CUSTOMER_PER_DAY: z.coerce.number().catch(12),
  MAX_AI_CALLS_GLOBAL_PER_DAY: z.coerce.number().catch(300),
  AI_CACHE_TTL_SECONDS: z.coerce.number().catch(604800),

  SEND_IMAGES_ENABLED: boolSchema.default(true),
  MAX_GALLERY_IMAGES_PER_SEND: z.coerce.number().catch(5),
  MAX_BOT_MESSAGES_PER_CUSTOMER_PER_HOUR: z.coerce.number().catch(50),
  MAX_BOT_MESSAGES_PER_CUSTOMER_PER_DAY: z.coerce.number().catch(120),
  ALLOW_CUSTOMER_REENGAGEMENT_TEMPLATES: boolSchema.default(false),
  TIME_FOLLOW_HOURS: z.coerce.number().min(1 / 60).max(19).catch(4),
  TIME_FINAL_NUDGE_HOURS: z.coerce.number().min(1 / 60).max(23).catch(22),
  FOLLOW_UP_SEND_START_HOUR: z.coerce.number().int().min(0).max(23).catch(8),
  FOLLOW_UP_SEND_END_HOUR: z.coerce.number().int().min(1).max(24).catch(20),

  SQLITE_PATH: z.string().default('./data/bot.sqlite'),

  DYNAMIC_SKILL_URL: z.union([z.literal(''), z.string().url()]).default(''),
  DYNAMIC_SKILL_REFRESH_MS: z.coerce.number().catch(5000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
}).refine(
  value => value.TIME_FINAL_NUDGE_HOURS > value.TIME_FOLLOW_HOURS,
  { message: 'TIME_FINAL_NUDGE_HOURS must be greater than TIME_FOLLOW_HOURS', path: ['TIME_FINAL_NUDGE_HOURS'] },
).superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'production') return;
  for (const key of PRODUCTION_SECRET_KEYS) {
    if (/^(change-me|test)$/i.test(value[key])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${key} must not use a placeholder in production`, path: [key] });
    }
  }
  try {
    if (new URL(value.PUBLIC_BASE_URL).protocol !== 'https:' || KNOWN_PLACEHOLDER_URLS.has(value.PUBLIC_BASE_URL)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PUBLIC_BASE_URL must be a configured HTTPS URL in production', path: ['PUBLIC_BASE_URL'] });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PUBLIC_BASE_URL must be a configured HTTPS URL in production', path: ['PUBLIC_BASE_URL'] });
  }
});

export const env = envSchema.parse(process.env);
