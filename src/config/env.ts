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
  WEBHOOK_OWNER_ONLY_ENABLED: boolSchema.default(false),
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
  DEEPSEEK_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().catch(800),
  // 32768 was a guess and was ~8x too low, which made `measure:prompt` fail the
  // context check on a prompt the model accepts without complaint. Probed against the
  // live API on 2026-08-14: `deepseek-v4-flash` accepted a 260,085-token prompt
  // (`/chat/completions`, max_tokens=1, no error). 65536 keeps a 4x margin below what
  // is proven while leaving ~30k of slack over the measured worst case (~34.9k).
  // Raising this cannot inflate cost on its own: history is separately capped by
  // DEEPSEEK_HISTORY_MAX_CHARS. Re-probe before assuming a different model's limit.
  DEEPSEEK_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().catch(65536),
  DEEPSEEK_HISTORY_MAX_CHARS: z.coerce.number().int().positive().catch(12000),
  DEEPSEEK_TEMPERATURE: z.coerce.number().catch(0.2),
  DEEPSEEK_INPUT_COST_PER_MILLION_USD: z.coerce.number().nonnegative().catch(0.15),
  DEEPSEEK_OUTPUT_COST_PER_MILLION_USD: z.coerce.number().nonnegative().catch(0.60),

  DAILY_AI_BUDGET_USD: z.coerce.number().positive().catch(2.00),
  MONTHLY_AI_BUDGET_USD: z.coerce.number().positive().catch(30.00),
  MAX_AI_CALLS_PER_CUSTOMER_PER_DAY: z.coerce.number().int().positive().catch(30),
  MAX_AI_CALLS_GLOBAL_PER_DAY: z.coerce.number().int().positive().catch(1500),
  AI_CACHE_TTL_SECONDS: z.coerce.number().catch(604800),

  SEND_IMAGES_ENABLED: boolSchema.default(true),
  MEDIA_MARKER_RETRY_ENABLED: boolSchema.default(true),
  MESSAGE_DELAY: boolSchema.default(false),
  MAX_GALLERY_IMAGES_PER_SEND: z.coerce.number().catch(5),
  MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_HOUR: z.coerce.number().int().nonnegative().catch(45),
  MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_DAY: z.coerce.number().int().nonnegative().catch(150),
  CONTEXTUAL_IMAGES_ENABLED: boolSchema.default(false),
  // Minutes, not hours: the gap is a conversational cadence knob. An hours-scale
  // gate allows only one photo per chat, since a chat lasts minutes.
  CONTEXTUAL_IMAGES_MIN_GAP_MINUTES: z.coerce.number().min(0).catch(3),
  CONTEXTUAL_IMAGES_MAX_PER_72H: z.coerce.number().int().min(1).catch(6),
  // Fraction of theme-matching turns that actually send a contextual image. A
  // sub-1 probability makes cadence unpredictable (human-like) instead of firing
  // on every eligible turn.
  CONTEXTUAL_IMAGES_PROBABILITY: z.coerce.number().min(0).max(1).catch(0.6),
  MAX_BOT_MESSAGES_PER_CUSTOMER_PER_HOUR: z.coerce.number().catch(50),
  MAX_BOT_MESSAGES_PER_CUSTOMER_PER_DAY: z.coerce.number().catch(120),
  SQLITE_PATH: z.string().default('./data/bot.sqlite'),

  DYNAMIC_SKILL_URL: z.union([z.literal(''), z.string().url()]).default(''),
  DYNAMIC_SKILL_REFRESH_MS: z.coerce.number().catch(5000),

  MERCADOPAGO_ACCESS_TOKEN: z.string().default(''),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().default(''),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Post-24h follow-up template (one-shot, explicit opt-in, no LLM). LIVE feature —
  // this is the switch that authorises real Meta template sends.
  ALLOW_FOLLOWUP_TEMPLATE: boolSchema.default(false),
  // Approved Meta template names. ES and EN are SEPARATE templates in WhatsApp
  // Manager, so the name must switch with the language, not just `language.code`.
  FOLLOWUP_TEMPLATE_NAME: z.string().default('tour_followup_nodate_v1'),
  FOLLOWUP_TEMPLATE_NAME_EN: z.string().default(''),
  /** `image` = the approved template has a REQUIRED image header; send is skipped when no image resolves. */
  FOLLOWUP_TEMPLATE_HEADER: z.enum(['image', 'none']).default('image'),
  FOLLOWUP_HOURS_AFTER_INBOUND: z.coerce.number().int().positive().catch(24),
  FOLLOWUP_POLL_MS: z.coerce.number().int().min(1000).catch(60000),
  FOLLOWUP_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).catch(3),
  FOLLOWUP_MAX_SENDS_PER_TICK: z.coerce.number().int().positive().catch(25),
  /** Minutes a `pending`/`claimed` claim may sit before another tick may reclaim it after a crash. */
  FOLLOWUP_CLAIM_STALE_MINUTES: z.coerce.number().int().positive().catch(10),
  FOLLOWUP_DEV_MINUTES: z.coerce.number().int().nonnegative().catch(0),
  FOLLOWUP_DEV_ALLOWLIST_PHONES: z.string().default(''),

  // --- Stage 1: consent ask (free-form, LLM-written, inside the 24h window) ---
  // SEPARATE switch from `ALLOW_FOLLOWUP_TEMPLATE` above and from
  // `FOLLOWUP_RECURRING_ENABLED` below. Never alias any of the three: each
  // authorises a different outbound path.
  FOLLOWUP_CONSENT_ASK_ENABLED: boolSchema.default(false),
  /**
   * Hours after the CUSTOMER's last inbound. Capped at 23 because Meta's
   * customer-service window is measured from the customer's message, not ours —
   * a later value would put the free-form ask outside the window.
   *
   * Defaults to 18, not the 23 ceiling: eligibility also requires the window to
   * still be open (24h minus a 10min safety margin), so 23 left a ~50 minute slot
   * per customer. Any tick missed inside it — a state guard, a paused bot, an LLM
   * hiccup — pushed the ask past the window for good. 18 gives ~5h50m.
   */
  FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND: z.coerce.number().int().min(1).max(23).catch(18),
  /** Dev-only: seconds instead of hours, so a full cycle is observable in one sitting. */
  FOLLOWUP_DEV_CONSENT_SECONDS: z.coerce.number().int().nonnegative().catch(0),
  /**
   * Gallery theme whose photo carries the consent ask as its caption (e.g. `mine`).
   * The value must be a type declared in the feed's `media.types` vocabulary — it
   * lives in config, not TypeScript, so the catalog stays the only source of theme
   * names. Empty (default) sends the ask as plain text; an unknown type or a feed
   * with no photo of that type also falls back to text rather than picking a
   * wrong-theme image.
   */
  FOLLOWUP_CONSENT_ASK_IMAGE_TYPE: z.string().default(''),
  /**
   * Seconds after consent activates during which a repeated bare "sí" does NOT
   * close the consent cycle. Customers double-tap send, and without this the echo
   * revokes the permission granted milliseconds earlier while the bot is still
   * promising to write back. `0` disables the grace window. Only bare
   * affirmations qualify; any message with real content still closes the cycle.
   */
  FOLLOWUP_CONSENT_DUPLICATE_GRACE_SECONDS: z.coerce.number().int().nonnegative().catch(120),
  /**
   * Gallery theme used for the APPROVED TEMPLATE header image (one-shot and
   * recurring). When set, a random photo of that theme is preferred over the plan
   * brochure card, so a customer receiving several templates does not see the same
   * image every time. Rotation is bounded by the 72h `media_sends` record, and the
   * plan card remains the fallback when the theme yields nothing.
   */
  FOLLOWUP_TEMPLATE_IMAGE_TYPE: z.string().default(''),

  // --- Stages 3-4: recurring approved template (allowed OUTSIDE the 24h window) ---
  FOLLOWUP_RECURRING_ENABLED: boolSchema.default(false),
  /** First production interval; later intervals multiply by 3 (1, 3, 9, 27…). */
  FOLLOWUP_RECURRING_INTERVAL_MONTHS: z.coerce.number().int().min(1).catch(1),
  /** Dev-only: seconds instead of months, so r1/r2/r3 land inside a short test run. */
  FOLLOWUP_DEV_RECURRING_SECONDS: z.coerce.number().int().nonnegative().catch(0),
  FOLLOWUP_RECURRING_TEMPLATE_NAME: z.string().default(''),
  FOLLOWUP_RECURRING_TEMPLATE_NAME_EN: z.string().default(''),
  FOLLOWUP_RECURRING_TEMPLATE_HEADER: z.enum(['image', 'none']).default('image'),
  /** Total recurring sends per consent cycle. 0 = unbounded. */
  FOLLOWUP_MAX_RECURRING_SENDS: z.coerce.number().int().nonnegative().catch(12),
  /**
   * Absolute silence floor before ANY recurring template, independent of the
   * cadence interval. Consent authorises writing to a dormant customer; it never
   * authorises landing a template shortly after a live conversation, even if the
   * cadence interval is configured short.
   */
  FOLLOWUP_RECURRING_MIN_SILENCE_HOURS: z.coerce.number().int().min(1).catch(72),
  /** Dev-only: seconds instead of hours for the silence floor. */
  FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS: z.coerce.number().int().nonnegative().catch(0),

  /**
   * Operator-only daily digest of scheduled and already-sent follow-ups. Reads
   * state and writes to the owner's Telegram chat; it never messages a customer,
   * so it is NOT a fourth outbound path.
   */
  FOLLOWUP_DIGEST_ENABLED: boolSchema.default(false),
  /**
   * Trigger hour in Colombia local time (fixed UTC-5). Deliberately Bogota rather
   * than UTC: the operator reads "hoy" as their own day. Note this makes the digest
   * window disagree by 5h with /report and /stats, which use UTC midnight.
   */
  FOLLOWUP_DIGEST_HOUR_BOGOTA: z.coerce.number().int().min(0).max(23).catch(8),
  /**
   * Dev-only: send one digest at boot instead of waiting for the trigger hour.
   * Rejected in production, where it would fire on every deploy.
   */
  FOLLOWUP_DIGEST_DEV_FORCE: boolSchema.default(false),
}).superRefine((value, ctx) => {
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
  // Fail startup rather than let a dev-only accelerator ship: FOLLOWUP_DEV_MINUTES
  // would template real customers minutes after they wrote, and an allowlist in
  // production would silently suppress every non-listed lead.
  if (value.FOLLOWUP_DEV_MINUTES > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FOLLOWUP_DEV_MINUTES must be 0 in production', path: ['FOLLOWUP_DEV_MINUTES'] });
  }
  if (value.FOLLOWUP_DEV_CONSENT_SECONDS > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FOLLOWUP_DEV_CONSENT_SECONDS must be 0 in production', path: ['FOLLOWUP_DEV_CONSENT_SECONDS'] });
  }
  if (value.FOLLOWUP_DEV_RECURRING_SECONDS > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FOLLOWUP_DEV_RECURRING_SECONDS must be 0 in production', path: ['FOLLOWUP_DEV_RECURRING_SECONDS'] });
  }
  if (value.FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS must be 0 in production', path: ['FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS'] });
  }
  if (value.FOLLOWUP_DEV_ALLOWLIST_PHONES.trim() !== '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FOLLOWUP_DEV_ALLOWLIST_PHONES must be empty in production', path: ['FOLLOWUP_DEV_ALLOWLIST_PHONES'] });
  }
  if (value.FOLLOWUP_DIGEST_DEV_FORCE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FOLLOWUP_DIGEST_DEV_FORCE must be false in production', path: ['FOLLOWUP_DIGEST_DEV_FORCE'] });
  }
  // A recurring send with no approved template name would fail at Meta on every tick.
  if (value.FOLLOWUP_RECURRING_ENABLED && value.FOLLOWUP_RECURRING_TEMPLATE_NAME.trim() === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FOLLOWUP_RECURRING_TEMPLATE_NAME is required when FOLLOWUP_RECURRING_ENABLED=true', path: ['FOLLOWUP_RECURRING_TEMPLATE_NAME'] });
  }
});

export const env = envSchema.parse(process.env);
