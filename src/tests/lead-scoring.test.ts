import { describe, it, expect, beforeAll } from 'vitest';
import { loadSkills } from '../services/skill-loader.js';
import { scoreMessage } from '../services/lead-scoring.js';
import type { Skills } from '../services/skill-loader.js';

let skills: Skills;

beforeAll(() => {
  skills = loadSkills();
});

describe('scoreMessage', () => {
  it('scores availability keywords', () => {
    const result = scoreMessage('Is June 8 available?', skills);
    expect(result.score).toBeGreaterThan(0);
    expect(result.signals).toContain('asks_availability');
  });

  it('scores group size keywords', () => {
    const result = scoreMessage('We are 2 people', skills);
    expect(result.score).toBeGreaterThan(0);
    expect(result.signals).toContain('shares_group_size');
  });

  it('scores reservation keywords', () => {
    const result = scoreMessage('I want to book a tour', skills);
    expect(result.score).toBeGreaterThan(0);
    expect(result.signals).toContain('asks_reservation');
  });

  it('applies negative signals', () => {
    const result = scoreMessage('Just looking for now', skills);
    expect(result.signals).toContain('only_browsing');
  });

  it('caps score at maxScore', () => {
    const highIntentText = 'I want to reserve June 8 for 2 people and need transport from Bogotá. How much does it cost?';
    const result = scoreMessage(highIntentText, skills);
    expect(result.score).toBeLessThanOrEqual(skills.salesStrategy.maxScore);
  });

  it('returns score 0 for neutral text', () => {
    const result = scoreMessage('Hello', skills);
    expect(result.score).toBe(0);
    expect(result.signals).toHaveLength(0);
  });
});
