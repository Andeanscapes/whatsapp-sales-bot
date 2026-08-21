import { describe, it, expect, beforeAll } from 'vitest';
import { loadSkills } from '../services/skill-loader.js';
import { computeAnalyzerFallbackScore, computeHybridScore, scoreMessage } from '../services/lead-scoring.js';
import type { Skills } from '../services/skill-loader.js';

let skills: Skills;

beforeAll(() => {
  skills = loadSkills();
});

describe('scoreMessage', () => {
  it('uses 90 as hot lead threshold', () => {
    expect(skills.salesStrategy.hotLeadThreshold).toBe(90);
  });

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

  it('scores normal keyword inflections without substring false positives', () => {
    expect(scoreMessage('Que precios tienen?', skills).signals).toContain('asks_price');
    expect(scoreMessage('Que fechas estan disponibles?', skills).signals).toContain('asks_availability');
    expect(scoreMessage('Como puedo reservarlo?', skills).signals).toContain('asks_reservation');
  });

  it('scores month, solo traveler, and bus transport signals', () => {
    expect(scoreMessage('para finales de agosto', skills).signals).toContain('shares_specific_date');
    expect(scoreMessage('estaria sola', skills).signals).toContain('shares_group_size');
    expect(scoreMessage('iria en bus desde salitre', skills).signals).toContain('asks_transport');
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

  it('does not match price objection inside a customer name', () => {
    const result = scoreMessage('Soy Carolina', skills);
    expect(result.signals).not.toContain('price_objection');
    expect(scoreMessage('I like the costume', skills).signals).not.toContain('asks_price');
  });

  it('does not score explicitly negated reservation intent as positive', () => {
    const result = scoreMessage('No me interesa reservar', skills);
    expect(result.signals).not.toContain('asks_reservation');
    expect(result.score).toBeLessThanOrEqual(0);
  });
});

describe('computeAnalyzerFallbackScore', () => {
  it('keeps a neutral score unchanged while the analyzer is unavailable', () => {
    expect(computeAnalyzerFallbackScore(50, 0, false)).toBe(50);
    expect(computeAnalyzerFallbackScore(95, 0, false)).toBe(95);
  });

  it('allows positive regex backup and re-engagement bumps without decay', () => {
    expect(computeAnalyzerFallbackScore(50, 20, false)).toBe(54);
    expect(computeAnalyzerFallbackScore(10, 0, true)).toBe(25);
  });

  it('applies a conservative negative signal during analyzer outages', () => {
    expect(computeAnalyzerFallbackScore(95, -15, false, 90)).toBe(92);
  });
});

describe('computeHybridScore', () => {
  it('does not apply the growth cap as an immediate high-score downgrade', () => {
    const result = computeHybridScore(95, {
      intent: 'curious', scoreDelta: 0, confidence: 1, buyingSignals: [], blockers: [],
    }, 0, false, 90);
    expect(result.score).toBe(93);
  });

  it('does not add idle decay on top of a blocker penalty', () => {
    const result = computeHybridScore(50, {
      intent: 'not_interested', scoreDelta: -5, confidence: 1,
      buyingSignals: [], blockers: ['price'],
    }, 0, false, 90);
    expect(result.score).toBe(45);
  });

  it('does not downgrade an existing hot score on a positive non-booking turn', () => {
    const result = computeHybridScore(95, {
      intent: 'curious', scoreDelta: 5, confidence: 1,
      buyingSignals: ['itinerary'], blockers: [],
    }, 0, false, 90);
    expect(result.score).toBe(100);
  });
});
