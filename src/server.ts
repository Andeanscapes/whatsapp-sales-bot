import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createAndMigrate } from './db/migrate.js';
import { createRepositories } from './db/repositories/index.js';
import { loadSkills, setDynamicService, stripSkillsPricing } from './services/skill-loader.js';
import { DynamicDataService, shouldStripStaticPricing } from './services/dynamic-data-service.js';
import { logger } from './config/logger.js';
import { startTelegramBot } from './services/telegram-bot.js';

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

  if (shouldStripStaticPricing(env.DYNAMIC_SKILL_URL, hasDynamicData)) {
    stripSkillsPricing();
    logger.info('[INIT] static skill pricing stripped — bot will ask team to confirm prices');
  }

  const db = createAndMigrate(env.SQLITE_PATH);
  const repos = createRepositories(db);

  const app = await buildApp(repos);

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT }, 'server started');

  startTelegramBot(repos);

  process.on('SIGTERM', gracefulShutdown('SIGTERM', db, app));
  process.on('SIGINT', gracefulShutdown('SIGINT', db, app));
}

function gracefulShutdown(signal: string, db: { close: () => void }, app: { close: () => Promise<void> }) {
  return async () => {
    logger.info({ signal }, 'shutting down gracefully');
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
