import Fastify from 'fastify';
import type { Repositories } from './db/repositories/index.js';
import { env } from './config/env.js';
import { healthRoutes } from './routes/health.route.js';
import { whatsappWebhookRoutes } from './routes/whatsapp-webhook.route.js';

export async function buildApp(repos: Repositories) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
  });

  await app.register(healthRoutes, { repos });
  await app.register(whatsappWebhookRoutes, { repos });

  app.get('/', async () => ({ ok: true }));

  return app;
}
