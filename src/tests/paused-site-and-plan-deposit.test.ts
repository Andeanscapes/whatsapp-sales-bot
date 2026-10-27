import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertDynamicCatalogReady, dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { transformDynamicData } from '../services/dynamic-data-service.js';
import { loadSkills, setDynamicService } from '../services/skill-loader.js';
import {
  getActiveExperience,
  getEquivalentPlan,
  getPublicPaymentFacts,
  getPublicPaymentFactsForPlan,
  getUnavailableSites,
  isPlanPaused,
} from '../services/product-registry.js';
import { assembleSystemPrompt, renderBusinessData } from '../services/skills-prompt-assembly.js';
import { calculatePriceQuote, getQuoteFingerprint, isQuoteFingerprintStale, quoteFingerprintPlanId } from '../services/pricing-calculator.js';
import { detectPlan } from '../services/qualification-engine.js';

const BASIC = 'basic_1d_chivor';
const CORE = 'core_2d1n_chivor';
const COSCUEZ_CORE = 'core_2d1n_coscuez';
const COSCUEZ_PRIME = 'prime_2d1n_coscuez';

interface RawCatalog {
  experiences: Record<string, { sites: Record<string, { status?: string; unavailableNote?: string }> }>;
}

function rawFixture(): RawCatalog {
  return JSON.parse(readFileSync(new URL('../../scripts/bot-dynamic.ci.json', import.meta.url), 'utf8')) as RawCatalog;
}

// The real fixture: Chivor on sale with BASIC/CORE/PRIME, Coscuez paused.
beforeEach(() => {
  setDynamicService(null);
  loadSkills();
});

describe('paused destination', () => {
  it('requires an unavailableNote on an inactive site', () => {
    const raw = rawFixture();
    delete raw.experiences.emerald_mining_tour.sites.coscuez.unavailableNote;

    const parsed = dynamicDataSchema.safeParse(raw);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some(issue => issue.message.includes('needs an unavailableNote'))).toBe(true);
  });

  it('keeps the paused data for reactivation but sells none of it', () => {
    const validated = dynamicDataSchema.parse(rawFixture());
    expect(() => assertDynamicCatalogReady(validated)).not.toThrow();
    expect(validated.experiences.emerald_mining_tour.sites.coscuez.plans[COSCUEZ_CORE]).toBeDefined();

    const internal = transformDynamicData(validated);
    const experience = internal.experiences.emerald_mining_tour;
    expect(experience.plans.some(plan => plan.siteId === 'coscuez')).toBe(false);
    expect(experience.pricing.items.some(item => item.siteId === 'coscuez')).toBe(false);
    expect(experience.sites.coscuez).toBeUndefined();
    expect(internal.media?.galleryImages.some(image => image.siteId === 'coscuez')).toBe(false);
    expect(internal.media?.planImages.some(image => image.siteId === 'coscuez')).toBe(false);
    expect(experience.unavailableSites).toEqual([expect.objectContaining({
      siteId: 'coscuez',
      planIds: [COSCUEZ_CORE, COSCUEZ_PRIME],
    })]);
  });

  it('acknowledges the destination in the prompt without prices, plan ids or photos', () => {
    const skills = loadSkills();
    const note = getUnavailableSites(getActiveExperience(skills))[0]?.note ?? '';
    const prompt = assembleSystemPrompt({ skills });

    expect(note).not.toBe('');
    expect(prompt).toContain('DESTINO NO DISPONIBLE TEMPORALMENTE: Coscuez');
    expect(prompt).toContain(note);
    expect(prompt).not.toContain(COSCUEZ_CORE);
    expect(prompt).not.toContain(COSCUEZ_PRIME);
    expect(prompt).not.toContain('/coscuez/');
    // One destination on sale: the bot must not ask the customer to choose one.
    expect(prompt).not.toContain('SITIO PENDIENTE: ');
  });

  it('flags only plans of the paused destination', () => {
    const experience = getActiveExperience(loadSkills());
    expect(isPlanPaused(experience, COSCUEZ_PRIME)).toBe(true);
    expect(isPlanPaused(experience, CORE)).toBe(false);
    expect(isPlanPaused(experience, 'legacy_plan_id')).toBe(false);
    expect(isPlanPaused(experience, null)).toBe(false);
  });

  it('transfers a paused plan tier only to a unique active equivalent', () => {
    const experience = structuredClone(getActiveExperience(loadSkills()));
    expect(getEquivalentPlan(experience, COSCUEZ_CORE, 'chivor')).toBe(CORE);
    expect(getEquivalentPlan(experience, COSCUEZ_PRIME, 'chivor')).toBe('prime_2d1n_chivor');
    expect(getEquivalentPlan(experience, CORE, 'coscuez')).toBeNull();

    delete experience.unavailableSites![0].planTiers[COSCUEZ_CORE];
    expect(getEquivalentPlan(experience, COSCUEZ_CORE, 'chivor')).toBeNull();
  });
});

describe('plan-level anticipo', () => {
  it('uses the plan deposit when the catalog sets one, else the global one', () => {
    const skills = loadSkills();
    const experience = getActiveExperience(skills);
    const global = getPublicPaymentFacts(skills).depositPercent;

    expect(global).toBe(25);
    expect(getPublicPaymentFactsForPlan(skills, experience, BASIC).depositPercent).toBe(30);
    expect(getPublicPaymentFactsForPlan(skills, experience, CORE).depositPercent).toBe(25);
    expect(getPublicPaymentFactsForPlan(skills, experience, 'unknown_plan').depositPercent).toBe(25);
    expect(getPublicPaymentFactsForPlan(skills, null, BASIC).depositPercent).toBe(25);
  });

  it('renders the plan deposit next to the global one in DATOS', () => {
    const datos = renderBusinessData(loadSkills());
    expect(datos).toContain('deposit: 25%');
    expect(datos).toContain(`deposit_by_plan: ${BASIC} 30%`);
    expect(assembleSystemPrompt({ skills: loadSkills() })).not.toContain('anticipo de este plan');
  });

  it('quotes BASIC for two people from the brochure couple price', () => {
    expect(calculatePriceQuote(getActiveExperience(loadSkills()), { planId: BASIC, people: 2 })?.planTotal).toBe(740000);
  });

  it('reads the fingerprinted plan and judges staleness with that plan deposit', () => {
    const skills = loadSkills();
    const experience = getActiveExperience(skills);
    const deposit = getPublicPaymentFactsForPlan(skills, experience, BASIC).depositPercent;
    const fingerprint = getQuoteFingerprint(experience, BASIC, deposit) ?? '';

    expect(quoteFingerprintPlanId(fingerprint)).toBe(BASIC);
    expect(quoteFingerprintPlanId('malformed')).toBeNull();
    expect(isQuoteFingerprintStale(experience, fingerprint, deposit)).toBe(false);
    expect(isQuoteFingerprintStale(experience, fingerprint, getPublicPaymentFacts(skills).depositPercent)).toBe(true);
  });
});

describe('BASIC selection', () => {
  it.each(['tienen pasadía?', 'me interesa el pasadia', 'quiero el basico'])('selects BASIC: %s', message => {
    expect(detectPlan(message, getActiveExperience(loadSkills()))).toBe(BASIC);
  });

  // "un día" is ordinary Spanish; as an alias it stored BASIC from a date answer.
  it.each(['quiero ir un día de noviembre', 'en un dia llegamos', 'quiero la de una mina'])('does not select a plan: %s', message => {
    expect(detectPlan(message, getActiveExperience(loadSkills()))).toBeNull();
  });
});

describe('generic words never choose a plan', () => {
  // The C01 ad opener used to store PRIME through the generic "aventura" keyword, so
  // the bot later priced PRIME + transport for a customer who never chose a plan.
  it.each([
    'C01 - Hola, quiero informacion y fechas para la aventura minera en Chivor',
    'Hola, quiero info de la aventura',
    'me gustaria algo completo',
    'quiero hacer la caminata',
    'quiero algo full',
  ])('selects no plan: %s', message => {
    expect(detectPlan(message, getActiveExperience(loadSkills()), 'chivor')).toBeNull();
  });

  it.each([
    ['quiero la mas completa', 'prime_2d1n_chivor'],
    ['me interesan las dos minas', 'prime_2d1n_chivor'],
    ['quiero el core', 'core_2d1n_chivor'],
  ])('still selects a named plan: %s', (message, planId) => {
    expect(detectPlan(message, getActiveExperience(loadSkills()), 'chivor')).toBe(planId);
  });
});
