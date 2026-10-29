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

export function getSites(exp: ActiveExperience): Array<{ id: string; name?: string; selectionAliases?: string[] }> {
  const ids = [...new Set(getPlans(exp).map(plan => plan.siteId).filter((id): id is string => !!id))];
  return ids.map(id => ({ id, ...exp.sites?.[id] }));
}

export function getSiteSelection(exp: ActiveExperience): ActiveExperience['siteSelection'] {
  return exp.siteSelection;
}

/**
 * The current plan a stored id refers to. A current id maps to itself, a paused plan
 * maps to itself (its site decides, see `isPlanPaused`), and a retired id maps to the
 * plan that lists it in `legacyPlanIds`. Null when nothing matches.
 */
export function resolveCurrentPlanId(exp: ActiveExperience, planId: string | null | undefined): string | null {
  if (!planId) return null;
  if (getPlans(exp).some(plan => plan.id === planId) || isPlanPaused(exp, planId)) return planId;
  return getPlans(exp).find(plan => plan.legacyPlanIds?.includes(planId))?.id ?? null;
}

export function getEquivalentPlan(exp: ActiveExperience, planId: string, siteId: string): string | null {
  const tier = getPlans(exp).find(plan => plan.id === planId)?.tier
    ?? getUnavailableSites(exp).find(site => site.planIds.includes(planId))?.planTiers[planId];
  if (!tier) return null;
  const matches = getPlans(exp).filter(plan => plan.siteId === siteId && plan.tier === tier);
  return matches.length === 1 ? matches[0].id : null;
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

/** The site's own safety FAQs when the feed defines them, else the experience-wide ones. */
export function getSiteCommonQuestions(skills: Skills, exp: ActiveExperience, siteId: string | undefined): ActiveExperience['commonQuestions'] {
  const siteFaqs = siteId ? skills.dynamicData?.experiences[exp.id]?.sites[siteId]?.safetyFaqs : undefined;
  if (siteFaqs) return siteFaqs.map(faq => ({ ...faq, question: faq.question ?? faq.intent }));
  return getCommonQuestions(exp);
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

/** A gallery photo the customer on `planId` may receive: unrestricted, or restricted to that plan. */
export function isGalleryImageForPlan(image: InternalGalleryImage, planId: string | null | undefined): boolean {
  return !image.planIds || (!!planId && image.planIds.includes(planId));
}

/**
 * The same skills with plan-restricted gallery photos removed unless `planId` is
 * listed on them (e.g. Fura y Tena photos only reach PRIME Coscuez customers).
 * Every customer-facing photo path runs on this view, so an unauthorised photo
 * is neither advertised to the model, cued, resolved, nor sent.
 */
export function scopeGalleryToPlan(skills: Skills, planId: string | null | undefined): Skills {
  const media = skills.dynamicMedia;
  if (!media || !media.galleryImages.some(image => image.planIds)) return skills;
  return {
    ...skills,
    dynamicMedia: { ...media, galleryImages: media.galleryImages.filter(image => isGalleryImageForPlan(image, planId)) },
  };
}

/**
 * Gallery theme that stands in when a requested theme has no photos at a site
 * (e.g. Coscuez has no kids photos yet). Catalog-driven, never a literal: the
 * stored plan's `galleryTheme`, else the one other plan theme of that site.
 * Only a theme with **unrestricted** photos at the same site qualifies, so a
 * substitute is never plan-specific (PRIME's Fura y Tena excursion stands in for
 * nothing; PRIME falls back to the site's mine photos). Null otherwise: never
 * crosses sites, never invents a category.
 */
export function getSiteFallbackGalleryTheme(
  skills: Skills,
  experienceId: string | null | undefined,
  siteId: string | null | undefined,
  planId?: string | null,
): string | null {
  if (!siteId) return null;
  const experience = findActiveExperience(skills, experienceId);
  if (!experience) return null;
  const hasSharedPhotos = (theme: string): boolean => getGalleryImages(skills, experience.id)
    .some(image => image.siteId === siteId && image.type === theme && !image.planIds);
  const sitePlans = getPlans(experience).filter(plan => plan.siteId === siteId);
  const planTheme = planId ? sitePlans.find(plan => plan.id === planId)?.galleryTheme : undefined;
  if (planTheme && hasSharedPhotos(planTheme)) return planTheme;
  const candidates = [...new Set(sitePlans.map(plan => plan.galleryTheme).filter((theme): theme is string => !!theme))]
    .filter(hasSharedPhotos);
  return candidates.length === 1 ? candidates[0] : null;
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

/**
 * Anticipo for one plan of `exp`: the plan's own `depositPercentage` when the catalog
 * sets one, else the experience-wide deposit. Scoped to one experience because plan
 * ids are only unique within it.
 */
export function getPublicPaymentFactsForPlan(
  skills: Skills,
  exp: ActiveExperience | null | undefined,
  planId: string | null | undefined,
): PublicPaymentFacts {
  const base = getPublicPaymentFacts(skills);
  const planDeposit = planId ? exp?.plans.find(plan => plan.id === planId)?.depositPercentage : undefined;
  return planDeposit != null ? { ...base, depositPercent: planDeposit } : base;
}

/** Paused destinations: acknowledged by name only, never quoted, photographed or booked. */
export function getUnavailableSites(exp: ActiveExperience): NonNullable<ActiveExperience['unavailableSites']> {
  return exp.unavailableSites ?? [];
}

/** True when `planId` belongs to a paused destination of `exp`. */
export function isPlanPaused(exp: ActiveExperience | null | undefined, planId: string | null | undefined): boolean {
  if (!exp || !planId) return false;
  return getUnavailableSites(exp).some(site => site.planIds.includes(planId));
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
