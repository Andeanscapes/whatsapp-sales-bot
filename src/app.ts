import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { FastifyError } from 'fastify';
import type { Repositories } from './db/repositories/index.js';
import { logger } from './config/logger.js';
import { healthRoutes } from './routes/health.route.js';
import { whatsappWebhookRoutes } from './routes/whatsapp-webhook.route.js';
import { logSystemError } from './services/error-logger.js';

export async function buildApp(repos: Repositories) {
  const app = Fastify({
    bodyLimit: 512 * 1024,
    loggerInstance: logger,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  app.setErrorHandler(async (error, request, reply) => {
    const err = error as FastifyError;
    const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    logSystemError('fastify_error', 'error', err, {
      method: request.method,
      url: request.url,
      statusCode,
    });
    if (!reply.sent) {
      return reply.code(statusCode).send({ error: statusCode === 500 ? 'Internal server error' : err.message });
    }
  });

  await app.register(healthRoutes, { repos });
  await app.register(whatsappWebhookRoutes, { repos });

  app.get('/', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => ({ ok: true }));

  return app;
}
