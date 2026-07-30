import type { Skills, AndeanScapesSkill } from './skill-loader.js';
import { PRICING_NOT_AVAILABLE, AVAILABILITY_NOT_AVAILABLE } from './dynamic-data-service.js';
import type { InternalPlanImage, InternalGalleryImage, InternalPaymentData } from './dynamic-data-service.js';

type Experience = AndeanScapesSkill['experiences'][number];

export type ActiveExperience = Experience;

export function getActiveExperience(skills: Skills): ActiveExperience {
  // Skill schema enforces experiences.min(1) at load time, so [0] is always defined.
  return skills.andeanScapes.experiences[0];
}

export function getExperiences(skills: Skills): ActiveExperience[] {
  return skills.andeanScapes.experiences;
}

export function hasMultipleExperiences(skills: Skills): boolean {
  return skills.andeanScapes.experiences.length > 1;
}

/**
 * Resolves the experience a conversation is scoped to. Returns the experience
 * matching `selectedId` when present, else falls back to the first (default)
 * experience. This is the seam for future multi-experience selection: today it
 * behaves identically to `getActiveExperience` because there is a single
 * experience and nothing sets a selection yet.
 */
export function resolveExperience(skills: Skills, selectedId?: string | null): ActiveExperience {
  if (selectedId) {
    const match = skills.andeanScapes.experiences.find(exp => exp.id === selectedId);
    if (match) return match;
  }
  return skills.andeanScapes.experiences[0];
}

/** Create a request-local skill view whose active experience is the selected one. */
export function scopeSkillsToExperience(skills: Skills, selectedId?: string | null): Skills {
  if (!selectedId) return skills;
  const experience = resolveExperience(skills, selectedId);
  return {
    ...skills,
    andeanScapes: {
      ...skills.andeanScapes,
      experiences: [experience],
    },
  };
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
  return getFutureAvailableDates(exp).length > 0;
}

function localDateIso(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map(part => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

export function getFutureAvailableDates(exp: ActiveExperience, today = new Date()): ActiveExperience['availability']['availableDates'] {
  if (exp.availability.botRule === AVAILABILITY_NOT_AVAILABLE) return [];
  const todayIso = localDateIso(today, exp.availability.timezone || 'America/Bogota');
  return exp.availability.availableDates.filter(entry =>
    entry.date >= todayIso && (entry.status === 'available' || entry.status === 'limited'));
}

export function getOwnerImage(skills: Skills): { url: string; caption: string } | null {
  return skills.dynamicMedia?.ownerImage ?? null;
}

export function getDynamicPlanImages(skills: Skills): InternalPlanImage[] {
  return skills.dynamicMedia?.planImages ?? [];
}

export function getGalleryImages(skills: Skills, experienceId?: string | null): InternalGalleryImage[] {
  const images = skills.dynamicMedia?.galleryImages ?? [];
  if (!experienceId) return images;
  const allowUnscoped = skills.andeanScapes.experiences.length === 1;
  return images.filter(image => image.experienceId === experienceId || (allowUnscoped && !image.experienceId));
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

export function hasPublicPaymentFacts(skills: Skills): boolean {
  const payments = skills.dynamicData?.payments;
  if (skills.dynamicData) {
    return payments != null
      && payments.deposit.value > 0
      && payments.methods.some(method => method.enabled);
  }
  const fallback = skills.andeanScapes.business.publicPaymentFallback;
  return fallback.depositPercent > 0 && fallback.methodNames.length > 0;
}
