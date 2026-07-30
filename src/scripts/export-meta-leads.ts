import { pathToFileURL } from 'url';
import { env } from '../config/env.js';
import { createAndMigrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { metaAudienceCsv, writeMetaAudienceExport } from '../services/meta-audience-export.js';

function main(): void {
  const outputDir = process.argv[2] ?? 'exports/meta';
  const db = createAndMigrate(env.SQLITE_PATH);
  const { csv, skipped } = metaAudienceCsv(createRepositories(db).conversation.listMetaAudienceLeads());
  db.close();
  const outputPath = writeMetaAudienceExport(outputDir, csv);
  const exported = Math.max(0, csv.trimEnd().split('\n').length - 1);
  console.log(`exported=${exported} skipped=${skipped} path=${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
