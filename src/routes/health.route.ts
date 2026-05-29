import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

export async function healthRoutes(app: FastifyInstance, opts: { db: Database.Database }): Promise<void> {
  const db = opts.db;

  app.get('/health', async () => {
    let dbStatus = 'error';
    try {
      db.prepare('SELECT 1').get();
      dbStatus = 'ok';
    } catch {
      dbStatus = 'error';
    }

    return {
      ok: true,
      uptime: process.uptime(),
      db: dbStatus,
    };
  });
}
