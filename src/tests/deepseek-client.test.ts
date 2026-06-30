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
