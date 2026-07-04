import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../services/deepseek-client.js';
import { loadSkills, type Skills } from '../services/skill-loader.js';
import { AVAILABILITY_NOT_AVAILABLE, PRICING_NOT_AVAILABLE } from '../services/dynamic-data-service.js';

describe('buildSystemPrompt', () => {
  it('injects sales tactics from skill data', () => {
    const skills = loadSkills();
    const prompt = buildSystemPrompt(skills);

    expect(prompt).toContain(`Customer-first selling: ${skills.salesStrategy.salesTactics.customerFirstSelling}`);
    expect(prompt).toContain(`Micro-question flow: ${skills.salesStrategy.salesTactics.microQuestionFlow}`);
    expect(prompt).toContain(`Invisible qualification: ${skills.salesStrategy.salesTactics.invisibleQualification}`);
  });

  it('keeps unavailable pricing and availability guard ahead of sales tactics', () => {
    const skills = withUnavailablePricingAndAvailability(loadSkills());
    const prompt = buildSystemPrompt(skills);

    const guardIndex = prompt.indexOf('[CRITICAL RULE] NO hay precios ni fechas disponibles');
    const priceContextIndex = prompt.indexOf('Price with context:');
    const salesTacticsIndex = prompt.indexOf('Sales attitude:');

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(priceContextIndex).toBe(-1);
    expect(salesTacticsIndex).toBeGreaterThan(guardIndex);
  });

  it('surfaces durable business rules even when pricing is unavailable', () => {
    const skills = withUnavailablePricingAndAvailability(loadSkills());
    const prompt = buildSystemPrompt(skills);

    // Numbers are gone (no price values) but the durable business rules must
    // still reach the model so it honors cancellation / addon / no-invent rules.
    expect(prompt).toContain('Business rules:');
    expect(prompt).toContain('Cancelacion/reagendamiento: maximo 2 veces');
    expect(prompt).toContain('Nunca inventes descuentos');
    // No hardcoded price VALUES leak from the static skill.
    expect(prompt).not.toMatch(/\$?\s?1,040,000/);
    expect(prompt).not.toMatch(/\$?\s?550,000/);
  });

  it('merges static business rules alongside dynamic pricing rules when available', () => {
    // Default loadSkills has no dynamic service, so pricing is unavailable and
    // botRules holds only the sentinel. Simulate the merged runtime shape.
    const skills = loadSkills();
    const exp = skills.andeanScapes.experiences[0];
    const orig = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1040000, peopleIncluded: 2, publiclyShow: true },
      ],
      // Runtime merge = remote rules + static businessRules (see applyDynamicToExperiences).
      botRules: ['REMOTE: 15% deposito via Nequi o Mercado Pago', ...orig.businessRules],
      businessRules: orig.businessRules,
    };
    try {
      const prompt = buildSystemPrompt(skills);
      expect(prompt).toContain('Pricing rules:');
      expect(prompt).toContain('REMOTE: 15% deposito');
      // Static business rule is applied alongside the remote rule.
      expect(prompt).toContain('5+ personas');
      // Not duplicated as a standalone "Business rules:" line when pricing available.
      expect(prompt).not.toContain('Business rules:');
    } finally {
      exp.pricing = orig;
    }
  });
});

function withUnavailablePricingAndAvailability(skills: Skills): Skills {
  return {
    ...skills,
    andeanScapes: {
      ...skills.andeanScapes,
      experiences: skills.andeanScapes.experiences.map((experience, index) =>
        index === 0
          ? {
              ...experience,
              pricing: {
                ...experience.pricing,
                items: [],
                botRules: [PRICING_NOT_AVAILABLE],
              },
              availability: {
                ...experience.availability,
                availableDates: [],
                botRule: AVAILABILITY_NOT_AVAILABLE,
              },
            }
          : experience
      ),
    },
  };
}
