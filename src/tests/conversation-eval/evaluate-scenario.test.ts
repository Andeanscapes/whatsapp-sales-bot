import { describe, expect, it } from 'vitest';
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
    const input = scenario([{ id: 'quote', rule: 'group_quote_integrity', people: 4, planId: '2d1n_mining', expectedTotal: 2000000, weight: 1, critical: true }]);
    expect(evaluateScenario(input, [turn('Somos 4', 'Para 4 personas, el valor total es $2,000,000 COP.')]).score).toBe(100);
  });

  it('fails a quote for the wrong group size', () => {
    const input = scenario([{ id: 'quote', rule: 'group_quote_integrity', people: 4, planId: '2d1n_mining', expectedTotal: 2000000, weight: 1, critical: true }]);
    expect(evaluateScenario(input, [turn('Somos 4', 'Para 2 personas, el valor total es $1,000,000 COP.')]).hardFail).toBe(true);
  });

  it('enforces max question marks', () => {
    const input = scenario([{ id: 'q', rule: 'max_question_marks', max: 1, weight: 1, critical: true }]);
    expect(evaluateScenario(input, [turn('Hola', 'Incluye X. ¿Cuántas personas?')]).score).toBe(100);
    expect(evaluateScenario(input, [turn('Hola', '¿A? ¿B?')]).hardFail).toBe(true);
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
