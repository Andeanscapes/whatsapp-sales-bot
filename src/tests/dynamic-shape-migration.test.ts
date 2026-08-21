import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { assertDynamicCatalogReady, dynamicDataSchema, DEFAULT_SITE_ID } from '../services/dynamic-data-schema.js';
import { DynamicDataService, transformDynamicData, type InternalDynamicData } from '../services/dynamic-data-service.js';
import { renderCatalog, renderBusinessData, assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import { loadSkills, setDynamicService, refreshSkills, getSkills } from '../services/skill-loader.js';
import { getActiveExperience, getFutureAvailableDatesForPlan } from '../services/product-registry.js';

/**
 * Guards the site-hierarchy migration. Three input shapes must all keep parsing and
 * must all normalize to the same internal "sites" data — if any branch breaks, the
 * bot silently loses pricing (PRICING_NOT_AVAILABLE) for whichever payload shape the
 * CDN happens to be serving that day.
 */

const AVAILABILITY = { tz: 'America/Bogota', dates: [], rule: 'Team validates availability.' };

/** Legacy: pricing.plans + addon-scoped plans. Mirrors the published CDN payload. */
const legacyPayload = {
  v: 6,
  updated: '2026-07-26T00:00:00Z',
  experiences: {
    emerald_mining_tour: {
      clarifications: {
        experience: ['Real emerald mines, not coal.'],
        plans: { '2d1n_mining': ['Plan-level note.'] },
      },
      pricing: {
        currency: 'COP',
        plans: {
          '2d1n_mining': { individual: 550000, couple: 1000000 },
          '3d2n_rural': { individual: 750000, couple: 1400000 },
        },
        addons: {
          apiary_cattle: { label: 'Apicultura', pp: 55000, plans: ['2d1n_mining'] },
          horseback_riding: { label: 'Cabalgata', pp: 120000, plans: ['2d1n_mining', '3d2n_rural'] },
          private_transport: { label: 'Transporte privado', price: 1700000, max: 4 },
        },
        rules: ['Rule one.'],
      },
      availability: AVAILABILITY,
    },
  },
};

/** v9 unified: plans own pricing/clarifications/addon eligibility. Same facts, no sites. */
const unifiedPayload = {
  v: 9,
  updated: '2026-07-26T00:00:00Z',
  experiences: {
    emerald_mining_tour: {
      clarifications: ['Real emerald mines, not coal.'],
      plans: {
        '2d1n_mining': {
          pricing: { individual: 550000, couple: 1000000 },
          clarifications: ['Plan-level note.'],
          addons: ['apiary_cattle', 'horseback_riding'],
        },
        '3d2n_rural': {
          pricing: { individual: 750000, couple: 1400000 },
          clarifications: [],
          addons: ['horseback_riding'],
        },
      },
      pricing: {
        currency: 'COP',
        addons: {
          apiary_cattle: { label: 'Apicultura', pp: 55000 },
          horseback_riding: { label: 'Cabalgata', pp: 120000 },
          private_transport: { label: 'Transporte privado', price: 1700000, max: 4 },
        },
        rules: ['Rule one.'],
      },
      availability: AVAILABILITY,
    },
  },
};

/** v10 sites-native: same facts again, this time authored directly under `sites.chivor`. */
const sitesPayload = {
  v: 10,
  updated: '2026-07-26T00:00:00Z',
  experiences: {
    emerald_mining_tour: {
      clarifications: ['Real emerald mines, not coal.'],
      sites: {
        [DEFAULT_SITE_ID]: {
          clarifications: [],
          addons: {
            apiary_cattle: { label: 'Apicultura', pp: 55000 },
            horseback_riding: { label: 'Cabalgata', pp: 120000 },
            private_transport: { label: 'Transporte privado', price: 1700000, max: 4 },
          },
          rules: ['Rule one.'],
          media: { gallery: [] },
          availability: AVAILABILITY,
          plans: {
            '2d1n_mining': {
              pricing: { individual: 550000, couple: 1000000 },
              clarifications: ['Plan-level note.'],
              addons: ['apiary_cattle', 'horseback_riding'],
              media: { planImages: [] },
            },
            '3d2n_rural': {
              pricing: { individual: 750000, couple: 1400000 },
              clarifications: [],
              addons: ['horseback_riding'],
              media: { planImages: [] },
            },
          },
        },
      },
    },
  },
};

const completeSitesPayload = {
  ...sitesPayload,
  v: 11,
  experiences: {
    emerald_mining_tour: {
      ...sitesPayload.experiences.emerald_mining_tour,
      name: 'Emerald Mining Tour',
      sites: {
        [DEFAULT_SITE_ID]: {
          ...sitesPayload.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID],
          shortDescription: 'Real emerald mining experience.',
          plans: {
            '2d1n_mining': {
              ...sitesPayload.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID].plans['2d1n_mining'],
              name: 'Mining plan',
              duration: '2D/1N',
              shortDescription: 'Two-day mining experience.',
            },
            '3d2n_rural': {
              ...sitesPayload.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID].plans['3d2n_rural'],
              name: 'Rural plan',
              duration: '3D/2N',
              shortDescription: 'Three-day rural experience.',
            },
          },
        },
      },
    },
  },
};

/** Campaign segments live on the site, so a second destination can run its own ads. */
const segmentsPayload = {
  ...completeSitesPayload,
  experiences: {
    emerald_mining_tour: {
      ...completeSitesPayload.experiences.emerald_mining_tour,
      sites: {
        [DEFAULT_SITE_ID]: {
          ...completeSitesPayload.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID],
          entrySegments: {
            C01: {
              label: 'General Adventure',
              description: 'Generic adventure lead.',
              valueHook: 'Generic hook copy.',
              diagnosisQuestion: 'Generic diagnosis question?',
              planMatch: 'Per diagnosis.',
            },
            C02: {
              label: 'Off-Road',
              description: 'Off-road ad lead.',
              valueHook: 'Off-road hook copy.',
              diagnosisQuestion: 'Off-road diagnosis question?',
              planMatch: 'Off-road plan guidance.',
            },
            H01: {
              label: 'Hot Lead',
              description: 'Warm lead, skips the brand pitch.',
              valueHook: '',
              diagnosisQuestion: 'Hot diagnosis question?',
              planMatch: 'Per diagnosis.',
            },
          },
        },
      },
    },
  },
};

async function loadInternal(payload: unknown): Promise<InternalDynamicData> {
  return transformDynamicData(dynamicDataSchema.parse(payload));
}

/** Two sites, same addon id, deliberately different prices — the reason sites exist. */
const twoSitesPayload = {
  v: 10,
  updated: '2026-08-07T00:00:00Z',
  experiences: {
    emerald_mining_tour: {
      name: 'Emerald Mining Tour',
      clarifications: [],
      sites: {
        chivor: {
          name: 'Chivor',
          location: 'Chivor, Boyacá',
          shortDescription: 'Aventura minera en Chivor.',
          route: { localAccess: 'Ruta exclusiva de Chivor.', botRules: [] },
          clarifications: [],
          addons: { horseback_riding: { label: 'Cabalgata Chivor', pp: 120000 } },
          rules: [],
          media: { gallery: [] },
          availability: AVAILABILITY,
          plans: {
            '2d1n_mining': {
              name: 'Plan Chivor',
              duration: '2D/1N',
              shortDescription: 'Mining in Chivor.',
              pricing: { individual: 550000, couple: 1000000 },
              clarifications: [],
              addons: ['horseback_riding'],
              media: { planImages: [] },
            },
          },
        },
        coscuez: {
          name: 'Coscuez',
          location: 'Coscuez, Boyacá',
          shortDescription: 'Aventura minera en Coscuez.',
          route: { localAccess: 'Ruta exclusiva de Coscuez.', botRules: [] },
          clarifications: [],
          addons: { horseback_riding: { label: 'Cabalgata Coscuez', pp: 90000 } },
          rules: [],
          media: { gallery: [] },
          availability: AVAILABILITY,
          plans: {
            '2d1n_gems': {
              name: 'Plan Coscuez',
              duration: '2D/1N',
              shortDescription: 'Mining in Coscuez.',
              pricing: { individual: 480000, couple: 900000 },
              clarifications: [],
              addons: ['horseback_riding'],
              media: { planImages: [] },
            },
          },
        },
      },
    },
  },
};

describe('dynamic payload shape migration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('all three shapes parse', () => {
    it('accepts the legacy shape (published CDN payload)', () => {
      expect(() => dynamicDataSchema.parse(legacyPayload)).not.toThrow();
    });

    it('accepts the v9 unified shape', () => {
      expect(() => dynamicDataSchema.parse(unifiedPayload)).not.toThrow();
    });

    it('accepts the v10 sites-native shape', () => {
      expect(() => dynamicDataSchema.parse(sitesPayload)).not.toThrow();
    });

    it('accepts optional v11 narrative on sites-native without requiring it on legacy/unified', () => {
      const withNarrative = {
        ...sitesPayload,
        experiences: {
          emerald_mining_tour: {
            ...sitesPayload.experiences.emerald_mining_tour,
            name: 'Emerald Mining Tour',
            shortDescription: '2D/1N real mine adventure',
            mineDetails: { type: 'real emerald mines', multipleMines: true, notes: 'No specific mine guaranteed.' },
            sites: {
              chivor: {
                ...sitesPayload.experiences.emerald_mining_tour.sites.chivor,
                name: 'Chivor',
                location: 'Boyacá',
                plans: {
                  '2d1n_mining': {
                    ...sitesPayload.experiences.emerald_mining_tour.sites.chivor.plans['2d1n_mining'],
                    name: '2D/1N Mining',
                    duration: '2D/1N',
                    keywords: ['mina', 'esmeralda'],
                    status: 'active' as const,
                  },
                  '3d2n_rural': sitesPayload.experiences.emerald_mining_tour.sites.chivor.plans['3d2n_rural'],
                },
              },
            },
          },
        },
      };
      const parsed = dynamicDataSchema.parse(withNarrative).experiences.emerald_mining_tour;
      expect(parsed.name).toBe('Emerald Mining Tour');
      expect(parsed.mineDetails?.notes).toBe('No specific mine guaranteed.');
      expect(parsed.sites.chivor.name).toBe('Chivor');
      expect(parsed.sites.chivor.plans['2d1n_mining'].keywords).toEqual(['mina', 'esmeralda']);
      // legacy remains valid without narrative
      expect(() => dynamicDataSchema.parse(legacyPayload)).not.toThrow();
      expect(dynamicDataSchema.parse(legacyPayload).experiences.emerald_mining_tour.name).toBeUndefined();
    });

    it('rejects pricing-only payloads at the runtime catalog boundary', () => {
      expect(() => assertDynamicCatalogReady(dynamicDataSchema.parse(legacyPayload)))
        .toThrow(/Dynamic catalog is incomplete/);
      expect(() => assertDynamicCatalogReady(dynamicDataSchema.parse(completeSitesPayload))).not.toThrow();
    });

    it('parses site entry segments and defaults them to empty on feeds without any', () => {
      const withSegments = dynamicDataSchema.parse(segmentsPayload);
      const site = withSegments.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID];

      expect(Object.keys(site.entrySegments).sort()).toEqual(['C01', 'C02', 'H01']);
      expect(site.entrySegments.C02.valueHook).toBe('Off-road hook copy.');
      // A hot lead legitimately has no hook, so the field must not be required.
      expect(site.entrySegments.H01.valueHook).toBe('');

      const withoutSegments = dynamicDataSchema.parse(completeSitesPayload);
      expect(withoutSegments.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID].entrySegments).toEqual({});
      // Pre-sites feeds predate campaign segments entirely.
      expect(dynamicDataSchema.parse(unifiedPayload).experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID].entrySegments)
        .toEqual({});
    });

    it('rejects an unknown key inside an entry segment', () => {
      const typo = {
        ...segmentsPayload,
        experiences: {
          emerald_mining_tour: {
            ...segmentsPayload.experiences.emerald_mining_tour,
            sites: {
              [DEFAULT_SITE_ID]: {
                ...segmentsPayload.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID],
                entrySegments: { C01: { label: 'X', valueHok: 'typo' } },
              },
            },
          },
        },
      };
      expect(() => dynamicDataSchema.parse(typo)).toThrow(/valueHok/);
    });

    it.each([
      {
        name: 'invalid marker code',
        entrySegments: { X01: { label: 'X' } },
        error: /code must match/i,
      },
      {
        name: 'rendered placeholder',
        entrySegments: { R01: { valueHook: 'Venias mirando [PLAN].' } },
        error: /square-bracket placeholders/i,
      },
      {
        name: 'question inside a cold hook',
        entrySegments: { C01: { valueHook: 'Aventura real. ¿Vienen?' } },
        error: /cold entry segment valueHook/i,
      },
      {
        name: 'non-empty hot hook',
        entrySegments: { H02: { valueHook: 'Pitch de apertura.' } },
        error: /hot entry segment valueHook/i,
      },
      {
        name: 'multiple diagnosis questions',
        entrySegments: { C04: { diagnosisQuestion: '¿Traen niños? ¿Que edades?' } },
        error: /at most one question/i,
      },
      {
        name: 'empty contextual media mapping',
        entrySegments: { C01: { contextualMediaTypes: [] } },
        error: /at least 1 element/i,
      },
      {
        name: 'duplicate contextual media mapping',
        entrySegments: { C01: { contextualMediaTypes: ['mine', 'mine'] } },
        error: /must not contain duplicates/i,
      },
    ])('rejects $name', ({ entrySegments, error }) => {
      const invalid = {
        ...segmentsPayload,
        experiences: {
          emerald_mining_tour: {
            ...segmentsPayload.experiences.emerald_mining_tour,
            sites: {
              [DEFAULT_SITE_ID]: {
                ...segmentsPayload.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID],
                entrySegments,
              },
            },
          },
        },
      };

      expect(() => dynamicDataSchema.parse(invalid)).toThrow(error);
    });

    it('requires every contextual media type to have a typed gallery image', () => {
      const invalid = {
        ...segmentsPayload,
        experiences: {
          emerald_mining_tour: {
            ...segmentsPayload.experiences.emerald_mining_tour,
            sites: {
              [DEFAULT_SITE_ID]: {
                ...segmentsPayload.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID],
                media: { gallery: [], types: ['car'], typeKeywords: {} },
                entrySegments: { C02: { contextualMediaTypes: ['car'] } },
              },
            },
          },
        },
      };

      expect(() => dynamicDataSchema.parse(invalid)).toThrow(/must have at least one typed gallery image/i);
    });

    it('requires every contextual media type to have reply keywords', () => {
      const invalid = {
        ...segmentsPayload,
        experiences: {
          emerald_mining_tour: {
            ...segmentsPayload.experiences.emerald_mining_tour,
            sites: {
              [DEFAULT_SITE_ID]: {
                ...segmentsPayload.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID],
                media: {
                  gallery: [{ url: 'https://cdn.andeanscapes.com/car.jpg', caption: '', type: 'car' }],
                  types: ['car'],
                  typeKeywords: {},
                },
                entrySegments: { C02: { contextualMediaTypes: ['car'] } },
              },
            },
          },
        },
      };

      expect(() => dynamicDataSchema.parse(invalid)).toThrow(/must have at least one media\.typeKeywords entry/i);
    });

    it('rejects an active experience without an active plan', () => {
      const withoutPlans = {
        ...completeSitesPayload,
        experiences: {
          emerald_mining_tour: {
            ...completeSitesPayload.experiences.emerald_mining_tour,
            sites: {
              [DEFAULT_SITE_ID]: {
                ...completeSitesPayload.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID],
                plans: {},
              },
            },
          },
        },
      };
      expect(() => assertDynamicCatalogReady(dynamicDataSchema.parse(withoutPlans)))
        .toThrow(/activePlans/);
    });

    it('rejects an unbookable site even when another site has an active plan', () => {
      const withEmptySite = {
        ...completeSitesPayload,
        experiences: {
          emerald_mining_tour: {
            ...completeSitesPayload.experiences.emerald_mining_tour,
            sites: {
              ...completeSitesPayload.experiences.emerald_mining_tour.sites,
              empty_site: {
                clarifications: [],
                addons: {},
                rules: [],
                media: { gallery: [] },
                availability: AVAILABILITY,
                plans: {},
              },
            },
          },
        },
      };
      expect(() => assertDynamicCatalogReady(dynamicDataSchema.parse(withEmptySite)))
        .toThrow(/empty_site\.activePlans/);
    });

    it('keeps the last complete catalog when a later fetch is pricing-only', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => completeSitesPayload,
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => legacyPayload,
        } as unknown as Response);
      const service = new DynamicDataService('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', 5_000);

      await service.forceRefresh();
      const complete = service.getData();
      await service.forceRefresh();

      expect(complete).not.toBeNull();
      expect(service.getData()).toBe(complete);
      expect(service.lastFetchOk).toBe(false);
    });

    it('accepts a legacy addon carrying plans[] without dropping its price', () => {
      const parsed = dynamicDataSchema.parse(legacyPayload);
      const addons = parsed.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID].addons;
      expect(addons.apiary_cattle.pp).toBe(55000);
      expect(addons.private_transport.price).toBe(1700000);
      // the legacy-only scoping key is normalized away
      expect('plans' in addons.apiary_cattle).toBe(false);
    });
  });

  describe('normalization equivalence', () => {
    it('wraps legacy and v9 unified into the default site', () => {
      const parsed = dynamicDataSchema.parse(legacyPayload).experiences.emerald_mining_tour;
      const site = parsed.sites[DEFAULT_SITE_ID];
      expect(Object.keys(site.plans).sort()).toEqual(['2d1n_mining', '3d2n_rural']);
      expect(site.plans['2d1n_mining'].pricing).toEqual({ individual: 550000, couple: 1000000 });
      expect(parsed.clarifications).toEqual(['Real emerald mines, not coal.']);
      expect(site.plans['2d1n_mining'].clarifications).toEqual(['Plan-level note.']);
      expect(site.plans['3d2n_rural'].clarifications).toEqual([]);
    });

    it('inverts addon scoping onto the plans that list them', () => {
      const parsed = dynamicDataSchema.parse(legacyPayload).experiences.emerald_mining_tour;
      const site = parsed.sites[DEFAULT_SITE_ID];
      expect(site.plans['2d1n_mining'].addons).toEqual(['apiary_cattle', 'horseback_riding']);
      expect(site.plans['3d2n_rural'].addons).toEqual(['horseback_riding']);
    });

    it('produces identical internal data from all three shapes', async () => {
      const fromLegacy = await loadInternal(legacyPayload);
      vi.restoreAllMocks();
      const fromUnified = await loadInternal(unifiedPayload);
      vi.restoreAllMocks();
      const fromSites = await loadInternal(sitesPayload);

      expect(fromLegacy).toEqual(fromUnified);
      expect(fromUnified).toEqual(fromSites);
    });

    it('emits the same pricing items, each tagged with the site id, from all three shapes', async () => {
      const itemKeys = (data: InternalDynamicData) =>
        data.experiences.emerald_mining_tour.pricing.items
          .map(item => `${item.id}@${item.siteId}@${item.planId ?? 'unscoped'}`)
          .sort();

      const fromLegacy = itemKeys(await loadInternal(legacyPayload));
      vi.restoreAllMocks();
      const fromUnified = itemKeys(await loadInternal(unifiedPayload));
      vi.restoreAllMocks();
      const fromSites = itemKeys(await loadInternal(sitesPayload));

      expect(fromLegacy).toEqual(fromUnified);
      expect(fromUnified).toEqual(fromSites);
      // an addon scoped to no plan stays unscoped rather than vanishing
      expect(fromSites).toContain(`private_transport@${DEFAULT_SITE_ID}@unscoped`);
    });

    it('carries addon prices through the transform for all three shapes', async () => {
      const apiary = (data: InternalDynamicData) =>
        data.experiences.emerald_mining_tour.pricing.items
          .find(item => item.id === 'apiary_cattle' && item.planId === '2d1n_mining');

      expect(apiary(await loadInternal(legacyPayload))?.pricePerPerson).toBe(55000);
      vi.restoreAllMocks();
      expect(apiary(await loadInternal(unifiedPayload))?.pricePerPerson).toBe(55000);
      vi.restoreAllMocks();
      expect(apiary(await loadInternal(sitesPayload))?.pricePerPerson).toBe(55000);
    });

    it('exposes structured per-site data (clarifications, rules, availability)', async () => {
      const data = await loadInternal(sitesPayload);
      const site = data.experiences.emerald_mining_tour.sites[DEFAULT_SITE_ID];
      expect(site.id).toBe(DEFAULT_SITE_ID);
      expect(site.rules).toEqual(['Rule one.']);
      expect(site.availability.timezone).toBe('America/Bogota');
    });
  });

  describe('site isolation — the reason sites exist', () => {
    it('does not let one site\'s addon leak into another site with the same addon id', async () => {
      const data = await loadInternal(twoSitesPayload);
      const items = data.experiences.emerald_mining_tour.pricing.items;

      const chivorHorseback = items.find(i => i.id === 'horseback_riding' && i.siteId === 'chivor');
      const coscuezHorseback = items.find(i => i.id === 'horseback_riding' && i.siteId === 'coscuez');

      expect(chivorHorseback?.pricePerPerson).toBe(120000);
      expect(coscuezHorseback?.pricePerPerson).toBe(90000);
      expect(chivorHorseback?.planId).toBe('2d1n_mining');
      expect(coscuezHorseback?.planId).toBe('2d1n_gems');

      // Coscuez's plan never sees a Chivor-priced addon and vice versa.
      expect(items.filter(i => i.id === 'horseback_riding')).toHaveLength(2);
    });
  });

  describe('DATOS renders SITE blocks', () => {
    /** Loads a payload through skill-loader (not just DynamicDataService), so
     * renderBusinessData sees it via `skills.dynamicData` exactly as production does. */
    async function loadIntoSkills(payload: unknown) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => payload,
      } as unknown as Response);

      const svc = new DynamicDataService('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', 5_000);
      setDynamicService(svc);
      loadSkills();
      await refreshSkills(true);
      return getSkills();
    }

    it('groups plans/addons/rules/availability under SITE <id> with a single site', async () => {
      const skills = await loadIntoSkills(completeSitesPayload);
      const datos = renderBusinessData(skills);

      expect(datos).toContain(`SITE ${DEFAULT_SITE_ID}:`);
      expect(datos).toContain('PLANS_PRICES:');
      expect(datos).toContain('ADDONS:');
      expect(datos).toContain('apiary_cattle [plans: 2d1n_mining]');
      expect(datos).toContain('horseback_riding [plans: 2d1n_mining, 3d2n_rural]');
      expect(datos).toContain('private_transport [site-wide]');
      expect(datos).toContain('PRICING_RULES: Rule one.');
    });

    it('renders only the detected entry segment, never the whole map', async () => {
      const skills = await loadIntoSkills(segmentsPayload);
      const datos = renderBusinessData(skills, 'C02');

      expect(datos).toContain('ENTRY_SEGMENT C02 (Off-Road):');
      expect(datos).toContain('valueHook: Off-road hook copy.');
      expect(datos).toContain('diagnosisQuestion: Off-road diagnosis question?');
      expect(datos).toContain('planMatch: Off-road plan guidance.');
      // Cross-segment bleed is the failure mode this guards: a 4x4 lead must never
      // see the generic hook, and vice versa.
      expect(datos).not.toContain('Generic hook copy.');
      expect(datos).not.toContain('ENTRY_SEGMENT C01');
      expect(datos).not.toContain('ENTRY_SEGMENT H01');
      // Internal targeting metadata stays out of the prompt.
      expect(datos).not.toContain('Off-road ad lead.');
    });

    it('omits the entry segment block when there is no marker or no matching segment', async () => {
      const skills = await loadIntoSkills(segmentsPayload);

      expect(renderBusinessData(skills)).not.toContain('ENTRY_SEGMENT');
      expect(renderBusinessData(skills, 'R01')).not.toContain('ENTRY_SEGMENT');
    });

    it('omits an empty valueHook so a hot lead gets no brand pitch line', async () => {
      const skills = await loadIntoSkills(segmentsPayload);
      const datos = renderBusinessData(skills, 'H01');

      expect(datos).toContain('ENTRY_SEGMENT H01 (Hot Lead):');
      expect(datos).not.toContain('valueHook:');
      expect(datos).toContain('diagnosisQuestion: Hot diagnosis question?');
    });

    it('scopes entry segments to their own site when two sites run different campaigns', async () => {
      const skills = await loadIntoSkills({
        ...twoSitesPayload,
        experiences: {
          emerald_mining_tour: {
            ...twoSitesPayload.experiences.emerald_mining_tour,
            sites: {
              chivor: {
                ...twoSitesPayload.experiences.emerald_mining_tour.sites.chivor,
                entrySegments: { C02: { label: 'Chivor 4x4', valueHook: 'Chivor hook.' } },
              },
              coscuez: {
                ...twoSitesPayload.experiences.emerald_mining_tour.sites.coscuez,
                entrySegments: { C02: { label: 'Coscuez 4x4', valueHook: 'Coscuez hook.' } },
              },
            },
          },
        },
      });
      const datos = renderBusinessData(skills, 'C02');
      const chivorBlock = datos.slice(datos.indexOf('SITE chivor:'), datos.indexOf('SITE coscuez:'));
      const coscuezBlock = datos.slice(datos.indexOf('SITE coscuez:'));

      expect(chivorBlock).toContain('valueHook: Chivor hook.');
      expect(chivorBlock).not.toContain('Coscuez hook.');
      expect(coscuezBlock).toContain('valueHook: Coscuez hook.');
      expect(coscuezBlock).not.toContain('Chivor hook.');
    });

    it('points RUNTIME at the segment only when DATOS actually rendered it', async () => {
      const skills = await loadIntoSkills(segmentsPayload);
      // The skill MD files legitimately mention SEGMENT_DETECTED when they explain the
      // contract, so the assertion has to look at the runtime block, not the whole prompt.
      const runtimeOf = (prompt: string) => prompt.slice(prompt.lastIndexOf('\nRUNTIME:'));

      const matched = assembleSystemPrompt({
        skills,
        entryMarker: { code: 'C02', temperature: 'cold' },
      });
      expect(runtimeOf(matched)).toContain('ENTRADA: cold (C02)');
      expect(runtimeOf(matched)).toContain('SEGMENT_DETECTED: C02');
      expect(matched).toContain('ENTRY_SEGMENT C02');

      // Marker with no segment in the feed: no dangling pointer to a missing block.
      const unmatched = assembleSystemPrompt({
        skills,
        entryMarker: { code: 'R01', temperature: 'retargeting' },
      });
      expect(runtimeOf(unmatched)).toContain('ENTRADA: retargeting (R01)');
      expect(runtimeOf(unmatched)).not.toContain('SEGMENT_DETECTED');

      expect(runtimeOf(assembleSystemPrompt({ skills }))).not.toContain('SEGMENT_DETECTED');
    });

    it('renders site-owned pricing rules in DATOS on the live sites path', async () => {
      const skills = await loadIntoSkills(completeSitesPayload);
      const datos = renderBusinessData(skills);
      const exp = skills.andeanScapes.experiences.find(e => e.id === 'emerald_mining_tour');
      expect(exp).toBeDefined();
      // Catalog SSoT is dynamic — site rules land in botRules / DATOS PRICING_RULES.
      expect(exp!.pricing.botRules).toContain('Rule one.');
      expect(datos).toContain('PRICING_RULES: Rule one.');
    });

    it('renders one SITE block per site, each with its own isolated addon price', async () => {
      const skills = await loadIntoSkills(twoSitesPayload);
      const datos = renderBusinessData(skills);

      expect(datos).toContain('SITE chivor:');
      expect(datos).toContain('SITE coscuez:');

      const chivorBlock = datos.slice(datos.indexOf('SITE chivor:'), datos.indexOf('SITE coscuez:'));
      const coscuezBlock = datos.slice(datos.indexOf('SITE coscuez:'));

      expect(chivorBlock).toContain('horseback_riding [plans: 2d1n_mining] (Cabalgata Chivor): $120.000 pp');
      expect(coscuezBlock).toContain('horseback_riding [plans: 2d1n_gems] (Cabalgata Coscuez): $90.000 pp');
      // Chivor's block never contains Coscuez's price and vice versa.
      expect(chivorBlock).not.toContain('$90.000');
      expect(coscuezBlock).not.toContain('$120.000');
    });

    it('keeps each site narrative and plans in its own CATALOGO block', async () => {
      const skills = await loadIntoSkills(twoSitesPayload);
      const catalog = renderCatalog(skills);
      const chivorBlock = catalog.slice(catalog.indexOf('SITE chivor'), catalog.indexOf('SITE coscuez'));
      const coscuezBlock = catalog.slice(catalog.indexOf('SITE coscuez'));

      expect(chivorBlock).toContain('Ruta exclusiva de Chivor.');
      expect(chivorBlock).toContain('Plan Chivor');
      expect(chivorBlock).not.toContain('Coscuez');
      expect(coscuezBlock).toContain('Ruta exclusiva de Coscuez.');
      expect(coscuezBlock).toContain('Plan Coscuez');
      expect(coscuezBlock).not.toContain('Chivor');
    });

    it('does not collapse first-site narrative into ActiveExperience when multi-site', async () => {
      const skills = await loadIntoSkills(twoSitesPayload);
      const exp = skills.andeanScapes.experiences.find(e => e.id === 'emerald_mining_tour');
      expect(exp).toBeDefined();
      expect(exp!.shortDescription).toBe('');
      expect(exp!.route.localAccess).toBe('');
      expect(exp!.plans.map(p => p.id).sort()).toEqual(['2d1n_gems', '2d1n_mining']);
      expect(exp!.plans.every(p => p.siteId === 'chivor' || p.siteId === 'coscuez')).toBe(true);
    });

    it('returns availability from the selected plan site', async () => {
      const payload = {
        ...twoSitesPayload,
        experiences: {
          emerald_mining_tour: {
            ...twoSitesPayload.experiences.emerald_mining_tour,
            sites: {
              chivor: {
                ...twoSitesPayload.experiences.emerald_mining_tour.sites.chivor,
                availability: {
                  ...AVAILABILITY,
                  dates: [{ d: '2099-01-10', s: 'available' as const }],
                },
              },
              coscuez: {
                ...twoSitesPayload.experiences.emerald_mining_tour.sites.coscuez,
                availability: {
                  ...AVAILABILITY,
                  dates: [{ d: '2099-02-20', s: 'limited' as const }],
                },
              },
            },
          },
        },
      };
      const skills = await loadIntoSkills(payload);
      const experience = getActiveExperience(skills);

      expect(getFutureAvailableDatesForPlan(skills, experience, '2d1n_mining').map(date => date.date))
        .toEqual(['2099-01-10']);
      expect(getFutureAvailableDatesForPlan(skills, experience, '2d1n_gems').map(date => date.date))
        .toEqual(['2099-02-20']);
      expect(getFutureAvailableDatesForPlan(skills, experience)).toEqual([]);
    });

    it('keeps site-scoped availability when pricing is unavailable', async () => {
      const skills = await loadIntoSkills(twoSitesPayload);
      const experience = getActiveExperience(skills);
      experience.pricing.items = [];
      experience.pricing.botRules = ['PRICING_NOT_AVAILABLE'];

      const datos = renderBusinessData(skills);
      expect(datos).toContain('PRICING: NO DISPONIBLE');
      expect(datos).toContain('SITE chivor:');
      expect(datos).toContain('SITE coscuez:');
    });
  });

  describe('edge cases', () => {
    it('rejects duplicate plan ids across sites until site selection is persisted', () => {
      const duplicate = {
        ...twoSitesPayload,
        experiences: {
          emerald_mining_tour: {
            ...twoSitesPayload.experiences.emerald_mining_tour,
            sites: {
              ...twoSitesPayload.experiences.emerald_mining_tour.sites,
              coscuez: {
                ...twoSitesPayload.experiences.emerald_mining_tour.sites.coscuez,
                plans: {
                  '2d1n_mining': twoSitesPayload.experiences.emerald_mining_tour.sites.coscuez.plans['2d1n_gems'],
                },
              },
            },
          },
        },
      };
      expect(() => dynamicDataSchema.parse(duplicate)).toThrow(/unique across sites/);
    });

    it('keeps experience clarifications when a site has no plans', () => {
      const parsed = dynamicDataSchema.parse({
        v: 9,
        updated: '2026-07-26T00:00:00Z',
        experiences: {
          exp1: {
            clarifications: ['Must survive'],
            plans: {},
            pricing: { currency: 'COP', addons: {}, rules: [] },
            availability: AVAILABILITY,
          },
        },
      });
      expect(parsed.experiences.exp1.clarifications).toEqual(['Must survive']);
    });

    it('rejects a payload mixing unified and legacy plan keys', () => {
      expect(() => dynamicDataSchema.parse({
        v: 9,
        updated: '2026-07-26T00:00:00Z',
        experiences: {
          exp1: {
            plans: { p1: { pricing: { individual: 1 }, clarifications: [], addons: [] } },
            pricing: { currency: 'COP', plans: { p1: { individual: 1 } }, addons: {}, rules: [] },
            availability: AVAILABILITY,
          },
        },
      })).toThrow();
    });
  });
});

describe('CATALOGO language filtering', () => {
  beforeEach(() => {
    setDynamicService(null);
    loadSkills();
  });

  it('renders only Spanish safety FAQ answers for lang=es', () => {
    const catalog = renderCatalog(loadSkills(), 'es');
    const tagged = catalog.match(/^- \[\w+\/(es|en)\]/gm) ?? [];
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every(line => line.endsWith('/es]'))).toBe(true);
  });

  it('renders only English safety FAQ answers for lang=en', () => {
    const catalog = renderCatalog(loadSkills(), 'en');
    const tagged = catalog.match(/^- \[\w+\/(es|en)\]/gm) ?? [];
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every(line => line.endsWith('/en]'))).toBe(true);
  });

  it('covers every safety intent exactly once per language', () => {
    const intentsFor = (lang: string) =>
      (renderCatalog(loadSkills(), lang).match(/^- \[(\w+)\/(?:es|en)\]/gm) ?? []).sort();
    expect(intentsFor('es')).toHaveLength(intentsFor('en').length);
    expect(new Set(intentsFor('es')).size).toBe(intentsFor('es').length);
  });

  it('defaults to Spanish when no language is given', () => {
    expect(renderCatalog(loadSkills())).toBe(renderCatalog(loadSkills(), 'es'));
  });
});
