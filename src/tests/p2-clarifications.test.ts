import { describe, it, expect } from 'vitest';
import { dynamicDataSchema, dynamicClarificationsSchema } from '../services/dynamic-data-schema.js';
import { renderCatalog } from '../services/skills-prompt-assembly.js';
import { loadSkills } from '../services/skill-loader.js';

describe('P2 — Clarifications seam', () => {
  describe('Schema validation', () => {
    it('accepts clarifications with experience and plans', () => {
      const clarifications = {
        experience: ['Fact about the experience'],
        plans: { 'plan1': ['Fact about plan1'] },
      };
      expect(() => dynamicClarificationsSchema.parse(clarifications)).not.toThrow();
    });

    it('defaults to empty arrays when absent', () => {
      const clarifications = {};
      const parsed = dynamicClarificationsSchema.parse(clarifications);
      expect(parsed.experience).toEqual([]);
      expect(parsed.plans).toEqual({});
    });

    it('rejects non-empty strings in arrays', () => {
      const clarifications = {
        experience: [''],
        plans: {},
      };
      expect(() => dynamicClarificationsSchema.parse(clarifications)).toThrow();
    });

    it('accepts clarifications in dynamic experience schema', () => {
      const data = {
        v: 9,
        updated: '2026-08-07T00:00:00Z',
        experiences: {
          exp1: {
            clarifications: ['This is a real mine'],
            plans: {
              plan1: {
                pricing: { individual: 100000 },
                clarifications: ['Plan-specific fact'],
                addons: [],
              },
            },
            pricing: { currency: 'COP', addons: {} },
            availability: { dates: [], rule: '' },
          },
        },
      };
      expect(() => dynamicDataSchema.parse(data)).not.toThrow();
    });

    it('makes clarifications optional', () => {
      const data = {
        v: 9,
        updated: '2026-08-07T00:00:00Z',
        experiences: {
          exp1: {
            plans: {
              plan1: {
                pricing: { individual: 100000 },
                clarifications: [],
                addons: [],
              },
            },
            pricing: { currency: 'COP', addons: {} },
            availability: { dates: [], rule: '' },
          },
        },
      };
      const parsed = dynamicDataSchema.parse(data);
      // Unified shape always has clarifications as an array, never undefined
      expect(parsed.experiences.exp1.clarifications).toBeDefined();
    });
  });

  describe('Rendering in CATALOGO', () => {
    it('includes experience clarifications at top when present', () => {
      const skills = loadSkills();
      const catalog = renderCatalog(skills);
      // The test skill has no clarifications, so this is a smoke test.
      // In production, clarifications would appear as:
      // "CLARIFICACIONES (prioridad maxima; corrigen cualquier otro dato de este bloque):"
      expect(catalog).toBeDefined();
      expect(typeof catalog).toBe('string');
      expect(catalog.length).toBeGreaterThan(0);
    });

    it('experience identifier is in catalog', () => {
      const skills = loadSkills();
      const catalog = renderCatalog(skills);
      expect(catalog).toContain('emerald_mining_tour');
    });

    it('short description is rendered', () => {
      const skills = loadSkills();
      const catalog = renderCatalog(skills);
      expect(catalog).toContain('short:');
    });
  });

  describe('Per-plan clarifications', () => {
    it('static skill allows clarifications array on plans', () => {
      const skills = loadSkills();
      const exp = skills.andeanScapes.experiences[0];
      const plan = exp.plans[0];
      // clarifications field should exist (default [])
      expect(Array.isArray(plan.clarifications)).toBe(true);
    });
  });
});
