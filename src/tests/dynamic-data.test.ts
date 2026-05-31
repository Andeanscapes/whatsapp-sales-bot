import { describe, expect, it } from 'vitest';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { shouldStripStaticPricing } from '../services/dynamic-data-service.js';
import { loadSkills } from '../services/skill-loader.js';

describe('dynamic data validation', () => {
  it('rejects unknown fields', () => {
    const data = {
      v: 1,
      updated: '2026-05-30T00:00:00Z',
      extra: true,
      experiences: {},
    };

    expect(() => dynamicDataSchema.parse(data)).toThrow();
  });

  it('strips static pricing only when dynamic URL is configured and unavailable', () => {
    expect(shouldStripStaticPricing('', false)).toBe(false);
    expect(shouldStripStaticPricing('https://cdn.andeanscapes.com/bot/bot-dynamic.json', false)).toBe(true);
    expect(shouldStripStaticPricing('https://cdn.andeanscapes.com/bot/bot-dynamic.json', true)).toBe(false);
  });

  it('keeps static pricing when no dynamic service is configured', () => {
    const skills = loadSkills();
    expect(skills.andeanScapes.experiences[0].pricing.items.length).toBeGreaterThan(0);
  });
});
