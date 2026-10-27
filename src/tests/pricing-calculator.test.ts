import { beforeEach, describe, expect, it } from 'vitest';
import { loadSkills } from '../services/skill-loader.js';
import { getActiveExperience } from '../services/product-registry.js';
import { calculatePriceQuote, findQuotedAlternative, getStartingPrice, listCheaperPlanQuotes } from '../services/pricing-calculator.js';
import { ADDON_ID_APIARY_CATTLE, ADDON_ID_PRIVATE_TRANSPORT } from '../services/dynamic-data-service.js';
import { allSitesActivePayload, useAllSitesActive, withSamePricing } from './helpers/all-sites-catalog.js';

// The multi-site regression net runs with every destination active, as the CI
// fixture had before destinations could be paused.
beforeEach(() => {
  useAllSitesActive();
});

describe('calculatePriceQuote', () => {
  it('lists cheaper same-site plans and excludes equal-price plans at other sites', () => {
    // Coscuez CORE priced exactly like Chivor's cheapest plan: equal is not cheaper.
    const exp = getActiveExperience(useAllSitesActive(withSamePricing(allSitesActivePayload(), 'basic_1d_chivor', 'core_2d1n_coscuez')));

    const alternatives = listCheaperPlanQuotes(exp, 'prime_2d1n_chivor', 2);

    expect(alternatives?.map(option => option.planId)).toEqual(['basic_1d_chivor', 'core_2d1n_chivor']);
    expect(alternatives?.every(option => option.total < 1_700_000)).toBe(true);
  });

  it('compares alternatives on the same total basis as QUOTE LOCK when transport is requested', () => {
    const exp = getActiveExperience(loadSkills());
    const withTransport = calculatePriceQuote(exp, { planId: 'basic_1d_chivor', people: 2, transportNeed: 'from_bogota' });

    const [alternative] = listCheaperPlanQuotes(exp, 'prime_2d1n_chivor', 2, 'from_bogota') ?? [];

    expect(alternative?.planId).toBe('basic_1d_chivor');
    expect(alternative?.total).toBe(withTransport?.total ?? withTransport?.planTotal);
    expect(alternative?.planTotal).toBe(withTransport?.planTotal);
  });

  it('identifies only a uniquely quoted alternative', () => {
    const exp = getActiveExperience(loadSkills());
    const alternatives = listCheaperPlanQuotes(exp, 'prime_2d1n_chivor', 2) ?? [];
    const core = alternatives.find(option => option.planId === 'core_2d1n_chivor');

    expect(findQuotedAlternative(alternatives, core ? [core.total] : [])).toBe('core_2d1n_chivor');
    expect(findQuotedAlternative(alternatives, [1])).toBeNull();
  });

  it('does not claim remote plans are cheaper when their requested transport has no confirmed total', () => {
    const exp = structuredClone(getActiveExperience(loadSkills()));
    exp.pricing.items = exp.pricing.items.map(item => item.siteId === 'chivor' && item.kind === 'addon'
      ? { ...item, category: 'team_confirmation' as const }
      : item);

    expect(calculatePriceQuote(exp, { planId: 'core_2d1n_coscuez', people: 2, transportNeed: 'from_bogota' })?.total).not.toBeNull();
    expect(calculatePriceQuote(exp, { planId: 'core_2d1n_chivor', people: 2, transportNeed: 'from_bogota' })?.requiresTransportConfirmation).toBe(true);
    expect(listCheaperPlanQuotes(exp, 'prime_2d1n_coscuez', 2, 'from_bogota')).toBeNull();
  });

  it('distinguishes an incomplete comparison from no cheaper plan', () => {
    const exp = getActiveExperience(loadSkills());
    expect(listCheaperPlanQuotes(exp, null, 2)).toBeNull();
    expect(listCheaperPlanQuotes(exp, 'prime_2d1n_coscuez', 0)).toBeNull();
    expect(listCheaperPlanQuotes(exp, 'basic_1d_chivor', 2)).toEqual([]);
  });

  it('uses the lowest one-person package total for a starting price', () => {
    const exp = getActiveExperience(loadSkills());
    const originalPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP', lastUpdated: '2026-01-01',
      items: [
          { id: 'core_2d1n_chivor_individual', planId: 'core_2d1n_chivor', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
          { id: 'core_2d1n_chivor_couple', planId: 'core_2d1n_chivor', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
          { id: 'hidden_individual', planId: 'prime_2d1n_chivor', label: 'Individual', pricePerPerson: 300000, publiclyShow: false },
          { id: 'prime_2d1n_chivor_individual', planId: 'prime_2d1n_chivor', label: 'Individual', pricePerPerson: 650000, publiclyShow: true },
        { id: 'cheap_optional_extra', kind: 'addon', planId: 'core_2d1n_chivor', label: 'Optional extra', pricePerPerson: 10000, publiclyShow: true },
      ],
      botRules: [], businessRules: [],
    };

    try {
      expect(getStartingPrice(exp)).toEqual({ amount: 550000, currency: 'COP', planId: 'core_2d1n_chivor' });
      expect(getStartingPrice(exp, 'prime_2d1n_chivor')).toEqual({ amount: 650000, currency: 'COP', planId: 'prime_2d1n_chivor' });
    } finally {
      exp.pricing = originalPricing;
    }
  });

  it('calculates 5+ people from couple / 2 x people', () => {
    const exp = getActiveExperience(loadSkills());
    exp.plans = exp.plans.map(plan => ({ ...plan, calculation: 'couple_half_from_five' }));
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
          { id: 'core_2d1n_chivor_individual', planId: 'core_2d1n_chivor', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
          { id: 'core_2d1n_chivor_couple', planId: 'core_2d1n_chivor', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    const quote = calculatePriceQuote(exp, { planId: 'core_2d1n_chivor', people: 5 });

    expect(quote?.planTotal).toBe(2500000);
    expect(quote?.total).toBe(2500000);
  });

  it('does not sum private transport for 5+ people', () => {
    const exp = getActiveExperience(loadSkills());
    exp.plans = exp.plans.map(plan => ({ ...plan, calculation: 'couple_half_from_five' }));
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'core_2d1n_chivor_individual', planId: 'core_2d1n_chivor', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: 'core_2d1n_chivor_couple', planId: 'core_2d1n_chivor', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
          { id: ADDON_ID_PRIVATE_TRANSPORT, kind: 'addon', label: 'Transporte privado 4x4 desde Bogota', couplePrice: 1700000, peopleIncluded: 4, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    const quote = calculatePriceQuote(exp, { planId: 'core_2d1n_chivor', people: 5, transportNeed: 'from_bogota' });

    expect(quote?.planTotal).toBe(2500000);
    expect(quote?.total).toBeNull();
    expect(quote?.requiresTransportConfirmation).toBe(true);
  });

  it('sums private transport for 1-4 people and per-person addons', () => {
    const exp = getActiveExperience(loadSkills());
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'core_2d1n_chivor_individual', planId: 'core_2d1n_chivor', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: 'core_2d1n_chivor_couple', planId: 'core_2d1n_chivor', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
          { id: ADDON_ID_PRIVATE_TRANSPORT, kind: 'addon', label: 'Transporte privado 4x4 desde Bogota', couplePrice: 1700000, peopleIncluded: 4, publiclyShow: true },
          { id: ADDON_ID_APIARY_CATTLE, kind: 'addon', planId: 'core_2d1n_chivor', label: 'Apicultura y ganaderia', pricePerPerson: 55000, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    const quote = calculatePriceQuote(exp, { planId: 'core_2d1n_chivor', people: 2, transportNeed: 'own', includeApiaryCattle: true });
    const quoteWithTransport = calculatePriceQuote(exp, { planId: 'core_2d1n_chivor', people: 4, transportNeed: 'from_bogota' });

    expect(quote?.total).toBe(1110000);
    expect(quoteWithTransport?.total).toBe(3700000);
  });

  it('returns integer-safe total when couple price is odd (5+ formula)', () => {
    const exp = getActiveExperience(loadSkills());
    exp.plans = exp.plans.map(plan => ({ ...plan, calculation: 'couple_half_from_five' }));
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'core_2d1n_chivor_individual', planId: 'core_2d1n_chivor', label: 'Individual', pricePerPerson: 550001, publiclyShow: true },
        { id: 'core_2d1n_chivor_couple', planId: 'core_2d1n_chivor', label: 'Pareja', couplePrice: 1000001, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    const quote = calculatePriceQuote(exp, { planId: 'core_2d1n_chivor', people: 5 });

    // (1000001 / 2) * 5 = 2500002.5 -> rounded to nearest peso.
    expect(quote?.planTotal).toBe(2500003);
    expect(Number.isInteger(quote?.planTotal)).toBe(true);
  });

  it('requires confirmation if the requested transport price is unavailable', () => {
    const exp = getActiveExperience(loadSkills());
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'core_2d1n_chivor_individual', planId: 'core_2d1n_chivor', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: 'core_2d1n_chivor_couple', planId: 'core_2d1n_chivor', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
        // Renamed away from ADDON_ID_PRIVATE_TRANSPORT — calculator can't find it.
        { id: 'transporte_privado', label: 'Transporte privado 4x4 desde Bogota', couplePrice: 1700000, peopleIncluded: 4, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    const quote = calculatePriceQuote(exp, { planId: 'core_2d1n_chivor', people: 2, transportNeed: 'from_bogota' });

    expect(quote?.transportTotal).toBeNull();
    expect(quote?.total).toBeNull();
    expect(quote?.requiresTransportConfirmation).toBe(true);
  });

  it('uses plan and addon prices from the selected plan site only', () => {
    const exp = getActiveExperience(loadSkills());
    const originalPlans = exp.plans;
    const originalPricing = exp.pricing;
    exp.plans = [{ ...originalPlans[0], id: 'prime_2d1n_chivor', siteId: 'coscuez' }];
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'chivor_individual', siteId: 'chivor', planId: 'prime_2d1n_chivor', label: 'Wrong individual', pricePerPerson: 900000, publiclyShow: true },
        { id: 'chivor_couple', siteId: 'chivor', planId: 'prime_2d1n_chivor', label: 'Wrong couple', couplePrice: 1700000, publiclyShow: true },
        { id: 'coscuez_individual', siteId: 'coscuez', planId: 'prime_2d1n_chivor', label: 'Coscuez individual', pricePerPerson: 480000, publiclyShow: true },
        { id: 'coscuez_couple', siteId: 'coscuez', planId: 'prime_2d1n_chivor', label: 'Coscuez couple', couplePrice: 900000, publiclyShow: true },
          { id: ADDON_ID_PRIVATE_TRANSPORT, kind: 'addon', siteId: 'chivor', label: 'Wrong transport', couplePrice: 1700000, publiclyShow: true },
          { id: ADDON_ID_PRIVATE_TRANSPORT, kind: 'addon', siteId: 'coscuez', label: 'Coscuez transport', couplePrice: 700000, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    try {
      const quote = calculatePriceQuote(exp, { planId: 'prime_2d1n_chivor', people: 2, transportNeed: 'from_bogota' });
      expect(quote?.planTotal).toBe(900000);
      expect(quote?.transportTotal).toBe(700000);
      expect(quote?.total).toBe(1600000);
    } finally {
      exp.plans = originalPlans;
      exp.pricing = originalPricing;
    }
  });

  it('does not use transport scoped to another plan on the same site', () => {
    const exp = getActiveExperience(loadSkills());
    const originalPlans = exp.plans;
    const originalPricing = exp.pricing;
    exp.plans = [
      { ...originalPlans[0], id: 'core_2d1n_chivor', siteId: 'chivor' },
      { ...originalPlans[0], id: 'prime_2d1n_chivor', siteId: 'chivor' },
    ];
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'plan_b_individual', siteId: 'chivor', planId: 'prime_2d1n_chivor', label: 'Individual', pricePerPerson: 500000, publiclyShow: true },
        { id: 'plan_b_couple', siteId: 'chivor', planId: 'prime_2d1n_chivor', label: 'Pareja', couplePrice: 900000, publiclyShow: true },
        { id: ADDON_ID_PRIVATE_TRANSPORT, siteId: 'chivor', planId: 'core_2d1n_chivor', label: 'Transport plan A', couplePrice: 700000, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    try {
      const quote = calculatePriceQuote(exp, { planId: 'prime_2d1n_chivor', people: 2, transportNeed: 'from_bogota' });
      expect(quote?.transportTotal).toBeNull();
      expect(quote?.total).toBeNull();
      expect(quote?.requiresTransportConfirmation).toBe(true);
    } finally {
      exp.plans = originalPlans;
      exp.pricing = originalPricing;
    }
  });
});
