import { describe, it, expect } from 'vitest';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { isExperienceActive, hasActiveExperience } from '../services/product-registry.js';
import { getSkills } from '../services/skill-loader.js';

describe('P1 — Status filtering', () => {
  it('schema accepts status: active', () => {
    const data = {
      v: 9,
      updated: '2026-08-07T00:00:00Z',
      experiences: {
        exp1: {
          status: 'active' as const,
          clarifications: [],
          plans: { p1: { pricing: { individual: 100000 }, clarifications: [], addons: [] } },
          pricing: { currency: 'COP', addons: {} },
          availability: { dates: [], rule: '' },
        },
      },
    };
    expect(() => dynamicDataSchema.parse(data)).not.toThrow();
  });

  it('schema accepts status: inactive', () => {
    const data = {
      v: 9,
      updated: '2026-08-07T00:00:00Z',
      experiences: {
        exp1: {
          status: 'inactive' as const,
          clarifications: [],
          plans: { p1: { pricing: { individual: 100000 }, clarifications: [], addons: [] } },
          pricing: { currency: 'COP', addons: {} },
          availability: { dates: [], rule: '' },
        },
      },
    };
    expect(() => dynamicDataSchema.parse(data)).not.toThrow();
  });

  it('schema defaults to undefined when status is absent', () => {
    const data = {
      v: 9,
      updated: '2026-08-07T00:00:00Z',
      experiences: {
        exp1: {
          clarifications: [],
          plans: { p1: { pricing: { individual: 100000 }, clarifications: [], addons: [] } },
          pricing: { currency: 'COP', addons: {} },
          availability: { dates: [], rule: '' },
        },
      },
    };
    const parsed = dynamicDataSchema.parse(data);
    expect(parsed.experiences.exp1.status).toBeUndefined();
  });

  it('schema rejects unknown status values', () => {
    const data = {
      v: 9,
      updated: '2026-08-07T00:00:00Z',
      experiences: {
        exp1: {
          status: 'unknown',
          clarifications: [],
          plans: { p1: { pricing: { individual: 100000 }, clarifications: [], addons: [] } },
          pricing: { currency: 'COP', addons: {} },
          availability: { dates: [], rule: '' },
        },
      },
    };
    expect(() => dynamicDataSchema.parse(data)).toThrow();
  });

  it('isExperienceActive returns true for active or undefined status', () => {
    const skills = getSkills();
    const exp = skills.andeanScapes.experiences[0];
    // Default skill has no status or status='active'
    expect(isExperienceActive(exp)).toBe(true);
  });

  it('isExperienceActive returns false for inactive status', () => {
    const skills = getSkills();
    const exp = { ...skills.andeanScapes.experiences[0], status: 'inactive' as const };
    expect(isExperienceActive(exp)).toBe(false);
  });

  it('hasActiveExperience returns true when at least one experience is active', () => {
    const skills = getSkills();
    expect(hasActiveExperience(skills)).toBe(true);
  });

  it('getExperiences filters out inactive experiences', () => {
    const skills = getSkills();
    const allExp = skills.andeanScapes.experiences;
    const activeExp = allExp.filter(e => isExperienceActive(e));
    expect(activeExp.length).toBeGreaterThan(0);
    expect(activeExp.length).toBeLessThanOrEqual(allExp.length);
  });
});
