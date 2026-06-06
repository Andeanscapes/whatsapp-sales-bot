import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { env } from '../config/env.js';
import { createAndMigrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';

function maskPhone(phone: string): string {
  if (phone.length <= 6) return phone;
  return `${phone.slice(0, 3)}***${phone.slice(-3)}`;
}

function main(): void {
  const outputDir = process.argv[2] ?? 'exports';
  const db = createAndMigrate(env.SQLITE_PATH);
  const repos = createRepositories(db);

  const lines = repos.transcripts.getAllTranscripts().map(record =>
    JSON.stringify({
      customer: maskPhone(record.customerPhone),
      language: record.language,
      first_seen_at: record.firstSeenAt,
      last_seen_at: record.lastSeenAt,
      lead_score: record.leadScore,
      mode: record.mode,
      handed_off: record.handedOff,
      converted: record.converted,
      collected: record.collected,
      ai_usage: record.aiUsage,
      turns: record.turns,
    })
  );

  db.close();
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = join(outputDir, `transcripts-${stamp}.jsonl`);
  writeFileSync(outputPath, `${lines.join('\n')}\n`);
  console.log(`exported=${lines.length} path=${outputPath}`);
}

main();
