/**
 * Offline / AI simulate helper.
 *
 * Single turn (temp DB):
 *   npm run simulate -- "Hola"
 *
 * Multi-turn AI (reuse same db + phone):
 *   AI_ENABLED=true npx tsx src/scripts/simulate-message.ts --db /tmp/andean-sim.sqlite --phone 57300999 "msg1"
 *   AI_ENABLED=true npx tsx src/scripts/simulate-message.ts --db /tmp/andean-sim.sqlite --phone 57300999 "msg2"
 */
import { createAndMigrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';
import { processMessage } from '../services/response-engine.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

loadSkills();

const VALUE_FLAGS = new Set(['--message', '--phone', '--db']);

function readArg(flag: string): string | undefined {
  const idx = process.argv.findIndex(a => a === flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function readPositionalMessage(): string | undefined {
  const positional: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    positional.push(arg);
  }
  return positional.at(-1);
}

const message = readArg('--message') ?? readPositionalMessage();
const phone = readArg('--phone') ?? '573000000001';
const dbArg = readArg('--db');

if (!message) {
  console.error('Usage: npm run simulate -- "your message"');
  console.error('       npx tsx src/scripts/simulate-message.ts --db /tmp/sim.sqlite --phone 57300… "msg"');
  process.exit(1);
}

const dbPath = dbArg ?? join(mkdtempSync(join(tmpdir(), 'andean-bot-')), 'sim.sqlite');
const db = createAndMigrate(dbPath);
const repos = createRepositories(db);

const result = await processMessage({
  repos,
  customerPhone: phone,
  message,
  messageId: `sim_${Date.now()}`,
});

console.log(`reply=${result.reply}`);
console.log(`lead_score=${result.leadScore}`);
console.log(`used_ai=${result.usedAi}`);
console.log(`should_alert_owner=${result.shouldAlertOwner}`);
console.log(`should_send_image=${result.shouldSendImage}`);
console.log(`price_just_given=${result.priceJustGiven}`);
if (dbArg) console.log(`db=${dbPath}`);
console.log(`phone=${phone}`);

if (result.shouldSendReply) {
  repos.message.addMessage({
    customer_phone: phone,
    direction: 'outbound',
    message_type: 'text',
    body: result.reply,
    created_at: new Date().toISOString(),
  });
}

db.close();
