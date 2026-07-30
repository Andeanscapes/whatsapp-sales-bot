import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { MetaAudienceLead } from '../db/repositories/types.js';

const HEADER = 'phone,fn,ln,country';

export interface MetaAudienceRow {
  phone: string;
  fn: string;
  ln: string;
  country: string;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function safeNameCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function cleanName(value: string | null): string[] {
  return (value ?? '')
    .split('')
    .filter(char => char >= ' ' && char !== '\x7F')
    .join('')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function toMetaAudienceRow(lead: MetaAudienceLead): MetaAudienceRow | null {
  const phone = lead.customerPhone.replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) return null;
  const name = cleanName(lead.collectedName);
  return {
    phone,
    fn: safeNameCell(name[0] ?? ''),
    ln: safeNameCell(name.slice(1).join(' ')),
    country: phone.startsWith('57') ? 'CO' : '',
  };
}

export function metaAudienceCsv(leads: readonly MetaAudienceLead[]): { csv: string; skipped: number } {
  const seen = new Set<string>();
  let skipped = 0;
  const rows = leads.flatMap(lead => {
    const row = toMetaAudienceRow(lead);
    if (!row || seen.has(row.phone)) {
      skipped++;
      return [];
    }
    seen.add(row.phone);
    return [row];
  });
  const body = rows.map(row => [row.phone, row.fn, row.ln, row.country].map(csvCell).join(','));
  return { csv: `${HEADER}\n${body.join('\n')}\n`, skipped };
}

export function writeMetaAudienceExport(outputDir: string, csv: string, now = new Date()): string {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  chmodSync(outputDir, 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outputPath = join(outputDir, `meta-audience-leads-${stamp}.csv`);
  writeFileSync(outputPath, csv, { encoding: 'utf8', mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return outputPath;
}
