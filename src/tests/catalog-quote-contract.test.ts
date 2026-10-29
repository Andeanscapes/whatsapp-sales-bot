import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { transformDynamicData } from '../services/dynamic-data-service.js';
import { loadSkills } from '../services/skill-loader.js';
import { getActiveExperience } from '../services/product-registry.js';
import { calculatePriceQuote, getQuoteFingerprint, isQuoteFingerprintStale } from '../services/pricing-calculator.js';
import { assembleSystemPrompt, renderBusinessData } from '../services/skills-prompt-assembly.js';
import { allSitesActivePayload, useAllSitesActive } from './helpers/all-sites-catalog.js';

// The multi-site regression net runs with every destination active, as the CI
// fixture had before destinations could be paused.
beforeEach(() => {
  useAllSitesActive();
});

function catalog() {
  const raw: unknown = JSON.parse(readFileSync(new URL('../../scripts/bot-dynamic.ci.json', import.meta.url), 'utf8'));
  return dynamicDataSchema.parse(raw);
}

function experience() {
  const exp = structuredClone(getActiveExperience(loadSkills()));
  exp.plans = [{ ...exp.plans[0], id: 'custom_plan', calculation: 'pairs_plus_single', includedAddonIds: ['included_activity'] }];
  exp.pricing.items = [
    { id: 'individual', kind: 'plan', planId: 'custom_plan', label: 'Individual', pricePerPerson: 650000, publiclyShow: true },
    { id: 'couple', kind: 'plan', planId: 'custom_plan', label: 'Couple', couplePrice: 1200000, publiclyShow: true },
    { id: 'included_activity', kind: 'addon', planId: 'custom_plan', label: 'Included', pricePerPerson: 120000, publiclyShow: true },
    { id: 'new_activity', kind: 'addon', planId: 'custom_plan', label: 'Optional', pricePerPerson: 55000, quoteMode: 'separate', publiclyShow: true },
    { id: 'custom_transfer', kind: 'addon', role: 'transport', planId: 'custom_plan', label: 'Transfer', couplePrice: 700000, peopleIncluded: 6, publiclyShow: true },
  ];
  return exp;
}

describe('catalog quote contract', () => {
  it('lists all three active Chivor options before a plan is chosen', () => {
    const prompt = assembleSystemPrompt({
      skills: loadSkills(), collectedFields: { personas: 2, site: 'chivor' },
    });
    const options = prompt.match(/OPCIONES DE PLAN ESTE TURNO:[^\n]*/)?.[0] ?? '';
    expect(options).toContain('BASIC');
    expect(options).toContain('CORE');
    expect(options).toContain('PRIME');
    expect(options).not.toContain('Coscuez');
    expect(options).not.toContain('$');
    const selectedPrompt = assembleSystemPrompt({
      skills: loadSkills(), collectedFields: { personas: 2, plan: 'basic_1d_chivor' },
    });
    expect(selectedPrompt).not.toContain('OPCIONES DE PLAN ESTE TURNO:');
  });

  it.each(['C02', 'H02'])('lets campaign segment %s own its diagnosis on the opening turn', code => {
    const prompt = assembleSystemPrompt({
      skills: loadSkills(),
      collectedFields: { personas: 2, site: 'chivor' },
      entryMarker: { code, temperature: code.startsWith('C') ? 'cold' : 'funnel' },
      entryOpeningTurn: true,
    });
    expect(prompt).toContain(`ENTRY_SEGMENT ${code}`);
    expect(prompt).not.toContain('OPCIONES DE PLAN ESTE TURNO:');
  });

  // Live 2026-10-28: after the C03 moto question the bot offered only "esencial / más
  // completa", hiding the day plan; "la básica" then stored the day plan while the
  // customer meant the essential overnight one.
  it.each(['C02', 'C03', 'C04', 'H02'])('lists every Chivor plan for segment %s once its opening question is answered', code => {
    const prompt = assembleSystemPrompt({
      skills: loadSkills(),
      collectedFields: { personas: 2, site: 'chivor' },
      entryMarker: { code, temperature: code.startsWith('C') ? 'cold' : 'funnel' },
      entryOpeningTurn: false,
    });
    const options = prompt.match(/OPCIONES DE PLAN ESTE TURNO:[^\n]*/)?.[0] ?? '';
    expect(options).toContain('BASIC');
    expect(options).toContain('CORE');
    expect(options).toContain('PRIME');
  });

  it('omits the per-person equivalent while transport is pending confirmation', () => {
    const prompt = assembleSystemPrompt({
      skills: loadSkills(), collectedFields: { personas: 9, plan: 'basic_1d_chivor', transporte: 'from_bogota' },
    });
    const lock = prompt.match(/QUOTE LOCK:[^\n]*/)?.[0] ?? '';
    expect(lock).toContain('Transporte adicional pendiente de confirmacion');
    expect(lock).not.toContain('EQUIVALENTE POR PERSONA');
  });

  it.each([
    ['basic_1d_chivor', '$740.000', '$370.000'],
    ['core_2d1n_chivor', '$950.000', '$475.000'],
    ['prime_2d1n_chivor', '$1.700.000', '$850.000'],
  ])('provides total plus group-equivalent per person for %s', (plan, total, equivalent) => {
    const prompt = assembleSystemPrompt({ skills: loadSkills(), collectedFields: { personas: 2, plan } });
    const lock = prompt.match(/QUOTE LOCK:[^\n]*/)?.[0] ?? '';
    expect(lock).toContain(`el plan queda en ${total} COP`);
    expect(lock).toContain(`EQUIVALENTE POR PERSONA: ${equivalent} COP`);
    expect(lock).not.toContain('aproximado por redondeo');
  });

  it('labels the rounded equivalent without rounding the group total', () => {
    const prompt = assembleSystemPrompt({
      skills: loadSkills(), collectedFields: { personas: 3, plan: 'basic_1d_chivor' },
    });
    expect(prompt).toContain('el plan queda en $1.220.000 COP');
    expect(prompt).toContain('EQUIVALENTE POR PERSONA: $406.667 COP (aproximado por redondeo)');
  });

  it('bases the equivalent on the complete transport-inclusive total', () => {
    const prompt = assembleSystemPrompt({
      skills: loadSkills(), collectedFields: { personas: 2, plan: 'core_2d1n_chivor', transporte: 'from_bogota' },
    });
    expect(prompt).toContain('el plan queda en $2.650.000 COP');
    expect(prompt).toContain('EQUIVALENTE POR PERSONA: $1.325.000 COP');
  });

  it('does not duplicate the price for a solo traveler or after a quote', () => {
    const skills = loadSkills();
    expect(assembleSystemPrompt({ skills, collectedFields: { personas: 1, plan: 'basic_1d_chivor' } }))
      .not.toContain('EQUIVALENTE POR PERSONA:');
    expect(assembleSystemPrompt({ skills, collectedFields: { personas: 2, plan: 'basic_1d_chivor' }, priceGiven: true }))
      .not.toContain('EQUIVALENTE POR PERSONA:');
  });

  it('preserves metadata from validated JSON through transform, registry and assembly', () => {
    const normalized = transformDynamicData(catalog()).experiences.emerald_mining_tour;
    const prime = normalized.plans?.find(plan => plan.id === 'prime_2d1n_chivor');
    expect(prime?.selectionAliases).toEqual(['prime', 'mas completa', 'premium', 'la de dos minas', 'la de cabalgata', 'mas completo']);
    expect(prime?.includedAddonIds).toEqual(['horseback_riding']);
    expect(prime?.calculation).toBe('couple_half_from_five');
    expect(normalized.pricing.items.find(item => item.id === 'horseback_riding')?.quoteMode).toBe('separate');
    const skills = loadSkills();
    expect(getActiveExperience(skills).plans.find(plan => plan.id === prime?.id)?.includedAddonIds).toEqual(['horseback_riding']);
    const prompt = assembleSystemPrompt({ skills });
    expect(prompt).toContain('selectionAliases: prime');
    expect(prompt).toContain('includedAddonIds (no extra charge): horseback_riding');
    expect(prompt).toContain('quoteMode: separate');
    expect(prompt).not.toContain('calculation: couple_half_from_five');
  });

  it('never prices an included addon for the plan that includes it (CI catalog)', () => {
    const items = transformDynamicData(catalog()).experiences.emerald_mining_tour.pricing.items;
    expect(items.filter(item => item.id === 'horseback_riding').map(item => item.planId)).toEqual(['core_2d1n_chivor']);
    const datos = renderBusinessData(loadSkills());
    expect(datos).toContain('horseback_riding [plans: core_2d1n_chivor]');
    expect(datos).not.toMatch(/horseback_riding \[plans:[^\]]*prime_2d1n_chivor/);
    expect(datos).toContain('INCLUDED_ADDONS prime_2d1n_chivor: horseback_riding');
  });

  it('sums requested private transport into the QUOTE LOCK total for 1-4 people (CI catalog)', () => {
    const exp = getActiveExperience(loadSkills());
    const quote = calculatePriceQuote(exp, { planId: 'core_2d1n_chivor', people: 4, transportNeed: 'from_bogota' });
    expect(quote?.transportTotal).toBe(1700000);
    expect(quote?.total).toBe((quote?.planTotal ?? 0) + 1700000);
    const prompt = assembleSystemPrompt({ skills: loadSkills(), collectedFields: { personas: 4, plan: 'core_2d1n_chivor', transporte: 'from_bogota' } });
    expect(prompt).toContain(`el plan queda en $${(quote?.total ?? 0).toLocaleString('es-CO')} COP`);
  });

  it('rejects unknown addon references, priced+included overlap and unsupported calculation rules', () => {
    const data = catalog();
    data.experiences.emerald_mining_tour.sites.chivor.plans.core_2d1n_chivor.includedAddonIds = ['missing'];
    expect(dynamicDataSchema.safeParse(data).success).toBe(false);
    const overlap = catalog();
    overlap.experiences.emerald_mining_tour.sites.chivor.plans.core_2d1n_chivor.includedAddonIds = ['apiary_cattle'];
    expect(dynamicDataSchema.safeParse(overlap).success).toBe(false);
    const invalid = catalog();
    const plan = invalid.experiences.emerald_mining_tour.sites.chivor.plans.core_2d1n_chivor;
    expect(dynamicDataSchema.safeParse({ ...invalid, experiences: {
      ...invalid.experiences, emerald_mining_tour: { ...invalid.experiences.emerald_mining_tour, sites: {
        chivor: { ...invalid.experiences.emerald_mining_tour.sites.chivor, plans: { core_2d1n_chivor: { ...plan, pricing: { ...plan.pricing, calculation: 'arbitrary code' } } } },
      } },
    } }).success).toBe(false);
  });

  it('quotes arbitrary addons separately and never charges included activities', () => {
    const quote = calculatePriceQuote(experience(), { planId: 'custom_plan', people: 3, addonIds: ['included_activity', 'new_activity', 'new_activity'] });
    expect(quote?.planTotal).toBe(1850000);
    expect(quote?.total).toBe(1850000);
    expect(quote?.addonsTotal).toBe(0);
    expect(quote?.separateAddons).toEqual([{ id: 'new_activity', amount: 165000, requiresConfirmation: false }]);
  });

  it('honors calculation changes without editing the calculator', () => {
    const exp = experience();
    expect(calculatePriceQuote(exp, { planId: 'custom_plan', people: 5 })?.total).toBe(3050000);
    exp.plans[0].calculation = 'per_person';
    exp.pricing.items = exp.pricing.items.filter(item => item.id !== 'couple');
    expect(calculatePriceQuote(exp, { planId: 'custom_plan', people: 5 })?.total).toBe(3250000);
  });

  it('reads transport role and capacity from arbitrary catalog addons', () => {
    const exp = experience();
    expect(calculatePriceQuote(exp, { planId: 'custom_plan', people: 5, transportNeed: 'from_bogota' })?.total).toBe(3750000);
    const tooLarge = calculatePriceQuote(exp, { planId: 'custom_plan', people: 7, transportNeed: 'from_bogota' });
    expect(tooLarge?.requiresTransportConfirmation).toBe(true);
    expect(tooLarge?.total).toBeNull();
  });

  it('rejects unknown plans, ineligible addons and conflicting sites', () => {
    const exp = experience();
    expect(calculatePriceQuote(exp, { planId: 'missing', people: 2 })).toBeNull();
    expect(calculatePriceQuote(exp, { planId: 'custom_plan', people: 2, addonIds: ['missing'] })).toBeNull();
    expect(calculatePriceQuote(exp, { planId: 'custom_plan', people: 2, siteId: 'other' })).toBeNull();
  });

  it('fingerprints only catalog facts: price, deposit, inclusion and rule changes are stale', () => {
    const exp = experience();
    const fingerprint = getQuoteFingerprint(exp, 'custom_plan', 25);
    expect(fingerprint).toMatch(/^custom_plan:/);
    expect(isQuoteFingerprintStale(exp, fingerprint ?? '', 25)).toBe(false);
    expect(isQuoteFingerprintStale(exp, fingerprint ?? '', 30)).toBe(true);
    exp.plans[0].includedAddonIds = [];
    expect(isQuoteFingerprintStale(exp, fingerprint ?? '', 25)).toBe(true);
    exp.plans[0].includedAddonIds = ['included_activity'];
    exp.plans[0].calculation = 'per_person';
    expect(isQuoteFingerprintStale(exp, fingerprint ?? '', 25)).toBe(true);
    exp.plans[0].calculation = 'pairs_plus_single';
    exp.pricing.items[1].couplePrice = 1300000;
    expect(isQuoteFingerprintStale(exp, fingerprint ?? '', 25)).toBe(true);
    exp.pricing.items[1].couplePrice = 1200000;
    exp.plans = [];
    expect(isQuoteFingerprintStale(exp, fingerprint ?? '', 25)).toBe(true);
  });

  it('describes plans by total time and scope, never by intensity or a single activity (CI catalog)', () => {
    const prompt = assembleSystemPrompt({ skills: loadSkills() });
    const plans = getActiveExperience(loadSkills()).plans.filter(plan => plan.siteId === 'chivor');
    for (const plan of plans) {
      expect(plan.shortDescription).toMatch(/En total ~\d+(\.\d+)?h de experiencia/);
      // The pasadia has breakfast and lunch; overnight plans have four meals.
      expect(plan.included.join(' ')).toMatch(plan.duration === '1D/0N' ? /2 comidas/ : /4 comidas/);
      expect(`${plan.shortDescription} ${plan.benefits ?? ''}`).not.toMatch(/intens|tranquil|accesible|calma/i);
    }
    expect(prompt).not.toMatch(/3 comidas/);
    expect(prompt).toMatch(/tiempo subterraneo varia/i);
  });
});

describe('gallery planIds contract', () => {
  type Feed = { experiences: Record<string, { sites: Record<string, {
    media: { gallery: Array<{ url: string; caption: string; type?: string; planIds?: string[] }> };
  }> }> };

  function feedWithRestrictedPhoto(planIds: string[]): Feed {
    const feed = allSitesActivePayload() as Feed;
    const media = feed.experiences.emerald_mining_tour.sites.coscuez.media;
    media.gallery = [{
      url: 'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/coscuez/gallery/mine/01.jpg',
      caption: '', type: 'mine', planIds,
    }];
    return feed;
  }

  it('accepts a photo restricted to a plan of its own site and carries it through', () => {
    const parsed = dynamicDataSchema.parse(feedWithRestrictedPhoto(['prime_2d1n_coscuez']));
    const internal = transformDynamicData(parsed);
    expect(internal.media?.galleryImages.filter(image => image.siteId === 'coscuez').map(image => image.planIds))
      .toEqual([['prime_2d1n_coscuez']]);
  });

  it('rejects a planIds entry naming another site\'s plan', () => {
    const result = dynamicDataSchema.safeParse(feedWithRestrictedPhoto(['prime_2d1n_chivor']));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('is not a plan of site');
  });
});
