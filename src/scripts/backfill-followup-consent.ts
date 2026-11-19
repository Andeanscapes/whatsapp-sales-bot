/**
 * Recovers lost consent "yes" answers (see `followup-consent-backfill.ts`).
 *
 *   node dist/scripts/backfill-followup-consent.js           # dry run, changes nothing
 *   node dist/scripts/backfill-followup-consent.js --apply   # re-activates the listed rows
 *   ... --apply --skip=1234,5678                              # leave these (last 4 digits) out
 *
 * Sends nothing. The running bot's scheduler sends the templates on its next ticks,
 * inside the Bogota template window, through every normal guard.
 * Output shows only the last 4 phone digits.
 */
import { pathToFileURL } from 'url';
import { env } from '../config/env.js';
import { createAndMigrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { applyMissedConsents, findMissedConsents } from '../services/followup-consent-backfill.js';

function main(): void {
  const apply = process.argv.includes('--apply');
  const skipArg = process.argv.find(arg => arg.startsWith('--skip='));
  const skipLast4 = new Set((skipArg?.slice('--skip='.length) ?? '').split(',').map(v => v.trim()).filter(Boolean));
  const db = createAndMigrate(env.SQLITE_PATH);
  const repos = createRepositories(db);

  const missed = findMissedConsents(repos).filter(row => !skipLast4.has(row.phone.slice(-4)));
  for (const row of missed) {
    console.log([
      `...${row.phone.slice(-4)}`,
      `ask=${row.askAt.slice(0, 10)}`,
      `yes=${row.replyAt.slice(0, 10)}`,
      `lang=${row.language ?? '?'}`,
      `status=${row.currentStatus}`,
      row.action,
    ].join(' | '));
  }
  const byAction = new Map<string, number>();
  for (const row of missed) byAction.set(row.action, (byAction.get(row.action) ?? 0) + 1);
  const summary = [...byAction].map(([action, count]) => `${action}: ${count}`).join(' · ');
  console.log(`[FOLLOWUP-BACKFILL] lost yes: ${missed.length}${summary ? ` · ${summary}` : ''}`);

  if (apply) {
    const applied = applyMissedConsents(repos, missed, env.APP_VERSION);
    console.log(`[FOLLOWUP-BACKFILL] reactivated: ${applied}`);
  } else {
    console.log('[FOLLOWUP-BACKFILL] dry run — nothing changed. Re-run with --apply.');
  }
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
