import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createAndMigrate } from './db/migrate.js';
import { loadSkills } from './services/skill-loader.js';

async function start() {
  loadSkills();
  const db = createAndMigrate(env.SQLITE_PATH);

  const app = await buildApp(db);

  await app.listen({ host: env.HOST, port: env.PORT });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
