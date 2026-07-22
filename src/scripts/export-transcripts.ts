import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { env } from '../config/env.js';
import { createAndMigrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';

function maskPhone(phone: string): string {
  if (phone.length <= 6) return phone;
  return `${phone.slice(0, 3)}***${phone.slice(-3)}`;
}

export function writeTranscriptExport(outputDir: string, lines: readonly string[], now = new Date()): string {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  chmodSync(outputDir, 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outputPath = join(outputDir, `transcripts-${stamp}.jsonl`);
  writeFileSync(outputPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return outputPath;
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
  const outputPath = writeTranscriptExport(outputDir, lines);
  console.log(`exported=${lines.length} path=${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
