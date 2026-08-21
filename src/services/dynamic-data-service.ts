import { z } from 'zod';
import { logger } from '../config/logger.js';
import { assertDynamicCatalogReady, dynamicDataSchema, type DynamicData } from './dynamic-data-schema.js';
import { assertReferentAttributionMatches } from './sales-composition.js';

export const PRICING_NOT_AVAILABLE = 'PRICING_NOT_AVAILABLE';
export const AVAILABILITY_NOT_AVAILABLE = 'AVAILABILITY_NOT_AVAILABLE';

// Well-known addon ids. The remote feed owns the numbers, but these keys are the
// contract between bot-dynamic.json addons and the pricing calculator. Kept here
// (next to the transform that produces the items) so a rename is a single edit.
export const ADDON_ID_PRIVATE_TRANSPORT = 'private_transport';
export const ADDON_ID_APIARY_CATTLE = 'apiary_cattle';

function todayInTimeZone(timeZone = 'America/Bogota'): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = new Map(parts.map(part => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

/**
 * An array (even empty) means the site deliberately has no extra rules text — not a
 * signal that pricing is unavailable. Only a falsy non-array (an explicit empty
 * string, which only happens on a malformed feed) is a misconfiguration signal.
 * `isSentinel` lets the caller decide the PRICING_NOT_AVAILABLE sentinel across all
 * of an experience's sites, instead of any single site's empty array wrongly
 * blanking pricing that other sites (or even this one) genuinely have.
 */
function resolveRules(rules: string | string[]): { rules: string[]; isSentinel: boolean } {
  if (Array.isArray(rules)) {
    return { rules: rules.map(s => s.trim()).filter(Boolean), isSentinel: false };
  }
  if (rules) {
    return { rules: rules.split('|').map(s => s.trim()).filter(Boolean), isSentinel: false };
  }
  return { rules: [], isSentinel: true };
}

export function shouldStripStaticPricing(dynamicSkillUrl: string, hasDynamicData: boolean): boolean {
  return dynamicSkillUrl.trim().length > 0 && !hasDynamicData;
}

export type InternalPricingItem = {
  id: string;
  kind?: 'plan' | 'addon';
  /** Which site this item belongs to. Always set — every experience has at least one site. */
  siteId: string;
  planId?: string;
  label: string;
  pricePerPerson?: number | null;
  couplePrice?: number | null;
  peopleIncluded?: number | null;
  publiclyShow: boolean;
};

/**
 * Campaign entry segment copy, keyed by entry marker code in `InternalSiteData`.
 * Owns the opening hook / diagnosis question / plan-match guidance so the skill MD
 * files never restate them.
 */
export interface InternalEntrySegment {
  label: string;
  description: string;
  valueHook: string;
  diagnosisQuestion: string;
  planMatch: string;
  /**
   * Contextual media types allowed for this entry segment. When set, automatic
   * image selection chooses from reply-matched types with unseen photos.
   */
  contextualMediaTypes?: string[];
}

/**
 * Per-site facts: addon catalog + eligibility live on `pricing.items` (filtered by
 * `siteId`), but clarifications/rules/availability are site-scoped text/state that
 * doesn't fit the pricing-item shape, so they get their own record.
 */
export interface InternalSiteData {
  id: string;
  clarifications: string[];
  rules: string[];
  /** Keyed by entry marker code (`C01`, `H01`, `R01`, …). Empty on legacy feeds. */
  entrySegments?: Record<string, InternalEntrySegment>;
  name?: string;
  location?: string;
  meetingPoint?: string;
  route?: {
    fromBogota?: string;
    alternateRoute?: string;
    localAccess?: string;
    arrivalTips?: string;
    ferryInfo?: string;
    botRules?: string[];
  };
  shortDescription?: string;
  fullDescription?: string;
  included?: string[];
  notIncludedUnlessConfirmed?: string[];
  whatToBring?: string[];
  haciendaInfo?: {
    name?: string;
    activities?: string;
    amenities?: string[];
    notes?: string;
  };
  mineDetails?: { type?: string; multipleMines?: boolean; notes?: string };
  safetyInfo?: {
    equipment?: string;
    medicalSupport?: string;
    regionSecurity?: string;
    notes?: string[];
  };
  climateInfo?: {
    altitude?: string;
    temperature?: string;
    rainySeason?: string;
    drySeason?: string;
    notes?: string;
  };
  difficulty?: { level?: string; notes?: string[] };
  experienceReality?: {
    whatItIs?: string;
    whatItIsNot?: string;
    physicalDemands?: string;
    roadConditions?: string;
    idealFor?: string;
    notIdealFor?: string;
  };
  safetyFaqs?: InternalSafetyFaq[];
  availability: {
    lastUpdated: string;
    timezone: string;
    availableDates: Array<{
      date: string;
      status: string;
      slotsApprox: number | null;
    }>;
    botRule: string;
  };
}

/** Plan narrative owned by dynamic catalog (SSoT). Pricing stays on items. */
export interface InternalPlanNarrative {
  id: string;
  siteId: string;
  status?: 'active' | 'inactive';
  name?: string;
  duration?: string;
  shortDescription?: string;
  benefits?: string;
  keywords?: string[];
  clarifications: string[];
  included?: string[];
  notIncludedUnlessConfirmed?: string[];
  itinerary?: Array<{
    day: number;
    title: string;
    activities: string[];
    meals?: string[];
    notes?: string;
  }>;
  imageId?: string;
}

export interface InternalSafetyFaq {
  lang?: 'es' | 'en';
  intent: string;
  question?: string;
  answer: string;
}

export interface InternalExperienceData {
  status?: 'active' | 'inactive';
  /** Catalog SSoT narrative from dynamic payload (optional on legacy v10). */
  name?: string;
  shortDescription?: string;
  fullDescription?: string;
  meetingPoint?: string;
  route?: {
    fromBogota?: string;
    alternateRoute?: string;
    localAccess?: string;
    arrivalTips?: string;
    ferryInfo?: string;
    botRules?: string[];
  };
  included?: string[];
  notIncludedUnlessConfirmed?: string[];
  whatToBring?: string[];
  agePolicy?: { minimumAge?: number; notes?: string };
  petPolicy?: { allowed?: boolean; notes?: string };
  cancellationPolicy?: {
    maxReschedules?: number;
    deadlineDaysBefore?: number;
    refundAfterDeadline?: boolean;
    notes?: string;
  };
  haciendaInfo?: {
    name?: string;
    activities?: string;
    amenities?: string[];
    notes?: string;
  };
  mineDetails?: { type?: string; multipleMines?: boolean; notes?: string };
  emeraldPolicy?: { guaranteed?: boolean; notes?: string };
  safetyInfo?: {
    equipment?: string;
    medicalSupport?: string;
    regionSecurity?: string;
    notes?: string[];
  };
  climateInfo?: {
    altitude?: string;
    temperature?: string;
    rainySeason?: string;
    drySeason?: string;
    notes?: string;
  };
  difficulty?: { level?: string; notes?: string[] };
  experienceReality?: {
    whatItIs?: string;
    whatItIsNot?: string;
    physicalDemands?: string;
    roadConditions?: string;
    idealFor?: string;
    notIdealFor?: string;
  };
  /** Flattened plan narratives across sites (inactive plans omitted). */
  plans: InternalPlanNarrative[];
  safetyFaqs?: InternalSafetyFaq[];
  clarifications?: {
    experience: string[];
    plans: Record<string, string[]>;
  };
  pricing: {
    currency: string;
    lastUpdated: string;
    items: InternalPricingItem[];
    // Back-compat flattened view (union of every site's rules, deduped) so callers
    // that don't need per-site grouping (pricing-calculator, product-registry,
    // skill-loader merge, the static-fallback prompt renderer) need no changes.
    botRules: string[];
  };
  // Back-compat flattened view: today's single site's availability, copied here.
  // Once a second site exists, this becomes ambiguous — the per-site renderer
  // (skills-prompt-assembly) reads `sites` directly instead; this field is a
  // deliberate single-site simplification, not a design dead end.
  availability: {
    lastUpdated: string;
    timezone: string;
    availableDates: Array<{
      date: string;
      status: string;
      slotsApprox: number | null;
    }>;
    botRule: string;
  };
  /** Structured per-site data. Always has at least one entry. */
  sites: Record<string, InternalSiteData>;
}

export interface InternalPlanImage {
  id: string;
  experienceId: string;
  siteId?: string;
  planId?: string;
  url: string;
  caption: string;
}

export interface InternalGalleryImage {
  experienceId?: string;
  siteId?: string;
  url: string;
  caption: string;
  type?: string;
}

export interface InternalDynamicMedia {
  ownerImage: { url: string; caption: string } | null;
  planImages: InternalPlanImage[];
  galleryImages: InternalGalleryImage[];
  siteTypes: Record<string, string[]>;
  /** Per-experience/site keyword maps (media type -> reply keywords). */
  typeKeywords: Record<string, Record<string, string[]>>;
}

export function mediaSiteKey(experienceId: string, siteId: string): string {
  return `${experienceId}/${siteId}`;
}

export interface InternalDynamicData {
  experiences: Record<string, InternalExperienceData>;
  media: InternalDynamicMedia | null;
  payments: InternalPaymentData | null;
  reservationPolicy?: {
    rescheduling: { allowed: true; freeUntilDaysBefore: number; lateChangeRule: string };
  } | null;
  referentAttribution?: DynamicData['referentAttribution'];
}

export interface InternalPaymentData {
  currency: string;
  deposit: {
    type: 'percentage'; value: number; label: string; calculationRule: string;
    remainingBalance: { type: 'percentage'; value: number; label?: string };
  };
  methods: Array<{
    id: string; name: string; type: string; enabled: boolean;
    currency: string; requiresPaymentProof: boolean;
  }>;
  confirmation: { automatic: boolean; requiresTeamValidation: boolean; message: string };
  displayPolicy: {
    showMethodsAfterAvailabilityValidation: boolean;
    showWhenCustomerAsks: boolean;
    neverRequestFullPaymentWithoutConfirmation: boolean;
  };
}

export class DynamicDataService {
  private url: string;
  private refreshMs: number;
  private cache: {
    data: InternalDynamicData | null;
    etag: string | null;
    lastFetchMs: number;
    lastFetchOk: boolean;
  } = { data: null, etag: null, lastFetchMs: 0, lastFetchOk: false };

  private lastErrorLogMs = 0;
  private static readonly ERROR_LOG_INTERVAL_MS = 60_000;

  constructor(url: string, refreshMs: number) {
    this.url = url;
    this.refreshMs = refreshMs;
  }

  // Throttles repeated failure logs so a persistent R2 outage does not spam logs
  // when forceRefresh runs on every new conversation.
  private logError(payload: Record<string, unknown> | Error, msg: string): void {
    const now = Date.now();
    if (now - this.lastErrorLogMs < DynamicDataService.ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogMs = now;
    logger.warn(payload, msg);
  }

  get isAvailable(): boolean {
    return this.cache.data !== null;
  }

  /** True only when the last remote fetch completed successfully (non-304, valid JSON). */
  get lastFetchOk(): boolean {
    return this.cache.lastFetchOk;
  }

  getData(): InternalDynamicData | null {
    return this.cache.data;
  }

  async refreshIfStale(): Promise<void> {
    if (this.refreshMs <= 0) return;
    const now = Date.now();
    if (now - this.cache.lastFetchMs < this.refreshMs) return;
    await this.fetch();
  }

  // Bypasses the refresh throttle so team edits to bot-dynamic.json take effect
  // without restarting the container. Cheap: sends If-None-Match (304 on no change).
  async forceRefresh(): Promise<void> {
    await this.fetch();
  }

  /** Seed cache from already-validated internal data (tests / offline catalog). */
  seedData(data: InternalDynamicData): void {
    this.cache = { data, etag: null, lastFetchMs: Date.now(), lastFetchOk: true };
  }

  private async fetch(): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (this.cache.etag) {
        headers['If-None-Match'] = this.cache.etag;
      }

      const res = await fetch(this.url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });

      if (res.status === 304) {
        this.cache.lastFetchMs = Date.now();
        this.cache.lastFetchOk = true;
        return;
      }

      if (!res.ok) {
        this.logError({ status: res.status }, '[DYNAMIC] fetch failed');
        this.cache.lastFetchOk = false;
        return;
      }

      const etag = res.headers.get('etag');
      const raw = await res.json();
      const validated = dynamicDataSchema.parse(raw);
      assertDynamicCatalogReady(validated);
      if (validated.referentAttribution) {
        assertReferentAttributionMatches(validated.referentAttribution);
      }
      const transformed = transformDynamicData(validated);

      this.cache = { data: transformed, etag, lastFetchMs: Date.now(), lastFetchOk: true };
      logger.info(
        { experiences: Object.keys(transformed.experiences) },
        '[DYNAMIC] data updated',
      );
    } catch (err) {
      this.cache.lastFetchOk = false;
      if (err instanceof z.ZodError) {
        this.logError({ issues: err.issues }, '[DYNAMIC] validation failed');
      } else {
        this.logError(err instanceof Error ? err : { err: String(err) }, '[DYNAMIC] fetch error');
      }
    }
  }
}

/**
 * Pure transform: validated CDN/local dynamic payload → internal catalog shape.
 * Exported so skill-loader can build the authoritative experience list offline
 * (CI fixture) without a live fetch.
 */
export function transformDynamicData(data: DynamicData): InternalDynamicData {
  const experiences: Record<string, InternalExperienceData> = {};
  const today = todayInTimeZone();

  for (const [expId, dynExp] of Object.entries(data.experiences)) {
    const items: InternalPricingItem[] = [];
    const sites: Record<string, InternalSiteData> = {};
    const planNarratives: InternalPlanNarrative[] = [];
    const planClarifications: Record<string, string[]> = {};
    const allRules: string[] = [];
    // Only true if every site's raw rules value was an explicit falsy string (a
    // malformed feed), never because a site legitimately has an empty rules array.
    let allSitesSentineled = true;
    let flattenedAvailability: InternalExperienceData['availability'] | null = null;

    for (const [siteId, site] of Object.entries(dynExp.sites)) {
      for (const [planId, plan] of Object.entries(site.plans)) {
        if (plan.status === 'inactive') continue;

        planClarifications[planId] = plan.clarifications;
        planNarratives.push({
          id: planId,
          siteId,
          status: plan.status,
          name: plan.name,
          duration: plan.duration,
          shortDescription: plan.shortDescription,
          benefits: plan.benefits,
          keywords: plan.keywords,
          clarifications: plan.clarifications,
          included: plan.included,
          notIncludedUnlessConfirmed: plan.notIncludedUnlessConfirmed,
          itinerary: plan.itinerary,
          imageId: plan.imageId,
        });

        if (plan.pricing?.individual != null) {
          items.push({
            id: `${planId}_individual`,
            kind: 'plan',
            siteId,
            planId,
            label: plan.name ? `${plan.name} individual` : `${planId}_individual`,
            pricePerPerson: plan.pricing.individual,
            publiclyShow: true,
          });
        }
        if (plan.pricing?.couple != null) {
          items.push({
            id: `${planId}_couple`,
            kind: 'plan',
            siteId,
            planId,
            label: plan.name ? `${plan.name} couple` : `${planId}_couple`,
            couplePrice: plan.pricing.couple,
            publiclyShow: true,
          });
        }
      }

      // Emit addon items: for each addon in THIS site's catalog, iterate over this
      // site's plans that list it. An addon id in one site never affects another
      // site's plans, even if both sites happen to define an addon with the same id.
      for (const [addonId, addon] of Object.entries(site.addons)) {
        const planIdsForAddon = Object.entries(site.plans)
          .filter(([, plan]) => plan.status !== 'inactive' && plan.addons.includes(addonId))
          .map(([planId]) => planId);
        const planIds: (string | undefined)[] = planIdsForAddon.length > 0 ? planIdsForAddon : [undefined];

        for (const planId of planIds) {
          items.push({
            id: addonId,
            kind: 'addon',
            siteId,
            planId,
            label: addon.label,
            pricePerPerson: addon.pp ?? null,
            couplePrice: addon.price ?? null,
            peopleIncluded: addon.max ?? null,
            publiclyShow: true,
          });
        }
      }

      const availabilityToday = todayInTimeZone(site.availability.tz);
      const availableDates = site.availability.dates
        .filter(d => d.d >= availabilityToday)
        .map(d => ({
          date: d.d,
          status: d.s,
          slotsApprox: d.sl ?? null,
        }));

      const { rules, isSentinel } = resolveRules(site.rules);
      allRules.push(...rules);
      if (!isSentinel) allSitesSentineled = false;

      const siteAvailability = {
        lastUpdated: today,
        timezone: site.availability.tz,
        availableDates,
        botRule: site.availability.rule || AVAILABILITY_NOT_AVAILABLE,
      };

      sites[siteId] = {
        id: siteId,
        clarifications: site.clarifications,
        rules,
        entrySegments: site.entrySegments,
        name: site.name,
        location: site.location,
        meetingPoint: site.meetingPoint,
        route: site.route,
        shortDescription: site.shortDescription,
        fullDescription: site.fullDescription,
        included: site.included,
        notIncludedUnlessConfirmed: site.notIncludedUnlessConfirmed,
        whatToBring: site.whatToBring,
        haciendaInfo: site.haciendaInfo,
        mineDetails: site.mineDetails,
        safetyInfo: site.safetyInfo,
        climateInfo: site.climateInfo,
        difficulty: site.difficulty,
        experienceReality: site.experienceReality,
        safetyFaqs: site.safetyFaqs,
        availability: siteAvailability,
      };

      // Back-compat single-site collapse: first site's availability wins. With one
      // site (today) this is exact; a second site makes this ambiguous by design —
      // per-site consumers (skills-prompt-assembly) read `sites` directly instead.
      flattenedAvailability ??= siteAvailability;
    }

    const dedupedRules = [...new Set(allRules)];
    const botRules = dedupedRules.length > 0
      ? dedupedRules
      : allSitesSentineled ? [PRICING_NOT_AVAILABLE] : [];

    const clarifications = {
      experience: dynExp.clarifications,
      plans: planClarifications,
    };

    // Only collapse site narrative into experience root when there is exactly one
    // site. Multi-site keeps root free of site-0 leakage; CATALOGO scopes per site.
    const siteList = Object.values(sites);
    const primarySite = siteList.length === 1 ? siteList[0] : undefined;

    experiences[expId] = {
      status: dynExp.status,
      name: dynExp.name,
      shortDescription: primarySite?.shortDescription ?? dynExp.shortDescription,
      fullDescription: primarySite?.fullDescription ?? dynExp.fullDescription,
      meetingPoint: primarySite?.meetingPoint ?? dynExp.meetingPoint,
      route: primarySite?.route ?? dynExp.route,
      included: primarySite?.included ?? dynExp.included,
      notIncludedUnlessConfirmed: primarySite?.notIncludedUnlessConfirmed ?? dynExp.notIncludedUnlessConfirmed,
      whatToBring: primarySite?.whatToBring ?? dynExp.whatToBring,
      agePolicy: dynExp.agePolicy,
      petPolicy: dynExp.petPolicy,
      cancellationPolicy: dynExp.cancellationPolicy,
      haciendaInfo: primarySite?.haciendaInfo ?? dynExp.haciendaInfo,
      mineDetails: primarySite?.mineDetails ?? dynExp.mineDetails,
      emeraldPolicy: dynExp.emeraldPolicy,
      safetyInfo: primarySite?.safetyInfo ?? dynExp.safetyInfo,
      climateInfo: primarySite?.climateInfo ?? dynExp.climateInfo,
      difficulty: primarySite?.difficulty ?? dynExp.difficulty,
      experienceReality: primarySite?.experienceReality ?? dynExp.experienceReality,
      safetyFaqs: primarySite?.safetyFaqs ?? dynExp.safetyFaqs,
      plans: planNarratives,
      clarifications: clarifications.experience.length > 0 || Object.values(clarifications.plans).some(c => c.length > 0)
        ? clarifications
        : undefined,
      pricing: {
        currency: dynExp.currency,
        lastUpdated: today,
        items,
        botRules,
      },
      availability: flattenedAvailability ?? {
        lastUpdated: today,
        timezone: 'America/Bogota',
        availableDates: [],
        botRule: AVAILABILITY_NOT_AVAILABLE,
      },
      sites,
    };
  }

  return {
    experiences,
    media: transformMedia(data),
    payments: transformPayments(data.payments ?? null),
    reservationPolicy: data.reservationPolicy ?? null,
    referentAttribution: data.referentAttribution,
  };
}

function transformMedia(data: DynamicData): InternalDynamicMedia {
  const ownerImage = data.media?.ownerImage
    ? { url: data.media.ownerImage.url, caption: data.media.ownerImage.caption }
    : null;

  const planImages: InternalPlanImage[] = [];
  const galleryImages: InternalGalleryImage[] = [];
  const siteTypes: Record<string, string[]> = {};
  const typeKeywords: Record<string, Record<string, string[]>> = {};

  for (const [expId, exp] of Object.entries(data.experiences)) {
    for (const [siteId, site] of Object.entries(exp.sites)) {
      const scopedSiteKey = mediaSiteKey(expId, siteId);
      siteTypes[scopedSiteKey] = site.media.types ?? [];
      typeKeywords[scopedSiteKey] = site.media.typeKeywords ?? {};
      for (const gi of site.media.gallery) {
        galleryImages.push({ experienceId: expId, siteId, url: gi.url, caption: gi.caption, type: gi.type });
      }
      for (const [planId, plan] of Object.entries(site.plans)) {
        if (plan.status === 'inactive') continue;
        for (const pi of plan.media.planImages) {
          planImages.push({ id: pi.id, experienceId: expId, siteId, planId, url: pi.url, caption: pi.caption });
        }
      }
    }
  }

  return { ownerImage, planImages, galleryImages, siteTypes, typeKeywords };
}

function transformPayments(raw: DynamicData['payments'] | null): InternalPaymentData | null {
  if (!raw) return null;
  return {
    currency: raw.currency,
    deposit: {
      type: raw.deposit.type,
      value: raw.deposit.value,
      label: raw.deposit.label,
      calculationRule: raw.deposit.calculationRule,
      remainingBalance: {
        type: 'percentage' as const,
        value: raw.deposit.remainingBalancePercentage,
      },
    },
    methods: raw.methods.map(m => ({
      id: m.id,
      name: m.name,
      type: m.type,
      enabled: m.enabled,
      currency: m.currency,
      requiresPaymentProof: m.requiresPaymentProof,
    })),
    confirmation: { ...raw.confirmation },
    displayPolicy: {
      showMethodsAfterAvailabilityValidation: raw.displayPolicy.showAfterAvailabilityValidation,
      showWhenCustomerAsks: raw.displayPolicy.showWhenCustomerAsksHowToPay,
      neverRequestFullPaymentWithoutConfirmation: raw.displayPolicy.neverRequestFullPaymentWithoutConfirmation,
    },
  };
}
