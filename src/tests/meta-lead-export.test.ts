import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { metaAudienceCsv, toMetaAudienceRow, writeMetaAudienceExport } from '../services/meta-audience-export.js';

describe('Meta audience lead export', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('exports consented active unbooked leads and excludes missing consent, opt-outs, and booked customers', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    repos.conversation.upsert('573001112233', { collected_name: 'Ana Maria' });
    repos.conversation.upsert('573001112234', { collected_name: 'Luis' });
    repos.conversation.upsert('14155551234', { collected_name: 'Taylor Swift' });
    repos.conversation.upsert('573001112235', { collected_name: 'Booked Person' });
    repos.conversation.upsert('573001112236', { collected_name: 'No Consent' });
    repos.conversation.recordMetaAudienceConsent('573001112233', 'whatsapp_explicit_opt_in', '2026-07-29T10:00:00.000Z');
    repos.conversation.recordMetaAudienceConsent('573001112234', 'whatsapp_explicit_opt_in');
    repos.conversation.recordMetaAudienceConsent('14155551234', 'booking_checkout_opt_in');
    repos.conversation.recordMetaAudienceConsent('573001112235', 'documented_lawful_basis');
    repos.optOut.setOptOut('573001112234');
    repos.conversation.setBooked('573001112235');

    const { csv, skipped } = metaAudienceCsv(repos.conversation.listMetaAudienceLeads());

    expect(csv).toBe([
      'phone,fn,ln,country',
      '"14155551234","Taylor","Swift",""',
      '"573001112233","Ana","Maria","CO"',
      '',
    ].join('\n'));
    expect(csv).not.toContain('573001112235');
    expect(csv).not.toContain('573001112234');
    expect(csv).not.toContain('573001112236');
    expect(repos.conversation.getByPhone('573001112233')).toMatchObject({
      meta_audience_consent_at: '2026-07-29T10:00:00.000Z',
      meta_audience_consent_source: 'whatsapp_explicit_opt_in',
    });
    expect(skipped).toBe(0);
    db.close();
  });

  it('escapes names and skips invalid or duplicate phones', () => {
    const { csv, skipped } = metaAudienceCsv([
      { customerPhone: '+57 300 111 2233', collectedName: 'Ana "Majo"' },
      { customerPhone: '573001112233', collectedName: 'Duplicate' },
      { customerPhone: '123', collectedName: 'Invalid' },
    ]);

    expect(csv).toContain('"573001112233","Ana","""Majo""","CO"');
    expect(skipped).toBe(2);
  });

  it('neutralizes CSV formulas in names without changing safe names or phones', () => {
    const { csv } = metaAudienceCsv([
      { customerPhone: '+57 300 111 2233', collectedName: '=HYPERLINK("bad") Safe' },
      { customerPhone: '+57 300 111 2234', collectedName: 'Ana @payload' },
    ]);

    expect(csv).toContain('"573001112233","\'=HYPERLINK(""bad"")","Safe","CO"');
    expect(csv).toContain('"573001112234","Ana","\'@payload","CO"');
  });

  it('writes export with private permissions', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'meta-audience-export-'));
    const outputDir = join(tempRoot, 'exports');
    const output = writeMetaAudienceExport(outputDir, 'phone,fn,ln,country\n', new Date('2026-07-29T12:00:00.000Z'));

    expect(statSync(outputDir).mode & 0o777).toBe(0o700);
    expect(statSync(output).mode & 0o777).toBe(0o600);
  });

  it('normalizes country and names without inventing missing fields', () => {
    expect(toMetaAudienceRow({ customerPhone: '+57 300 111 2233', collectedName: null }))
      .toEqual({ phone: '573001112233', fn: '', ln: '', country: 'CO' });
    expect(toMetaAudienceRow({ customerPhone: '123', collectedName: 'Invalid' })).toBeNull();
  });
});
