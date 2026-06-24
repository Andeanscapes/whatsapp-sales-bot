import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';

export async function healthRoutes(app: FastifyInstance, opts: { repos: Repositories }): Promise<void> {
  const repos = opts.repos;

  app.get('/health', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => ({
    ok: true,
    uptime: process.uptime(),
    db: repos.ping() ? 'ok' : 'error',
  }));
}
