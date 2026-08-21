import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createAndMigrate } from './db/migrate.js';
import { createRepositories } from './db/repositories/index.js';
import { loadSkills, setDynamicService, stripSkillsPricing } from './services/skill-loader.js';
import { DynamicDataService, shouldStripStaticPricing } from './services/dynamic-data-service.js';
import { logger } from './config/logger.js';
import { startTelegramBot } from './services/telegram-bot.js';
import { getRoutingConfig } from './services/lead-routing.js';
import { getSalesComposition } from './services/sales-composition.js';
import { setupGlobalErrorHandlers, setErrorRepos, pruneOldErrors } from './services/error-logger.js';
import { checkWhatsAppApiHealth, sendStartupStatus, startOperationalHealthMonitor } from './services/whatsapp-operational-health.js';
import { startFollowupScheduler } from './services/followup-service.js';
import { startFollowupDigestScheduler } from './services/followup-digest.js';

async function runStartupDiagnostics(dynamicDataAvailable: boolean): Promise<void> {
  const whatsapp = await checkWhatsAppApiHealth();
  logger.info({ publicBaseUrl: env.PUBLIC_BASE_URL, webhookPath: '/webhooks/whatsapp', verifyTokenConfigured: env.WHATSAPP_VERIFY_TOKEN.length > 0 }, '[DIAG] webhook should be configured in Meta');
  await sendStartupStatus({ whatsapp, dynamicDataAvailable });
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
  // Fail at boot (like loadSkills) if a referent pack or the sales profile is
  // missing/invalid, instead of throwing later inside the reply path.
  getSalesComposition();

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

  let telegramInterval: ReturnType<typeof setInterval> | undefined;
  let opsMonitorInterval: ReturnType<typeof setInterval> | undefined;
  let followupInterval: ReturnType<typeof setInterval> | undefined;
  let digestInterval: ReturnType<typeof setInterval> | undefined;
  try {
    telegramInterval = await startTelegramBot(repos);
  } catch (err) {
    logger.error(err, '[INIT] failed to start Telegram bot');
  }

  try {
    followupInterval = startFollowupScheduler(repos);
  } catch (err) {
    logger.error(err, '[INIT] failed to start follow-up scheduler');
  }

  try {
    // Operator report only: reads state and writes to the owner's Telegram chat,
    // never to a customer. Kept separate from the follow-up tick above so a
    // reporting change cannot touch the sending path.
    digestInterval = startFollowupDigestScheduler(repos);
  } catch (err) {
    logger.error(err, '[INIT] failed to start follow-up digest scheduler');
  }

  if (env.NODE_ENV === 'production' || env.STARTUP_DIAGNOSTICS_ENABLED) {
    // Non-blocking: diagnostics make external API calls; never delay startup.
    void runStartupDiagnostics(hasDynamicData);
    opsMonitorInterval = startOperationalHealthMonitor();
  }

  const intervals = { telegramInterval, opsMonitorInterval, followupInterval, digestInterval };
  process.on('SIGTERM', gracefulShutdown('SIGTERM', db, app, intervals));
  process.on('SIGINT', gracefulShutdown('SIGINT', db, app, intervals));
}

interface ShutdownIntervals {
  telegramInterval?: ReturnType<typeof setInterval>;
  opsMonitorInterval?: ReturnType<typeof setInterval>;
  followupInterval?: ReturnType<typeof setInterval>;
  digestInterval?: ReturnType<typeof setInterval>;
}

function gracefulShutdown(signal: string, db: { close: () => void }, app: { close: () => Promise<void> }, intervals: ShutdownIntervals) {
  return async () => {
    logger.info({ signal }, 'shutting down gracefully');
    for (const interval of Object.values(intervals)) {
      if (interval) clearInterval(interval);
    }
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
