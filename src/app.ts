import Fastify from 'fastify';
import type { Repositories } from './db/repositories/index.js';
import { logger } from './config/logger.js';
import { healthRoutes } from './routes/health.route.js';
import { whatsappWebhookRoutes } from './routes/whatsapp-webhook.route.js';
import { logSystemError } from './services/error-logger.js';

export async function buildApp(repos: Repositories) {
  const app = Fastify({
    loggerInstance: logger,
  });

  app.setErrorHandler(async (error, request, reply) => {
    const err = error as Error;
    logSystemError('fastify_error', 'error', err, {
      method: request.method,
      url: request.url,
    });
    if (!reply.sent) {
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  await app.register(healthRoutes, { repos });
  await app.register(whatsappWebhookRoutes, { repos });

  app.get('/', async () => ({ ok: true }));

  return app;
}
