import type { Skills, AndeanScapesSkill } from './skill-loader.js';

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

export function getRoute(exp: ActiveExperience): Record<string, unknown> {
  return exp.route;
}
