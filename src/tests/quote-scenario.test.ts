import { describe, expect, it } from 'vitest';
import { detectQuoteScenario, extractBookingFields } from '../services/qualification-engine.js';

// P0 2026-11-26: group sizes asked mid-chat were not read, so the model priced them alone.
describe('group size extraction for quotes', () => {
  it.each([
    ['¿cuánto para 3? ¿incluye transporte?', 3],
    ['¿Total para 4 con transporte y todo?', 4],
    ['para 4 con transporte y todo', 4],
    ['how much for 3 including transport?', 3],
    ['Empareja por ahora', 2],
    ['vamos dos parejas', 4],
    ['somos 3 parejas', 6],
  ])('reads %s as %i travellers', (message, people) => {
    expect(extractBookingFields(message).collected_people).toBe(people);
  });

  it.each([
    'una o dos parejas',
    'en pareja o dos parejas',
    'para el 3 de diciembre cuánto vale?',
    'cuanto vale para 2 noches',
  ])('stores no group size for %s', message => {
    expect(extractBookingFields(message).collected_people).toBeUndefined();
  });
});

describe('detectQuoteScenario', () => {
  it('quotes a different size asked as a question without replacing the stored one', () => {
    expect(detectQuoteScenario('¿cuánto para 3? ¿incluye transporte?', 3, 1))
      .toEqual({ people: [3], hypothetical: true, transportAsked: true });
    expect(detectQuoteScenario('¿y si somos 4?', 4, 3)).toEqual({ people: [4], hypothetical: true, transportAsked: false });
    expect(detectQuoteScenario('¿Total para 4 con transporte y todo?', 4, 1)?.people).toEqual([4]);
  });

  it('reads "Sí, somos 4" (accent dropped) as a change, "y si somos 4" as a what-if', () => {
    expect(detectQuoteScenario('Si, somos 4 ahora', 4, 2)).toBeNull();
    expect(detectQuoteScenario('si somos 4 cuanto?', 4, 2)).toBeNull();
    expect(detectQuoteScenario('y si somos 4?', 4, 2)?.hypothetical).toBe(true);
    expect(detectQuoteScenario('¿cuánto si fuéramos 5?', 5, 2)?.hypothetical).toBe(true);
  });

  it('lets a declared change replace the stored size', () => {
    expect(detectQuoteScenario('al final somos 4', 4, 3)).toBeNull();
    expect(detectQuoteScenario('somos 4, cuánto sería?', 4, 3)).toBeNull();
  });

  it('quotes both sizes when the customer names two', () => {
    expect(detectQuoteScenario('precio para solo o pareja?', null, null)?.people).toEqual([1, 2]);
    expect(detectQuoteScenario('una o dos parejas', null, null)?.people).toEqual([2, 4]);
    expect(detectQuoteScenario('seríamos 3 o 4 personas', null, null)?.people).toEqual([3, 4]);
  });

  it('leaves a transport-only question and a booking turn to the normal flow', () => {
    expect(detectQuoteScenario('¿eso incluye transporte?', null, 3)).toBeNull();
    expect(detectQuoteScenario('si, con transporte, reservamos el 14', null, 2)).toBeNull();
    expect(detectQuoteScenario('vamos sin transporte, en carro', null, 2)).toBeNull();
  });

  it('stores a size that answers the bot\'s group question, even asked as a question', () => {
    expect(detectQuoteScenario('Para 4 personas cuanto?', 4, 2, true)).toBeNull();
  });

  it('never treats the local 4x4 as private transport', () => {
    expect(detectQuoteScenario('¿Y el 4x4 local sale desde el pueblo?', null, 2)).toBeNull();
  });

  it('is silent when nothing changes', () => {
    expect(detectQuoteScenario('¿qué fechas tienen?', null, 2)).toBeNull();
    expect(detectQuoteScenario('¿cuánto para 2?', 2, 2)).toBeNull();
  });
});
