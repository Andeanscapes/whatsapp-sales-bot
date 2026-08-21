import { describe, expect, it } from 'vitest';
import { calculatePriceQuote } from '../../services/pricing-calculator.js';
import { getActiveExperience } from '../../services/product-registry.js';
import { getSkills, loadSkills } from '../../services/skill-loader.js';
import { evaluateScenario } from './evaluate-scenario.js';
import { scenarioSchema } from './schema.js';
import type { TurnRecord } from './runner.js';

function turn(user: string, reply: string, turnNumber = 1): TurnRecord {
  return {
    turnNumber,
    user,
    reply,
    processOutput: {
      reply,
      shouldSendReply: true,
      leadScore: 0,
      usedAi: true,
      shouldAlertOwner: false,
      shouldSendImage: false,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      priceJustGiven: false,
    },
  };
}

function scenario(criteria: unknown) {
  return scenarioSchema.parse({
    id: 'criterion-test',
    lang: 'es',
    turns: [{ user: 'hola', mockReply: 'hola' }],
    criteria,
  });
}

describe('conversation criteria', () => {
  it('fails a date re-ask after a month window', () => {
    const result = evaluateScenario(
      scenario([{ id: 'date', rule: 'known_field_not_reasked', field: 'date', suppliedTurn: 1, weight: 1, critical: true }]),
      [turn('Sería para agosto, sin fecha definida', '¿Tienen alguna fecha tentativa?', 1)],
    );
    expect(result.score).toBe(0);
    expect(result.hardFail).toBe(true);
  });

  it('does not treat a date acknowledgement as a re-ask', () => {
    const result = evaluateScenario(
      scenario([{ id: 'date', rule: 'known_field_not_reasked', field: 'date', suppliedTurn: 1, weight: 1, critical: true }]),
      [turn('Sería para finales de agosto', 'Qué bien, pareja con fecha tentativa. Agosto es una época bonita para ir.', 1)],
    );
    expect(result.score).toBe(100);
    expect(result.hardFail).toBe(false);
  });

  it('fails when a required known field turn is missing', () => {
    const result = evaluateScenario(
      scenario([{ id: 'date', rule: 'known_field_not_reasked', field: 'date', suppliedTurn: 2, weight: 1, critical: true }]),
      [turn('Hola', 'Hola', 1)],
    );
    expect(result.hardFail).toBe(true);
  });

  it('requires both caveats only above ten people', () => {
    const criteria = [
      { id: 'date', rule: 'big_group_date_validation', threshold: 10, weight: 1, critical: true },
      { id: 'price', rule: 'big_group_price_review', threshold: 10, weight: 1, critical: true },
    ];
    expect(evaluateScenario(scenario(criteria), [turn('Somos 10 personas', 'Perfecto, revisamos opciones.')]).score).toBe(100);
    expect(evaluateScenario(scenario(criteria), [turn('Somos 11 personas', 'Perfecto, revisamos opciones.')]).score).toBe(0);
  });

  it('does not treat a co-founder intro as customer addressing', () => {
    const input = scenario([{ id: 'name', rule: 'partner_name_not_customer_name', weight: 1, critical: true }]);
    expect(evaluateScenario(input, [turn('Hola', 'Soy AgentA, co-fundador de Andean Scapes junto con PartnerA.')]).score).toBe(100);
    expect(evaluateScenario(input, [turn('Hola', 'Soy AgentA, co-fundador de Andean Scapes junto con PartnerA.', 1), turn('Precio', 'PartnerA, te cuento.', 2)]).score).toBe(0);
  });

  it('passes an exact group quote from the product registry', () => {
    loadSkills();
    const quote = calculatePriceQuote(getActiveExperience(getSkills()), {
      planId: '2d1n_mining',
      people: 4,
      transportNeed: 'own',
    });
    const expectedTotal = quote?.planTotal;
    expect(expectedTotal).toBeTypeOf('number');
    const formatted = expectedTotal!.toLocaleString('en-US');
    const input = scenario([{ id: 'quote', rule: 'group_quote_integrity', people: 4, planId: '2d1n_mining', expectedTotal, weight: 1, critical: true }]);
    expect(evaluateScenario(input, [turn('Somos 4', `Para 4 personas, el valor total es $${formatted} COP.`)]).score).toBe(100);
  });

  it('fails a quote for the wrong group size', () => {
    loadSkills();
    const quote = calculatePriceQuote(getActiveExperience(getSkills()), {
      planId: '2d1n_mining',
      people: 4,
      transportNeed: 'own',
    });
    const expectedTotal = quote?.planTotal ?? 0;
    const input = scenario([{ id: 'quote', rule: 'group_quote_integrity', people: 4, planId: '2d1n_mining', expectedTotal, weight: 1, critical: true }]);
    expect(evaluateScenario(input, [turn('Somos 4', 'Para 2 personas, el valor total es $1,000,000 COP.')]).hardFail).toBe(true);
  });

  it('fails when a quote includes both a wrong and the expected total', () => {
    loadSkills();
    const quote = calculatePriceQuote(getActiveExperience(getSkills()), {
      planId: '2d1n_mining',
      people: 5,
      transportNeed: 'own',
    });
    const expectedTotal = quote?.planTotal ?? 0;
    const input = scenario([{ id: 'quote', rule: 'group_quote_integrity', people: 5, planId: '2d1n_mining', expectedTotal, weight: 1, critical: true }]);

    expect(evaluateScenario(input, [turn('Somos 5', `Antes $2.500.000. Para 5 personas son $${expectedTotal.toLocaleString('en-US')} COP.`)]).hardFail).toBe(true);
  });

  it('enforces max question marks', () => {
    const input = scenario([{ id: 'q', rule: 'max_question_marks', max: 1, weight: 1, critical: true }]);
    expect(evaluateScenario(input, [turn('Hola', 'Incluye X. ¿Cuántas personas?')]).score).toBe(100);
    expect(evaluateScenario(input, [turn('Hola', '¿A? ¿B?')]).hardFail).toBe(true);
  });

  it('allows a starting price before qualification but rejects an exact price', () => {
    const input = scenario([{ id: 'price', rule: 'price_after_min_fields', minFields: 2, weight: 1, critical: true }]);
    expect(evaluateScenario(input, [turn('Hola', 'Tenemos opciones desde $550,000 COP. ¿Sería para ti solo, en pareja o para un grupo?')]).score).toBe(100);
    expect(evaluateScenario(input, [turn('Hola', 'Tenemos opciones desde $550,000. ¿Sería para ti solo, en pareja o para un grupo?')]).score).toBe(100);
    expect(evaluateScenario(input, [turn('Hola', 'El valor es $550,000 COP.')]).hardFail).toBe(true);
    expect(evaluateScenario(input, [turn('Hola', 'El valor es $550,000.')]).hardFail).toBe(true);
    expect(evaluateScenario(input, [turn('Hola', 'Tenemos opciones desde $550,000 COP, pero el total es $1,000,000.')]).hardFail).toBe(true);
  });

  it('counts every real media output flag', () => {
    const input = scenario([{ id: 'media', rule: 'output_count_at_most', output: 'media', expected: 0, weight: 1, critical: true }]);
    const image = turn('foto', 'ok');
    image.processOutput.shouldSendImage = true;
    const owner = turn('hola', 'ok');
    owner.processOutput.shouldSendOwnerImage = true;
    const gallery = turn('fotos', 'ok');
    gallery.processOutput.shouldSendGalleryImages = true;
    expect(evaluateScenario(input, [image]).hardFail).toBe(true);
    expect(evaluateScenario(input, [owner]).hardFail).toBe(true);
    expect(evaluateScenario(input, [gallery]).hardFail).toBe(true);
  });

  it('supports output_flag_not_equals and conversationMode', () => {
    const record = turn('Hola', 'ok');
    record.processOutput.conversationMode = 'human_pending';
    record.processOutput.salesPhase = 'closing';
    const equals = scenario([{ id: 'mode', rule: 'output_flag_equals', flag: 'conversationMode', expected: 'human_pending', weight: 1, critical: true }]);
    const notEquals = scenario([{ id: 'phase', rule: 'output_flag_not_equals', flag: 'salesPhase', expected: 'booked', weight: 1, critical: true }]);
    expect(evaluateScenario(equals, [record]).score).toBe(100);
    expect(evaluateScenario(notEquals, [record]).score).toBe(100);
  });
});
