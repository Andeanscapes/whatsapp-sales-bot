import type { Skills, AndeanScapesSkill } from './skill-loader.js';
import { PRICING_NOT_AVAILABLE, AVAILABILITY_NOT_AVAILABLE } from './dynamic-data-service.js';

type Experience = AndeanScapesSkill['experiences'][number];

export type ActiveExperience = Experience;

export function getActiveExperience(skills: Skills): ActiveExperience {
  // Skill schema enforces experiences.min(1) at load time, so [0] is always defined.
  return skills.andeanScapes.experiences[0];
}

export function getPlans(exp: ActiveExperience): ActiveExperience['plans'] {
  return exp.plans;
}

export function getPricingItems(exp: ActiveExperience): ActiveExperience['pricing']['items'] {
  return exp.pricing.items;
}

export function getShortDescription(exp: ActiveExperience): string {
  return exp.shortDescription;
}

export function getCommonQuestions(exp: ActiveExperience): ActiveExperience['commonQuestions'] {
  return exp.commonQuestions;
}

export function isPricingAvailable(exp: ActiveExperience): boolean {
  return exp.pricing.items.length > 0 && !exp.pricing.botRules.includes(PRICING_NOT_AVAILABLE);
}

export function isAvailabilityAvailable(exp: ActiveExperience): boolean {
  return exp.availability.availableDates.length > 0 && exp.availability.botRule !== AVAILABILITY_NOT_AVAILABLE;
}
