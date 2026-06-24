import { describe, it, expect, beforeAll } from 'vitest';
import { loadSkills } from '../services/skill-loader.js';
import { extractBookingFields, isCorrectionMessage } from '../services/qualification-engine.js';

describe('extractBookingFields — people detection', () => {
  beforeAll(() => {
    loadSkills();
  });

  it.each([
    'mi mamá y yo',
    'mi mama y yo',
    'mi madre y yo',
    'mi made y yo',
  ])('detects 2 people from "%s"', (text) => {
    expect(extractBookingFields(text).collected_people).toBe(2);
  });

  it.each([
    'Somos tree personas yo y mis dos amantes',
    'somos tree',
    'tree personas',
    'Somos tres',
    'somos tres personas',
    'somos 3',
  ])('detects 3 people from "%s"', (text) => {
    expect(extractBookingFields(text).collected_people).toBe(3);
  });
});

describe('isCorrectionMessage', () => {
  it.each([
    'Ya te dine que somos tres',
    'ya te dige que somos tres',
    'ya te dije',
    'ya te mencioné',
    'ya lo he dicho',
  ])('detects correction from "%s"', (text) => {
    expect(isCorrectionMessage(text)).toBe(true);
  });

  it.each([
    'Hola como estas',
    'cuanto cuesta',
    'somos 3 personas',
  ])('does not flag "%s" as correction', (text) => {
    expect(isCorrectionMessage(text)).toBe(false);
  });
});
