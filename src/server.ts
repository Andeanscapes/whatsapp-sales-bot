import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createAndMigrate } from './db/migrate.js';
import { createRepositories } from './db/repositories/index.js';
import { loadSkills, setDynamicService, stripSkillsPricing } from './services/skill-loader.js';
import { DynamicDataService, shouldStripStaticPricing } from './services/dynamic-data-service.js';
import { logger } from './config/logger.js';
import { startTelegramBot } from './services/telegram-bot.js';
import { getRoutingConfig } from './services/lead-routing.js';
import { setupGlobalErrorHandlers, setErrorRepos, pruneOldErrors } from './services/error-logger.js';
import { startFollowUpScheduler } from './services/follow-up-service.js';

async function runStartupDiagnostics(): Promise<void> {
  // WhatsApp phone number info — validates token + phone number ID
  const waUrl = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,code_verification_status`;
  try {
    const waRes = await fetch(waUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    });
    if (waRes.ok) {
      const waData = await waRes.json() as Record<string, unknown>;
      logger.info({ phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, displayPhoneNumber: waData.display_phone_number, verifiedName: waData.verified_name, codeVerificationStatus: waData.code_verification_status }, '[DIAG] WhatsApp phone number valid');
    } else {
      logger.error({ status: waRes.status, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }, '[DIAG] WhatsApp phone number lookup FAILED');
    }
  } catch (err) {
      logger.error({ err, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }, '[DIAG] WhatsApp API unreachable');
  }

  const phonesUrl = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/phone_numbers?fields=id,display_phone_number,verified_name`;
  try {
    const phonesRes = await fetch(phonesUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    });
    if (phonesRes.ok) {
      const phonesData = await phonesRes.json() as { data?: Array<{ id?: string; display_phone_number?: string; verified_name?: string }> };
      const phones = phonesData.data ?? [];
      logger.info({ businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID, phones, configuredPhoneFound: phones.some(phone => phone.id === env.WHATSAPP_PHONE_NUMBER_ID) }, '[DIAG] WhatsApp WABA phone list');
    } else {
      logger.error({ status: phonesRes.status, businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID }, '[DIAG] WhatsApp WABA phone list FAILED');
    }
  } catch (err) {
    logger.error({ err, businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID }, '[DIAG] WhatsApp WABA lookup unreachable');
  }

  // Webhook config reminder
  logger.info({ publicBaseUrl: env.PUBLIC_BASE_URL, webhookPath: '/webhooks/whatsapp', verifyTokenConfigured: env.WHATSAPP_VERIFY_TOKEN.length > 0 }, '[DIAG] webhook should be configured in Meta');
}

async function start() {
  let hasDynamicData = false;
  if (env.DYNAMIC_SKILL_URL) {
    const dds = new DynamicDataService(env.DYNAMIC_SKILL_URL, env.DYNAMIC_SKILL_REFRESH_MS);
    setDynamicService(dds);
    await dds.refreshIfStale();
    hasDynamicData = dds.isAvailable;
    if (!hasDynamicData) {
      logger.warn('[INIT] R2 dynamic skill not available — static pricing stripped for safety');
    }
  }

  loadSkills();
  getRoutingConfig();

  if (shouldStripStaticPricing(env.DYNAMIC_SKILL_URL, hasDynamicData)) {
    stripSkillsPricing();
    logger.info('[INIT] static skill pricing stripped — bot will ask team to confirm prices');
  }

  const db = createAndMigrate(env.SQLITE_PATH);
  const repos = createRepositories(db);

  setupGlobalErrorHandlers();
  setErrorRepos(repos);
  pruneOldErrors(repos);

  const app = await buildApp(repos);

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT }, 'server started');

  if (env.STARTUP_DIAGNOSTICS_ENABLED) {
    // Non-blocking: diagnostics make external Graph API calls; never delay startup.
    void runStartupDiagnostics();
  }

  let telegramInterval: ReturnType<typeof setInterval> | undefined;
  let followUpInterval: ReturnType<typeof setInterval> | undefined;
  try {
    telegramInterval = await startTelegramBot(repos);
  } catch (err) {
    logger.error(err, '[INIT] failed to start Telegram bot');
  }
  try {
    followUpInterval = startFollowUpScheduler(repos);
  } catch (err) {
    logger.error(err, '[INIT] failed to start follow-up scheduler');
  }

  process.on('SIGTERM', gracefulShutdown('SIGTERM', db, app, telegramInterval, followUpInterval));
  process.on('SIGINT', gracefulShutdown('SIGINT', db, app, telegramInterval, followUpInterval));
}

function gracefulShutdown(signal: string, db: { close: () => void }, app: { close: () => Promise<void> }, telegramInterval?: ReturnType<typeof setInterval>, followUpInterval?: ReturnType<typeof setInterval>) {
  return async () => {
    logger.info({ signal }, 'shutting down gracefully');
    if (telegramInterval) clearInterval(telegramInterval);
    if (followUpInterval) clearInterval(followUpInterval);
    try {
      await app.close();
    } catch (err) {
      logger.error(err, 'error closing fastify');
    }
    try {
      db.close();
    } catch (err) {
      logger.error(err, 'error closing database');
    }
    process.exit(0);
  };
}

start().catch((err) => {
  logger.fatal(err, 'failed to start server');
  process.exit(1);
});
