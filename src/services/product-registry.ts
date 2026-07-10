import type { Skills, AndeanScapesSkill } from './skill-loader.js';
import { PRICING_NOT_AVAILABLE, AVAILABILITY_NOT_AVAILABLE } from './dynamic-data-service.js';
import type { InternalPlanImage, InternalGalleryImage, InternalPaymentData } from './dynamic-data-service.js';

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

export function getOwnerImage(skills: Skills): { url: string; caption: string } | null {
  return skills.dynamicMedia?.ownerImage ?? null;
}

export function getDynamicPlanImages(skills: Skills): InternalPlanImage[] {
  return skills.dynamicMedia?.planImages ?? [];
}

export function getGalleryImages(skills: Skills): InternalGalleryImage[] {
  return skills.dynamicMedia?.galleryImages ?? [];
}

export function getPaymentInfo(skills: Skills): InternalPaymentData | null {
  return skills.dynamicData?.payments ?? null;
}

export interface PublicPaymentFacts {
  depositPercent: number;
  methodNames: string[];
}

export function getPublicPaymentFacts(skills: Skills): PublicPaymentFacts {
  const payments = skills.dynamicData?.payments ?? null;
  if (payments) {
    const methodNames = payments.methods.filter(m => m.enabled).map(m => m.name);
    if (methodNames.length > 0) {
      return { depositPercent: payments.deposit.value, methodNames };
    }
  }
  return skills.andeanScapes.business.publicPaymentFallback;
}
