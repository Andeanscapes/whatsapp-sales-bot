import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { env } from './config/env.js';
import { healthRoutes } from './routes/health.route.js';
import { whatsappWebhookRoutes } from './routes/whatsapp-webhook.route.js';

export async function buildApp(db: Database.Database) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
  });

  

  await app.register(healthRoutes);
  await app.register(whatsappWebhookRoutes, { db });

  app.get('/', async () => ({ ok: true }));

  return app;
}
