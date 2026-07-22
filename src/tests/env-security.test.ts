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
});
