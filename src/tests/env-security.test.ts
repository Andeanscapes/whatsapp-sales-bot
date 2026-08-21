import { describe, expect, it } from 'vitest';
import { envSchema } from '../config/env.js';

const productionEnv = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://bot.example.com',
  WHATSAPP_VERIFY_TOKEN: 'verify-fixture-value',
  WHATSAPP_ACCESS_TOKEN: 'access-fixture-value',
  WHATSAPP_APP_SECRET: 'app-secret-fixture-value',
  WHATSAPP_PHONE_NUMBER_ID: 'phone-id-fixture',
  WHATSAPP_BUSINESS_ACCOUNT_ID: 'account-id-fixture',
  OWNER_NAME: 'Owner',
  PARTNER_NAME: 'Partner',
  OWNER_PERSONAL_WHATSAPP_NUMBER: '15550000001',
  DEEPSEEK_API_KEY: 'deepseek-fixture-value',
};

describe('production environment security', () => {
  it('accepts configured production credentials and the DeepSeek API host', () => {
    expect(envSchema.safeParse(productionEnv).success).toBe(true);
  });

  it('rejects placeholder production credentials', () => {
    expect(envSchema.safeParse({ ...productionEnv, WHATSAPP_VERIFY_TOKEN: 'change-me' }).success).toBe(false);
  });

  it.each([
    'http://api.deepseek.com',
    'https://deepseek.example.com',
  ])('rejects unsafe DeepSeek endpoint %s', DEEPSEEK_BASE_URL => {
    expect(envSchema.safeParse({ ...productionEnv, DEEPSEEK_BASE_URL }).success).toBe(false);
  });

  it.each([
    ['FOLLOWUP_DEV_MINUTES', '2'],
    ['FOLLOWUP_DEV_CONSENT_SECONDS', '30'],
    ['FOLLOWUP_DEV_RECURRING_SECONDS', '45'],
    ['FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS', '120'],
    ['FOLLOWUP_DEV_ALLOWLIST_PHONES', '573000000001'],
  ])('rejects dev-only follow-up accelerator %s in production', (key, value) => {
    expect(envSchema.safeParse({ ...productionEnv, [key]: value }).success).toBe(false);
  });

  it('rejects recurring follow-ups enabled with no approved template name', () => {
    const result = envSchema.safeParse({
      ...productionEnv,
      FOLLOWUP_RECURRING_ENABLED: 'true',
      FOLLOWUP_RECURRING_TEMPLATE_NAME: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('follow-up switches stay independent', () => {
  /**
   * Regression guard: these two switches were once aliased to each other, which made
   * enabling the consent ask silently authorise the separate one-shot template path.
   * They gate different things and must never be collapsed.
   */
  it('does not let FOLLOWUP_CONSENT_ASK_ENABLED imply ALLOW_FOLLOWUP_TEMPLATE', () => {
    const parsed = envSchema.parse({ ...productionEnv, FOLLOWUP_CONSENT_ASK_ENABLED: 'true' });
    expect(parsed.FOLLOWUP_CONSENT_ASK_ENABLED).toBe(true);
    expect(parsed.ALLOW_FOLLOWUP_TEMPLATE).toBe(false);
  });

  it('does not let ALLOW_FOLLOWUP_TEMPLATE imply FOLLOWUP_CONSENT_ASK_ENABLED', () => {
    const parsed = envSchema.parse({ ...productionEnv, ALLOW_FOLLOWUP_TEMPLATE: 'true' });
    expect(parsed.ALLOW_FOLLOWUP_TEMPLATE).toBe(true);
    expect(parsed.FOLLOWUP_CONSENT_ASK_ENABLED).toBe(false);
  });

  it('keeps the live one-shot template keys as first-class config', () => {
    const parsed = envSchema.parse({
      ...productionEnv,
      FOLLOWUP_TEMPLATE_NAME: 'custom_template_v2',
      FOLLOWUP_HOURS_AFTER_INBOUND: '30',
    });
    expect(parsed.FOLLOWUP_TEMPLATE_NAME).toBe('custom_template_v2');
    expect(parsed.FOLLOWUP_HOURS_AFTER_INBOUND).toBe(30);
  });

  it('keeps the consent ask inside the 24h free-form window', () => {
    // An out-of-range value must never be used verbatim. It falls back to the
    // safe default (18), which is deliberately below the 23 ceiling: eligibility
    // also requires the window to still be open, so 23 left only a ~50 minute
    // slot per customer and a single missed tick killed the ask.
    const parsed = envSchema.parse({ ...productionEnv, FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND: '24' })
      .FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND;
    expect(parsed).toBeLessThanOrEqual(23);
    expect(parsed).toBe(18);
  });

  it('still honours an explicit in-range override', () => {
    expect(envSchema.parse({ ...productionEnv, FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND: '20' })
      .FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND).toBe(20);
  });

  it('keeps all three outbound switches independent', () => {
    const parsed = envSchema.parse({
      ...productionEnv,
      FOLLOWUP_RECURRING_ENABLED: 'true',
      FOLLOWUP_RECURRING_TEMPLATE_NAME: 'tour_followup_nodate_v1',
    });
    expect(parsed.FOLLOWUP_RECURRING_ENABLED).toBe(true);
    expect(parsed.ALLOW_FOLLOWUP_TEMPLATE).toBe(false);
    expect(parsed.FOLLOWUP_CONSENT_ASK_ENABLED).toBe(false);
  });

  it('defaults the recurring cap to 12 sends', () => {
    expect(envSchema.parse(productionEnv).FOLLOWUP_MAX_RECURRING_SENDS).toBe(12);
  });
});
