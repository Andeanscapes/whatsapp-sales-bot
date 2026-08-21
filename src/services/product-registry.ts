import type { Skills, AndeanScapesSkill } from './skill-loader.js';
import { PRICING_NOT_AVAILABLE, AVAILABILITY_NOT_AVAILABLE, mediaSiteKey } from './dynamic-data-service.js';
import type { InternalPlanImage, InternalGalleryImage, InternalPaymentData, InternalEntrySegment } from './dynamic-data-service.js';

type Experience = AndeanScapesSkill['experiences'][number];

export type ActiveExperience = Experience;

export function findActiveExperience(skills: Skills, selectedId?: string | null): ActiveExperience | null {
  const active = getExperiences(skills);
  if (selectedId) return active.find(experience => experience.id === selectedId) ?? null;
  return active[0] ?? null;
}

export function getActiveExperience(skills: Skills): ActiveExperience {
  const experience = findActiveExperience(skills);
  if (!experience) throw new Error('No active product experience is available');
  return experience;
}

export function getExperiences(skills: Skills): ActiveExperience[] {
  return skills.andeanScapes.experiences.filter(exp => isExperienceActive(exp));
}

export function hasMultipleExperiences(skills: Skills): boolean {
  return getExperiences(skills).length > 1;
}

export function isExperienceActive(exp: ActiveExperience): boolean {
  return exp.status !== 'inactive';
}

export function hasActiveExperience(skills: Skills): boolean {
  return getExperiences(skills).length > 0;
}

/**
 * Resolves the experience a conversation is scoped to. Returns the experience
 * matching `selectedId` when present, else falls back to the first (default)
 * experience. This is the seam for future multi-experience selection: today it
 * behaves identically to `getActiveExperience` because there is a single
 * experience and nothing sets a selection yet.
 */
export function resolveExperience(skills: Skills, selectedId?: string | null): ActiveExperience {
  return findActiveExperience(skills, selectedId) ?? getActiveExperience(skills);
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

export function getFutureAvailableDatesForPlan(
  skills: Skills,
  exp: ActiveExperience,
  planId?: string | null,
  today = new Date(),
): ActiveExperience['availability']['availableDates'] {
  const plan = planId ? exp.plans.find(candidate => candidate.id === planId) : undefined;
  const dynamicExperience = skills.dynamicData?.experiences[exp.id];
  const siteAvailability = plan?.siteId ? dynamicExperience?.sites[plan.siteId]?.availability : undefined;

  if (siteAvailability) {
    if (siteAvailability.botRule === AVAILABILITY_NOT_AVAILABLE) return [];
    const todayIso = localDateIso(today, siteAvailability.timezone || 'America/Bogota');
    return siteAvailability.availableDates
      .filter(entry => entry.date >= todayIso && (entry.status === 'available' || entry.status === 'limited'))
      .map(entry => ({
        ...entry,
        status: entry.status as ActiveExperience['availability']['availableDates'][number]['status'],
      }));
  }

  const siteIds = new Set(exp.plans.map(candidate => candidate.siteId).filter(Boolean));
  return siteIds.size > 1 ? [] : getFutureAvailableDates(exp, today);
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

export function getMediaTypes(skills: Skills, experienceId?: string | null, siteId?: string): string[] {
  const siteTypes = skills.dynamicMedia?.siteTypes ?? {};
  if (experienceId && siteId) return siteTypes[mediaSiteKey(experienceId, siteId)] ?? [];
  const entries = experienceId
    ? Object.entries(siteTypes).filter(([key]) => key.startsWith(`${experienceId}/`))
    : Object.entries(siteTypes);
  return [...new Set(entries.flatMap(([, types]) => types))];
}

export function getTypeKeywords(
  skills: Skills,
  experienceId?: string | null,
  siteId?: string,
): Record<string, string[]> {
  const typeKeywords = skills.dynamicMedia?.typeKeywords ?? {};
  if (experienceId && siteId) return typeKeywords[mediaSiteKey(experienceId, siteId)] ?? {};
  const entries = experienceId
    ? Object.entries(typeKeywords).filter(([key]) => key.startsWith(`${experienceId}/`))
    : Object.entries(typeKeywords);
  const merged: Record<string, string[]> = {};
  for (const [, site] of entries) {
    for (const [type, keywords] of Object.entries(site)) {
      merged[type] = [...new Set([...(merged[type] ?? []), ...keywords])];
    }
  }
  return merged;
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

/**
 * Retrieves an entry segment for a given entry marker code from the dynamic data.
 * Returns the segment if found, or null if the code doesn't map to a defined segment
 * or the site has no entry segments defined.
 */
export function getEntrySegment(
  skills: Skills,
  experienceId: string,
  entryMarkerCode: string,
  preferredSiteId?: string | null,
): { siteId: string; segment: InternalEntrySegment } | null {
  const experience = skills.dynamicData?.experiences[experienceId];
  if (!experience) return null;

  if (preferredSiteId) {
    const segment = experience.sites[preferredSiteId]?.entrySegments?.[entryMarkerCode];
    return segment ? { siteId: preferredSiteId, segment } : null;
  }

  const matches = Object.entries(experience.sites).flatMap(([siteId, site]) => {
    const segment = site.entrySegments?.[entryMarkerCode];
    return segment ? [{ siteId, segment }] : [];
  });
  return matches.length === 1 ? matches[0] : null;
}
