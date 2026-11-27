import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { FIELDS_NEWER_THAN_PROD_BOT, findFieldsNewerThanProdBot } from '../scripts/lib/catalog-compat.js';

// A strict schema means an older bot rejects the WHOLE feed when it meets a field it does not
// know, and then answers price/date/booking messages with the "data unavailable" fallback.
// dynamic:push uses this list to refuse such a prod publish until the new bot is deployed.
// Only the CI fixture is committed (prod/dev catalogs are gitignored); dynamic:push checks those.
const FIXTURE = 'scripts/bot-dynamic.ci.json';
const SAMPLE_LINK = [{ url: 'https://www.instagram.com/reel/ABC123/', description: 'x' }];
const SAMPLE: Record<string, unknown> = { sharedFacts: { tripLength: 'x' }, quoteValue: 'x', cultureReels: SAMPLE_LINK, reels: SAMPLE_LINK };

type Node = Record<string, unknown>;
type Catalog = { experiences: Record<string, Node & { sites: Record<string, Node & { plans: Record<string, Node> }> }> };

function read(file: string): Catalog {
  return JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
}

function withField(field: string, level: 'experience' | 'site' | 'plan'): Catalog {
  const catalog = read(FIXTURE);
  for (const experience of Object.values(catalog.experiences)) {
    if (level === 'experience') experience[field] = SAMPLE[field];
    else for (const site of Object.values(experience.sites)) {
      if (level === 'site') site[field] = SAMPLE[field];
      else for (const plan of Object.values(site.plans)) plan[field] = SAMPLE[field];
    }
  }
  return catalog;
}

const LEVEL_PATH = { experience: '', site: '\\.sites\\.[^.]+', plan: '\\.sites\\.[^.]+\\.plans\\.[^.]+' } as const;

describe('catalog fields newer than the production bot', () => {
  // The fixture mirrors the approved video links (tests and the live eval read them); the
  // shared-facts fields stay out so the 2.5.1 fallback wording keeps its coverage.
  it('the committed fixture carries only the video-link fields, and this code loads it', () => {
    const found = findFieldsNewerThanProdBot(read(FIXTURE));
    for (const path of found) expect(path).toMatch(/\.(?:cultureReels|reels|pricing\.calculation=couple_half_from_three|pricing\.maxQuotedPeople) \(needs /);
    expect(dynamicDataSchema.safeParse(read(FIXTURE)).success).toBe(true);
  });

  it.each(FIELDS_NEWER_THAN_PROD_BOT)('flags $field at $level level and names its path', ({ field, level }) => {
    // The fixture already carries the video links, so only this field's paths are checked.
    const found = findFieldsNewerThanProdBot(withField(field, level)).filter(path => path.includes(`.${field} (needs `));
    expect(found.length).toBeGreaterThan(0);
    for (const path of found) expect(path).toMatch(new RegExp(`^experiences\\.[^.]+${LEVEL_PATH[level]}\\.${field} \\(needs `));
  });

  it.each(FIELDS_NEWER_THAN_PROD_BOT)('$field is accepted by this code, so the new bot reads what the guard holds back', ({ field, level }) => {
    expect(dynamicDataSchema.safeParse(withField(field, level)).success).toBe(true);
  });

  // A new enum value is as fatal to an older bot as a new key: 2.6.0 rejects the whole feed.
  it('flags the 3+ group calculation value and the quote cap inside plan pricing, never the older values', () => {
    const catalog = read(FIXTURE);
    const paths = findFieldsNewerThanProdBot(catalog);
    expect(paths.some(path => /\.plans\.prime_2d1n_chivor\.pricing\.calculation=couple_half_from_three \(needs /.test(path))).toBe(true);
    expect(paths.some(path => /\.plans\.prime_2d1n_chivor\.pricing\.maxQuotedPeople \(needs /.test(path))).toBe(true);
    for (const experience of Object.values(catalog.experiences)) {
      for (const site of Object.values(experience.sites)) {
        for (const plan of Object.values(site.plans)) {
          const pricing = plan.pricing as Record<string, unknown> | undefined;
          if (!pricing) continue;
          pricing.calculation = 'couple_half_from_five';
          delete pricing.maxQuotedPeople;
        }
      }
    }
    expect(findFieldsNewerThanProdBot(catalog).filter(path => path.includes('.pricing.'))).toEqual([]);
    expect(dynamicDataSchema.safeParse(catalog).success).toBe(true);
  });

  it('tolerates a malformed catalog instead of throwing', () => {
    expect(findFieldsNewerThanProdBot(null)).toEqual([]);
    expect(findFieldsNewerThanProdBot({})).toEqual([]);
  });
});
