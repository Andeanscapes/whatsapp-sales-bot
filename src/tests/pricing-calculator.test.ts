import { describe, expect, it } from 'vitest';
import { loadSkills } from '../services/skill-loader.js';
import { getActiveExperience } from '../services/product-registry.js';
import { calculatePriceQuote, getStartingPrice } from '../services/pricing-calculator.js';
import { ADDON_ID_APIARY_CATTLE, ADDON_ID_PRIVATE_TRANSPORT } from '../services/dynamic-data-service.js';

describe('calculatePriceQuote', () => {
  it('uses the lowest one-person package total for a starting price', () => {
    const exp = getActiveExperience(loadSkills());
    const originalPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP', lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
        { id: 'hidden_individual', planId: '3d2n_rural', label: 'Individual', pricePerPerson: 300000, publiclyShow: false },
        { id: '3d2n_rural_individual', planId: '3d2n_rural', label: 'Individual', pricePerPerson: 650000, publiclyShow: true },
        { id: 'cheap_optional_extra', kind: 'addon', planId: '2d1n_mining', label: 'Optional extra', pricePerPerson: 10000, publiclyShow: true },
      ],
      botRules: [], businessRules: [],
    };

    try {
      expect(getStartingPrice(exp)).toEqual({ amount: 550000, currency: 'COP', planId: '2d1n_mining' });
      expect(getStartingPrice(exp, '3d2n_rural')).toEqual({ amount: 650000, currency: 'COP', planId: '3d2n_rural' });
    } finally {
      exp.pricing = originalPricing;
    }
  });

  it('calculates 5+ people from couple / 2 x people', () => {
    const exp = getActiveExperience(loadSkills());
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    const quote = calculatePriceQuote(exp, { planId: '2d1n_mining', people: 5 });

    expect(quote?.planTotal).toBe(2500000);
    expect(quote?.total).toBe(2500000);
  });

  it('does not sum private transport for 5+ people', () => {
    const exp = getActiveExperience(loadSkills());
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
        { id: ADDON_ID_PRIVATE_TRANSPORT, label: 'Transporte privado 4x4 desde Bogota', couplePrice: 1700000, peopleIncluded: 4, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    const quote = calculatePriceQuote(exp, { planId: '2d1n_mining', people: 5, transportNeed: 'from_bogota' });

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
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
        { id: ADDON_ID_PRIVATE_TRANSPORT, label: 'Transporte privado 4x4 desde Bogota', couplePrice: 1700000, peopleIncluded: 4, publiclyShow: true },
        { id: ADDON_ID_APIARY_CATTLE, planId: '2d1n_mining', label: 'Apicultura y ganaderia', pricePerPerson: 55000, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    const quote = calculatePriceQuote(exp, { planId: '2d1n_mining', people: 2, transportNeed: 'own', includeApiaryCattle: true });
    const quoteWithTransport = calculatePriceQuote(exp, { planId: '2d1n_mining', people: 4, transportNeed: 'from_bogota' });

    expect(quote?.total).toBe(1110000);
    expect(quoteWithTransport?.total).toBe(3700000);
  });

  it('returns integer-safe total when couple price is odd (5+ formula)', () => {
    const exp = getActiveExperience(loadSkills());
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550001, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000001, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    const quote = calculatePriceQuote(exp, { planId: '2d1n_mining', people: 5 });

    // (1000001 / 2) * 5 = 2500002.5 -> rounded to nearest peso.
    expect(quote?.planTotal).toBe(2500003);
    expect(Number.isInteger(quote?.planTotal)).toBe(true);
  });

  it('drops transport silently to plan-only if the remote addon key is renamed', () => {
    const exp = getActiveExperience(loadSkills());
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
        // Renamed away from ADDON_ID_PRIVATE_TRANSPORT — calculator can't find it.
        { id: 'transporte_privado', label: 'Transporte privado 4x4 desde Bogota', couplePrice: 1700000, peopleIncluded: 4, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };

    // Documents current behavior: with a renamed key, transport is not added.
    // The shared const guards against this in normal operation; this test pins
    // the failure mode so a future rename that breaks it is caught here.
    const quote = calculatePriceQuote(exp, { planId: '2d1n_mining', people: 2, transportNeed: 'from_bogota' });

    expect(quote?.transportTotal).toBeNull();
    expect(quote?.total).toBe(1000000);
  });
});
