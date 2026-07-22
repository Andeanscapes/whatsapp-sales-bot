import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest/esbuild does not recognize tsconfig target ES2024 yet.
  esbuild: {
    target: 'es2022',
    tsconfigRaw: {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
      },
    },
  },
  test: {
    globals: true,
    exclude: ['src/tests/conversation-eval/**', '.opencode/**', 'node_modules/**', 'dist/**'],
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
      TELEGRAM_CHAT_ID: 'test-owner-chat',
    },
  },
});
