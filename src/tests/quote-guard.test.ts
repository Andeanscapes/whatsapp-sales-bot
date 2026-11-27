import { beforeEach, describe, expect, it } from 'vitest';
import { loadSkills } from '../services/skill-loader.js';
import { getActiveExperience, getPlans, getPublicPaymentFactsForPlan } from '../services/product-registry.js';
import { findQuoteMismatches, type QuoteGuardContext } from '../services/quote-guard.js';
import { extractCopAmounts } from '../services/qualification-engine.js';
import { useAllSitesActive } from './helpers/all-sites-catalog.js';

// P0 2026-11-26: a figure the calculator cannot produce never reaches the customer.
beforeEach(() => {
  useAllSitesActive();
});

function context(siteId: string | null, peopleCounts: number[]): QuoteGuardContext {
  const skills = loadSkills();
  const exp = getActiveExperience(skills);
  return {
    planIds: getPlans(exp).map(plan => plan.id),
    preferredSiteId: siteId,
    peopleCounts,
    depositPercentFor: planId => getPublicPaymentFactsForPlan(skills, exp, planId).depositPercent,
  };
}

function mismatches(reply: string, siteId: string | null, people: number[], customerAmounts: number[] = []): number[] {
  return findQuoteMismatches(reply, getActiveExperience(loadSkills()), { ...context(siteId, people), customerAmounts }).map(m => m.amount);
}

describe('quote guard', () => {
  it.each([
    ['Para 3 personas, PRIME queda en $1.440.000 COP. ¿Les reviso cupo?', [1440000]],
    ['Para 4 personas el plan queda en $1.920.000 COP y con transporte $3.620.000 COP.', [1920000, 3620000]],
    ['For 3 people, PRIME comes to $1,440,000 COP.', [1440000]],
    ['Para 3 personas el plan PRIME queda en 1,44 millones.', [1440000]],
  ])('blocks the live P0 figures: %s', (reply, expected) => {
    expect(mismatches(reply, 'chivor', [1, 3, 4])).toEqual(expected);
  });

  it.each([
    'Para 3 personas, PRIME queda en $2.550.000 COP (equivalente $850.000 por persona). El transporte privado va aparte.',
    'Para 4 personas: plan $3.400.000 COP + transporte privado $1.700.000 COP por vehículo = $5.100.000 COP.',
    'For 4 people, the plan comes to $3,400,000 COP; with private transport, $5,100,000 COP.',
    'Viajando solo, PRIME queda en $960.000 COP; en pareja, $1.700.000 COP.',
  ])('lets correct figures through: %s', reply => {
    expect(mismatches(reply, 'chivor', [1, 3, 4])).toEqual([]);
  });

  it('binds a figure to the plan the sentence names: BASIC total under PRIME is blocked', () => {
    expect(mismatches('Para 3 personas, PRIME queda en $1.110.000 COP.', 'chivor', [3])).toEqual([1110000]);
    expect(mismatches('Para 3 personas, BASIC queda en $1.110.000 COP.', 'chivor', [3])).toEqual([]);
  });

  it('allows a legitimate comparison and the gap between two quoted totals', () => {
    const reply = 'Para 2 personas: CORE $950.000 COP y PRIME $1.700.000 COP. PRIME suma $750.000 COP por la segunda mina.';
    expect(mismatches(reply, 'chivor', [2])).toEqual([]);
  });

  it('accepts the deposit and the remaining balance of a correct total', () => {
    const skills = loadSkills();
    const pct = getPublicPaymentFactsForPlan(skills, getActiveExperience(skills), 'prime_2d1n_chivor').depositPercent ?? 0;
    const deposit = Math.round(2550000 * pct / 100);
    const reply = `Para 3 personas, PRIME queda en $2.550.000 COP. Anticipo: $${deposit.toLocaleString('es-CO')} COP; saldo $${(2550000 - deposit).toLocaleString('es-CO')} COP.`;
    expect(mismatches(reply, 'chivor', [3])).toEqual([]);
  });

  it('blocks the retired 550.000 per-person rate on a returning lead', () => {
    expect(mismatches('El CORE está en $550.000 COP por persona.', 'chivor', [])).toEqual([550000]);
    expect(mismatches('El CORE está en $550.000 COP por persona.', 'chivor', [2])).toEqual([550000]);
  });

  it('never reads dates, ages or group sizes as prices', () => {
    expect(mismatches('Para 3 personas el 28 de noviembre, con una niña de 7 años: lo valida el equipo.', 'chivor', [3])).toEqual([]);
    expect(extractCopAmounts('Somos 3, el 14 de noviembre de 2026')).toEqual([]);
  });

  it('reads COP in dots, commas, apostrophes and millions the same way', () => {
    expect(extractCopAmounts('$2.550.000 | $2,550,000 | 2\'550.000 | 2,55 millones | $2.55M')).toEqual([2550000, 2550000, 2550000, 2550000, 2550000]);
  });

  it('does not confuse a combined total with the plan subtotal', () => {
    // 5.100.000 is PRIME 4 + vehicle, never a plan-only total for 3.
    expect(mismatches('Para 3 personas, PRIME queda en $5.100.000 COP.', 'chivor', [3])).toEqual([5100000]);
    expect(mismatches('Para 4 personas, PRIME con transporte queda en $5.100.000 COP.', 'chivor', [4])).toEqual([]);
  });

  it('keeps another site out unless the turn allows it', () => {
    // Coscuez BASIC for 4 is 1.440.000: valid there, never for a Chivor quote.
    expect(mismatches('Para 4 personas, BASIC queda en $1.440.000 COP.', 'chivor', [4])).toEqual([1440000]);
    expect(mismatches('Para 4 personas, BASIC queda en $1.440.000 COP.', null, [4])).toEqual([]);
    expect(mismatches('En Coscuez, para 4 personas, BASIC queda en $1.440.000 COP.', 'chivor', [4])).toEqual([]);
  });

  it('reads couples as two travellers each and leaves mixed adult/child groups unbound', () => {
    expect(mismatches('Para una pareja con transporte privado, PRIME queda en $3.400.000 COP.', 'chivor', [1])).toEqual([]);
    expect(mismatches('For one couple, PRIME comes to $1,700,000 COP.', 'chivor', [1])).toEqual([]);
    expect(mismatches('Para dos parejas, PRIME queda en $3.400.000 COP.', 'chivor', [2])).toEqual([]);
    expect(mismatches('Para dos parejas, PRIME queda en $2.660.000 COP.', 'chivor', [2])).toEqual([2660000]);
    expect(mismatches('Para 2 adultos y 1 niño, PRIME queda en $2.550.000 COP.', 'chivor', [3])).toEqual([]);
  });

  it('lets a solo/couple rate list through on a group chat', () => {
    expect(mismatches('Individual $960.000 COP · en pareja $1.700.000 COP.', 'chivor', [3])).toEqual([]);
    expect(mismatches('El transporte privado cuesta $1.700.000 COP por vehículo.', 'chivor', [])).toEqual([]);
  });

  it('blocks the solo rate written as a group per-person price', () => {
    expect(mismatches('Para 3 personas, PRIME queda en $960.000 COP por persona.', 'chivor', [3])).toEqual([960000]);
    expect(mismatches('Para 3 personas, PRIME queda en $850.000 COP por persona.', 'chivor', [3])).toEqual([]);
    expect(mismatches('Viajando solo, PRIME queda en $960.000 COP.', 'chivor', [1])).toEqual([]);
  });

  it('allows an upsell gap phrased with "queda"', () => {
    expect(mismatches('El PRIME te queda $750.000 más que el CORE para 2 personas.', 'chivor', [2])).toEqual([]);
    expect(mismatches('El PRIME te queda $700.000 más que el CORE para 2 personas.', 'chivor', [2])).toEqual([700000]);
  });

  it('binds a sentence naming another site to that site', () => {
    expect(mismatches('En Coscuez, para 2 personas, PRIME queda en $2.270.000 COP.', 'chivor', [2])).toEqual([]);
    expect(mismatches('Para 2 personas, PRIME queda en $2.270.000 COP.', 'chivor', [2])).toEqual([2270000]);
  });

  it('reads spoken amounts so they cannot slip past the guard', () => {
    expect(extractCopAmounts('1 millón 440 mil | 620 mil | $620k | $1.4M')).toEqual([1440000, 620000, 620000, 1400000]);
    expect(mismatches('Para 3 personas PRIME queda en 1 millón 440 mil.', 'chivor', [3])).toEqual([1440000]);
  });

  it('lets the reply restate the customer\'s own budget, never echo it as a quote', () => {
    const budget = 'Con tu presupuesto de $1.500.000 COP, para 2 personas CORE queda en $950.000 COP.';
    expect(mismatches(budget, 'chivor', [2], [1500000])).toEqual([]);
    expect(mismatches('With a budget of $1,500,000 COP, for 2 people CORE comes to $950,000 COP.', 'chivor', [2], [1500000])).toEqual([]);
    expect(mismatches('Sí, para 3 personas PRIME queda en $1.440.000 COP.', 'chivor', [3], [1440000])).toEqual([1440000]);
    expect(mismatches(budget, 'chivor', [2])).toEqual([1500000]);
    for (const echo of ['Sí, el presupuesto queda en $1.440.000.', 'Sí, your total is $1.440.000.', 'Lo que tienes que pagar es $1.440.000.', 'Como dices, son $1.440.000 para los 3.']) {
      expect(mismatches(echo, 'chivor', [3], [1440000]), echo).toEqual([1440000]);
    }
  });

  it('gives no automatic total above the catalog cap', () => {
    expect(mismatches('Para 11 personas, PRIME queda en $9.350.000 COP.', 'chivor', [11])).toEqual([9350000]);
  });
});
