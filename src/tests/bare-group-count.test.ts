import { describe, expect, it } from 'vitest';
import { extractBookingFields } from '../services/qualification-engine.js';

// Live 2026-11-18 (two-plan-narrow-quotes-both ES): "¿cuánto vale cada uno para 2?" left the
// group unknown. A bare count ending a price question is the group; a date or duration is not.
describe('bare group count in a price question', () => {
  it.each([
    ['Core y prime, cuanto vale cada uno para 2?', 2],
    ['¿Cuánto vale para 4?', 4],
    ['¿cuánto vale para 2 y qué incluye?', 2],
    ['How much for 2?', 2],
    ['how much for 2 and what is included?', 2],
    ['what is the price for 3 please', 3],
  ])('%s → %i people', (text, people) => {
    expect(extractBookingFields(text).collected_people).toBe(people);
  });

  it.each([
    '¿cuánto vale para el 2?',
    '¿cuánto vale para 2 de noviembre?',
    'precio para 2 noches',
    'how much for 2 days',
    'quiero ir para 2',
    '¿cuánto vale para 45?',
    'cuanto vale para 15 y 16 de noviembre',
    'precio para 2 y 3 de diciembre',
    'cuanto vale para 20 y 21',
    'how much for 2 and 3 nights?',
    'precio para 2 y mi mamá',
  ])('%s → no group', text => {
    expect(extractBookingFields(text).collected_people).toBeUndefined();
  });
});
