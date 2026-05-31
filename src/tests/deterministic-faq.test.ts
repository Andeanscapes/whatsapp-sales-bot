import { describe, it, expect, beforeAll } from 'vitest';
import { loadSkills } from '../services/skill-loader.js';
import { findIntent } from '../services/deterministic-faq.js';
import type { Skills } from '../services/skill-loader.js';

let skills: Skills;

beforeAll(() => {
  skills = loadSkills();
});

describe('findIntent English', () => {
  it('matches transport question', () => {
    const result = findIntent('Can you help with transport from Bogotá?', skills, 'en');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('transport');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('matches activities question', () => {
    const result = findIntent('What activities are included?', skills, 'en');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('activities');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('matches reservation question', () => {
    const result = findIntent('How do I reserve?', skills, 'en');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('reservation');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('detects price intent in English', () => {
    const result = findIntent('How much is the emerald mining tour?', skills, 'en');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('pricing');
    expect(result!.answer).toContain('Reference prices');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('returns null for unknown text', () => {
    const result = findIntent('The weather is nice today', skills, 'en');
    expect(result).toBeNull();
  });
});

describe('findIntent Spanish', () => {
  it('matches transport in Spanish', () => {
    const result = findIntent('¿Pueden ayudar con transporte desde Bogotá?', skills, 'es');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('transport');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('matches reservation in Spanish', () => {
    const result = findIntent('¿Cómo reservo?', skills, 'es');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('reservation');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('matches activities in Spanish', () => {
    const result = findIntent('¿Qué actividades incluye?', skills, 'es');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('activities');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('detects price intent in Spanish', () => {
    const result = findIntent('¿Cuánto vale el tour de esmeraldas?', skills, 'es');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('pricing');
    expect(result!.answer).toContain('550');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('detects Spanish without explicit lang', () => {
    const result = findIntent('Cuales son los precios?', skills);
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('pricing');
    expect(result!.answer).toContain('550');
  });

  it('detects English without explicit lang', () => {
    const result = findIntent('What are the prices?', skills);
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('pricing');
    expect(result!.answer).toContain('Reference prices');
  });

  it('detects availability intent in Spanish', () => {
    const result = findIntent('¿Hay fechas disponibles en junio?', skills, 'es');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('availability');
    expect(result!.answer).toContain('Fechas planeadas');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('filters English questions for Spanish lang', () => {
    const result = findIntent('Where is the meeting point?', skills, 'es');
    expect(result).toBeNull();
  });

  it('returns null for unknown Spanish text', () => {
    const result = findIntent('El clima está agradable hoy', skills, 'es');
    expect(result).toBeNull();
  });
});
