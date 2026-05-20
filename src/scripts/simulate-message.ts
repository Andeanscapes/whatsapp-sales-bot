import { createAndMigrate } from '../db/migrate.js';
import { loadSkills } from '../services/skill-loader.js';
import { processMessage } from '../services/response-engine.js';
import { addMessage } from '../services/conversation-store.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

loadSkills();

const messageIndex = process.argv.findIndex(a => a === '--message');
const message = messageIndex !== -1 ? process.argv[messageIndex + 1] : process.argv[2];

if (!message) {
  console.error('Usage: npm run simulate -- "your message"');
  process.exit(1);
}

const tmpDir = mkdtempSync(join(tmpdir(), 'andean-bot-'));
const dbPath = join(tmpDir, 'sim.sqlite');
const db = createAndMigrate(dbPath);

const result = await processMessage({
  db,
  customerPhone: '573000000001',
  message,
  messageId: `sim_${Date.now()}`,
});

console.log(`reply=${result.reply}`);
console.log(`lead_score=${result.leadScore}`);
console.log(`used_ai=${result.usedAi}`);
console.log(`should_alert_owner=${result.shouldAlertOwner}`);
console.log(`should_send_image=${result.shouldSendImage}`);

if (result.shouldSendReply) {
  addMessage(db, {
    customer_phone: '573000000001',
    direction: 'outbound',
    message_type: 'text',
    body: result.reply,
    created_at: new Date().toISOString(),
  });
}

db.close();
