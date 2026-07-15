import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/tests/conversation-eval/**/*.test.ts'],
    testTimeout: 60000,
    env: {
      AI_ENABLED: 'false',
      WHATSAPP_VERIFY_TOKEN: 'test',
      WHATSAPP_ACCESS_TOKEN: 'test',
      WHATSAPP_APP_SECRET: 'test',
      WHATSAPP_PHONE_NUMBER_ID: 'test',
      WHATSAPP_BUSINESS_ACCOUNT_ID: 'test',
      OWNER_NAME: 'Test Owner',
      PARTNER_NAME: 'Test Partner',
      OWNER_PERSONAL_WHATSAPP_NUMBER: '573000000000',
      DEEPSEEK_API_KEY: 'test',
      MIN_CONVERSATION_SCORE: '70',
    },
  },
});
