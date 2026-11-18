import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { FIELDS_NEWER_THAN_PROD_BOT, findFieldsNewerThanProdBot } from '../scripts/lib/catalog-compat.js';

// A strict schema means an older bot rejects the WHOLE feed when it meets a field it does not
// know, and then answers price/date/booking messages with the "data unavailable" fallback.
// dynamic:push uses this list to refuse such a prod publish until the new bot is deployed.
// Only the CI fixture is committed (prod/dev catalogs are gitignored); dynamic:push checks those.
const FIXTURE = 'scripts/bot-dynamic.ci.json';
const SAMPLE: Record<string, unknown> = { sharedFacts: { tripLength: 'x' }, quoteValue: 'x' };

type Catalog = { experiences: Record<string, Record<string, unknown> & { sites: Record<string, Record<string, unknown>> }> };

function read(file: string): Catalog {
  return JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
}

function withField(field: string, level: 'experience' | 'site'): Catalog {
  const catalog = read(FIXTURE);
  for (const experience of Object.values(catalog.experiences)) {
    if (level === 'experience') experience[field] = SAMPLE[field];
    else for (const site of Object.values(experience.sites)) site[field] = SAMPLE[field];
  }
  return catalog;
}

describe('catalog fields newer than the production bot', () => {
  it('the committed fixture carries none yet, so the current bot still loads it', () => {
    expect(findFieldsNewerThanProdBot(read(FIXTURE))).toEqual([]);
  });

  it.each(FIELDS_NEWER_THAN_PROD_BOT)('flags $field at $level level and names its path', ({ field, level }) => {
    const found = findFieldsNewerThanProdBot(withField(field, level));
    expect(found.length).toBeGreaterThan(0);
    for (const path of found) expect(path).toMatch(new RegExp(`^experiences\\.[^.]+${level === 'site' ? '\\.sites\\.[^.]+' : ''}\\.${field} \\(needs `));
  });

  it.each(FIELDS_NEWER_THAN_PROD_BOT)('$field is accepted by this code, so the new bot reads what the guard holds back', ({ field, level }) => {
    expect(dynamicDataSchema.safeParse(withField(field, level)).success).toBe(true);
  });

  it('tolerates a malformed catalog instead of throwing', () => {
    expect(findFieldsNewerThanProdBot(null)).toEqual([]);
    expect(findFieldsNewerThanProdBot({})).toEqual([]);
  });
});
