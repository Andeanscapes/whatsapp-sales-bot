import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createAndMigrate } from './db/migrate.js';
import { loadSkills } from './services/skill-loader.js';
import { logger } from './config/logger.js';

async function start() {
  loadSkills();
  const db = createAndMigrate(env.SQLITE_PATH);

  const app = await buildApp(db);

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT }, 'server started');

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
