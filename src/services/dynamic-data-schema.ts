import { z } from 'zod';

/**
 * The only host allowed to serve catalog media. Exported so every consumer that
 * fetches a feed URL server-side (e.g. re-uploading a photo to Telegram) enforces
 * the same allowlist instead of repeating the literal.
 */
export const CDN_MEDIA_HOST = 'cdn.andeanscapes.com';

export function isCdnMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === CDN_MEDIA_HOST;
  } catch {
    return false;
  }
}

const cdnMediaUrlSchema = z.string().url().refine(
  isCdnMediaUrl,
  `Media URL must use https://${CDN_MEDIA_HOST}`,
);

/**
 * Site every legacy/unified (pre-v10) payload is wrapped into. These payloads predate
 * the site concept and only ever described Chivor, so this is the correct, explicit
 * home for their data — never a guess. Exported so validate-dynamic.ts and tests can
 * reference the same constant instead of repeating the string literal.
 */
export const DEFAULT_SITE_ID = 'chivor';

export const dynamicDateSchema = z.object({
  d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDate, 'd must be a real calendar date (e.g. 2026-11-30, never 2026-11-31)'),
  s: z.enum(['available', 'limited', 'unavailable', 'soldout']),
  sl: z.number().int().optional(),
}).strict();

function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export const dynamicPlanPricingSchema = z.object({
  individual: z.number().int().optional(),
  couple: z.number().int().optional(),
}).strict();

export const dynamicAddonSchema = z.object({
  label: z.string(),
  pp: z.number().int().optional(),
  price: z.number().int().optional(),
  max: z.number().int().optional(),
}).strict();

/**
 * Legacy feeds scope an addon to plans on the addon itself (`addons.<id>.plans[]`).
 * The unified/sites shapes invert this (`plans.<id>.addons[]`), so this key exists only
 * to keep the currently published CDN payload parseable during the migration window.
 */
const dynamicAddonLegacySchema = dynamicAddonSchema.extend({
  plans: z.array(z.string()).optional(),
}).strict();

export const dynamicClarificationsSchema = z.object({
  experience: z.array(z.string().min(1)).default([]),
  plans: z.record(z.array(z.string().min(1))).default({}),
}).strict();

// ---------------------------------------------------------------------------
// Optional v11 narrative fields — sites-native shape only.
// Consumed by skill-loader (authoritative catalog) and skills-prompt-assembly
// (per-site CATALOGO). No defaults on nested objects: missing field stays undefined.
// ---------------------------------------------------------------------------

export const experienceRealitySchema = z.object({
  whatItIs: z.string().min(1).optional(),
  whatItIsNot: z.string().min(1).optional(),
  physicalDemands: z.string().min(1).optional(),
  roadConditions: z.string().min(1).optional(),
  idealFor: z.string().min(1).optional(),
  notIdealFor: z.string().min(1).optional(),
}).strict();

export const routeSchema = z.object({
  fromBogota: z.string().min(1).optional(),
  alternateRoute: z.string().min(1).optional(),
  localAccess: z.string().min(1).optional(),
  arrivalTips: z.string().min(1).optional(),
  ferryInfo: z.string().min(1).optional(),
  botRules: z.array(z.string().min(1)).optional(),
}).strict();

export const safetyInfoSchema = z.object({
  equipment: z.string().min(1).optional(),
  medicalSupport: z.string().min(1).optional(),
  regionSecurity: z.string().min(1).optional(),
  notes: z.array(z.string().min(1)).optional(),
}).strict();

export const climateInfoSchema = z.object({
  altitude: z.string().min(1).optional(),
  temperature: z.string().min(1).optional(),
  rainySeason: z.string().min(1).optional(),
  drySeason: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
}).strict();

export const difficultySchema = z.object({
  level: z.string().min(1).optional(),
  notes: z.array(z.string().min(1)).optional(),
}).strict();

export const agePolicySchema = z.object({
  minimumAge: z.number().int().nonnegative().optional(),
  notes: z.string().min(1).optional(),
}).strict();

export const petPolicySchema = z.object({
  allowed: z.boolean().optional(),
  notes: z.string().min(1).optional(),
}).strict();

export const cancellationPolicySchema = z.object({
  maxReschedules: z.number().int().nonnegative().optional(),
  deadlineDaysBefore: z.number().int().nonnegative().optional(),
  refundAfterDeadline: z.boolean().optional(),
  notes: z.string().min(1).optional(),
}).strict();

export const haciendaInfoSchema = z.object({
  name: z.string().min(1).optional(),
  activities: z.string().min(1).optional(),
  amenities: z.array(z.string().min(1)).optional(),
  notes: z.string().min(1).optional(),
}).strict();

export const mineDetailsSchema = z.object({
  type: z.string().min(1).optional(),
  multipleMines: z.boolean().optional(),
  notes: z.string().min(1).optional(),
}).strict();

export const emeraldPolicySchema = z.object({
  guaranteed: z.boolean().optional(),
  notes: z.string().min(1).optional(),
}).strict();

const planItineraryDaySchema = z.object({
  day: z.number().int().positive(),
  title: z.string().min(1),
  activities: z.array(z.string().min(1)),
  meals: z.array(z.string().min(1)).optional(),
  notes: z.string().min(1).optional(),
}).strict();

/** Shared optional plan narrative fields (sites-native plans only). */
const v11PlanNarrativeSchema = z.object({
  name: z.string().min(1).optional(),
  duration: z.string().min(1).optional(),
  shortDescription: z.string().min(1).optional(),
  benefits: z.string().min(1).optional(),
  keywords: z.array(z.string().min(1)).optional(),
  included: z.array(z.string().min(1)).optional(),
  notIncludedUnlessConfirmed: z.array(z.string().min(1)).optional(),
  itinerary: z.array(planItineraryDaySchema).optional(),
  imageId: z.string().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).strict();

/** Shared optional experience narrative fields (sites-native experiences only). */
const safetyFaqSchema = z.object({
  lang: z.enum(['es', 'en']).optional(),
  intent: z.string().min(1),
  question: z.string().min(1).optional(),
  answer: z.string().min(1),
}).strict();

const v11ExperienceNarrativeSchema = z.object({
  name: z.string().min(1).optional(),
  shortDescription: z.string().min(1).optional(),
  fullDescription: z.string().min(1).optional(),
  meetingPoint: z.string().min(1).optional(),
  route: routeSchema.optional(),
  included: z.array(z.string().min(1)).optional(),
  notIncludedUnlessConfirmed: z.array(z.string().min(1)).optional(),
  whatToBring: z.array(z.string().min(1)).optional(),
  agePolicy: agePolicySchema.optional(),
  petPolicy: petPolicySchema.optional(),
  cancellationPolicy: cancellationPolicySchema.optional(),
  haciendaInfo: haciendaInfoSchema.optional(),
  mineDetails: mineDetailsSchema.optional(),
  emeraldPolicy: emeraldPolicySchema.optional(),
  safetyInfo: safetyInfoSchema.optional(),
  climateInfo: climateInfoSchema.optional(),
  difficulty: difficultySchema.optional(),
  experienceReality: experienceRealitySchema.optional(),
  safetyFaqs: z.array(safetyFaqSchema).optional(),
}).strict();

/**
 * Site-owned narrative. Logistics, climate, mine, inclusions, and copy that only
 * apply at one location (e.g. Chivor) live here — never on the experience root —
 * so a second site cannot inherit Chivor facts by accident.
 */
const v11SiteNarrativeSchema = z.object({
  name: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  meetingPoint: z.string().min(1).optional(),
  route: routeSchema.optional(),
  shortDescription: z.string().min(1).optional(),
  fullDescription: z.string().min(1).optional(),
  included: z.array(z.string().min(1)).optional(),
  notIncludedUnlessConfirmed: z.array(z.string().min(1)).optional(),
  whatToBring: z.array(z.string().min(1)).optional(),
  haciendaInfo: haciendaInfoSchema.optional(),
  mineDetails: mineDetailsSchema.optional(),
  safetyInfo: safetyInfoSchema.optional(),
  climateInfo: climateInfoSchema.optional(),
  difficulty: difficultySchema.optional(),
  experienceReality: experienceRealitySchema.optional(),
  safetyFaqs: z.array(safetyFaqSchema).optional(),
}).strict();

const dynamicPaymentPolicySchema = z.object({
  depositRequired: z.boolean(),
  depositPercentage: z.number().min(0).max(100),
  remainingBalancePercentage: z.number().min(0).max(100).optional(),
  paymentMethods: z.array(z.string()),
  paymentDataReference: z.literal('payments'),
  requiresAvailabilityValidation: z.boolean().optional(),
  requiresPaymentValidation: z.boolean().optional(),
}).strict();

const dynamicAvailabilitySchema = z.object({
  tz: z.string().default('America/Bogota'),
  dates: z.array(dynamicDateSchema).default([]),
  rule: z.string().default(''),
}).strict().default({ tz: 'America/Bogota', dates: [], rule: '' });

const dynamicRulesSchema = z.union([z.string(), z.array(z.string())]).default('');

// ---------------------------------------------------------------------------
// v10 target shape: sites are first-class. Each site owns its own addon
// catalog, pricing rules, gallery, and availability — a plan only records
// WHICH of its own site's addons it is eligible for, never the addon
// definition itself. This is what prevents Coscuez's extras/prices from
// silently colliding with Chivor's when a second site is added.
// ---------------------------------------------------------------------------

const dynamicSitePlanMediaSchema = z.object({
  planImages: z.array(z.object({
    id: z.string().min(1),
    url: cdnMediaUrlSchema,
    caption: z.string().default(''),
  }).strict()).default([]),
}).strict();

const dynamicSitePlanSchema = z.object({
  pricing: dynamicPlanPricingSchema.optional(),
  clarifications: z.array(z.string().min(1)).default([]),
  addons: z.array(z.string()).default([]),
  media: dynamicSitePlanMediaSchema.default({ planImages: [] }),
}).merge(v11PlanNarrativeSchema).strict();

const dynamicSiteMediaSchema = z.object({
  gallery: z.array(z.object({
    url: cdnMediaUrlSchema,
    caption: z.string().default(''),
    type: z.string().min(1).optional(),
  }).strict()).default([]),
  types: z.array(z.string().min(1)).default([]),
  /**
   * Keywords (per media type) that map conversational reply text to a gallery
   * theme. Keys must be declared in `media.types`. Used for deterministic
   * contextual image selection post-LLM.
   */
  typeKeywords: z.record(z.array(z.string().min(1))).default({}),
}).strict();

/**
 * Campaign entry segment (code format: `[CHR]\d{2}`, e.g., `C01`–`C04`, `H01`–`H04`, `R01`–`R04`):
 * the opening hook, diagnosis question, and plan-match guidance for a lead that arrived through that ad.
 *
 * Suffix taxonomy:
 * - `01`: general / no transport preference
 * - `02`: 4x4 / off-road vehicle
 * - `03`: moto / bike
 * - `04`: kids / family
 *
 * Prefix:
 * - `C`: cold (ad-to-message, first contact)
 * - `H`: hot funnel (high-intent lead from funnel, no valueHook)
 * - `R`: retargeting (returning lead with known plan/blocker)
 *
 * This is the single source of that copy. The skill MD files must reference the
 * rendered `ENTRY_SEGMENT` block instead of restating hooks, so a segment can be
 * retuned or a plan removed without touching a prompt file.
 *
 * `valueHook` is optional-by-default because hot leads (`H0x`) intentionally have
 * none — they skip the brand pitch and go straight to data. No field may contain
 * square-bracket placeholders like `[PLAN]` or `[GRUPO]`.
 */
const ENTRY_SEGMENT_PLACEHOLDER = /\[[A-Z][A-Z_]*\]/;

const dynamicEntrySegmentSchema = z.object({
  label: z.string().default(''),
  description: z.string().default(''),
  valueHook: z.string().default(''),
  diagnosisQuestion: z.string().default(''),
  planMatch: z.string().default(''),
  /**
   * Contextual media types allowed for this entry segment. When set, automatic
   * image selection chooses from reply-matched types that still have unseen photos.
   * Each type must be declared in the site's media.types vocabulary.
   */
  contextualMediaTypes: z.array(z.string().min(1)).min(1).refine(
    types => new Set(types).size === types.length,
    'Entry segment contextualMediaTypes must not contain duplicates',
  ).optional(),
}).strict().superRefine((segment, ctx) => {
  for (const field of ['valueHook', 'diagnosisQuestion', 'planMatch'] as const) {
    if (ENTRY_SEGMENT_PLACEHOLDER.test(segment[field])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: 'Entry segment rendered fields must not contain square-bracket placeholders',
      });
    }
  }
  if ((segment.diagnosisQuestion.match(/\?/g) ?? []).length > 1
    || (segment.diagnosisQuestion.match(/¿/g) ?? []).length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diagnosisQuestion'],
      message: 'Entry segment diagnosisQuestion must contain at most one question',
    });
  }
});

const dynamicEntrySegmentsSchema = z.record(dynamicEntrySegmentSchema).superRefine((segments, ctx) => {
  for (const [code, segment] of Object.entries(segments)) {
    if (!/^[CHR]\d{2}$/.test(code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [code],
        message: 'Entry segment code must match [CHR] followed by two digits',
      });
    }
    if (code.startsWith('C') && /[¿?]/.test(segment.valueHook)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [code, 'valueHook'],
        message: 'Cold entry segment valueHook must not contain a question',
      });
    }
    if (code.startsWith('H') && segment.valueHook.trim() !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [code, 'valueHook'],
        message: 'Hot entry segment valueHook must be empty',
      });
    }
  }
});

const dynamicSiteSchema = z.object({
  clarifications: z.array(z.string().min(1)).default([]),
  // The addon CATALOG for this site only. A plan's eligibility (`plans.*.addons[]`)
  // must reference a key here; validate-dynamic.ts enforces that referentially.
  addons: z.record(dynamicAddonSchema).default({}),
  rules: dynamicRulesSchema,
  media: dynamicSiteMediaSchema.default({ gallery: [] }),
  availability: dynamicAvailabilitySchema,
  plans: z.record(dynamicSitePlanSchema),
  // Keyed by entry marker code. Absent on the v9/legacy shapes, which never
  // carried campaign segments — those default to `{}` and fall back to the
  // generic first-contact path in the sales skill.
  entrySegments: dynamicEntrySegmentsSchema.default({}),
}).merge(v11SiteNarrativeSchema).strict();

const dynamicExperienceSitesSchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  clarifications: z.array(z.string().min(1)).default([]),
  currency: z.string().default('COP'),
  paymentPolicy: dynamicPaymentPolicySchema.optional(),
  sites: z.record(dynamicSiteSchema),
}).merge(v11ExperienceNarrativeSchema).strict();

// ---------------------------------------------------------------------------
// v9 "unified" shape (current production shape, pre-sites): plans own pricing/
// clarifications/addon-eligibility directly on the experience, and the addon
// catalog + rules sit under `pricing`. Wrapped into `sites.<DEFAULT_SITE_ID>`
// below so the rest of the system only ever deals with the sites shape.
// ---------------------------------------------------------------------------

const dynamicPlanUnifiedSchema = z.object({
  pricing: dynamicPlanPricingSchema.optional(),
  clarifications: z.array(z.string().min(1)).default([]),
  addons: z.array(z.string()).default([]),
}).strict();

const dynamicExperienceUnifiedSchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  clarifications: z.array(z.string().min(1)).default([]),
  plans: z.record(dynamicPlanUnifiedSchema),
  pricing: z.object({
    currency: z.string().default('COP'),
    addons: z.record(dynamicAddonSchema).default({}),
    paymentPolicy: dynamicPaymentPolicySchema.optional(),
    rules: dynamicRulesSchema,
  }).strict(),
  availability: dynamicAvailabilitySchema,
}).strict();

/** Legacy shape: `pricing.plans` + `addons.<id>.plans[]`. Normalized to unified below. */
const dynamicExperienceLegacySchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  clarifications: dynamicClarificationsSchema.optional(),
  pricing: z.object({
    currency: z.string().default('COP'),
    plans: z.record(dynamicPlanPricingSchema),
    addons: z.record(dynamicAddonLegacySchema).default({}),
    paymentPolicy: dynamicPaymentPolicySchema.optional(),
    rules: dynamicRulesSchema,
  }).strict(),
  availability: dynamicAvailabilitySchema,
}).strict();

type DynamicExperienceUnified = z.infer<typeof dynamicExperienceUnifiedSchema>;
type DynamicExperienceLegacy = z.infer<typeof dynamicExperienceLegacySchema>;
type DynamicExperienceSites = z.infer<typeof dynamicExperienceSitesSchema>;

/**
 * Legacy -> unified. Input is the already-parsed legacy object, so every field is
 * typed and no casts are needed.
 */
function legacyToUnified(legacy: DynamicExperienceLegacy): DynamicExperienceUnified {
  const plans: DynamicExperienceUnified['plans'] = {};
  for (const [planId, pricing] of Object.entries(legacy.pricing.plans)) {
    plans[planId] = {
      pricing,
      clarifications: legacy.clarifications?.plans[planId] ?? [],
      addons: Object.entries(legacy.pricing.addons)
        .filter(([, addon]) => addon.plans?.includes(planId))
        .map(([addonId]) => addonId),
    };
  }

  const addons: Record<string, z.infer<typeof dynamicAddonSchema>> = {};
  for (const [addonId, addon] of Object.entries(legacy.pricing.addons)) {
    addons[addonId] = {
      label: addon.label,
      ...(addon.pp !== undefined ? { pp: addon.pp } : {}),
      ...(addon.price !== undefined ? { price: addon.price } : {}),
      ...(addon.max !== undefined ? { max: addon.max } : {}),
    };
  }

  return {
    status: legacy.status,
    clarifications: legacy.clarifications?.experience ?? [],
    plans,
    pricing: {
      currency: legacy.pricing.currency,
      addons,
      paymentPolicy: legacy.pricing.paymentPolicy,
      rules: legacy.pricing.rules,
    },
    availability: legacy.availability,
  };
}

/** Unified -> sites. Wraps the whole experience into a single default site. */
function wrapUnifiedIntoSites(unified: DynamicExperienceUnified): DynamicExperienceSites {
  const plans: DynamicExperienceSites['sites'][string]['plans'] = {};
  for (const [planId, plan] of Object.entries(unified.plans)) {
    plans[planId] = {
      pricing: plan.pricing,
      clarifications: plan.clarifications,
      addons: plan.addons,
      media: { planImages: [] },
    };
  }

  return {
    status: unified.status,
    clarifications: unified.clarifications,
    currency: unified.pricing.currency,
    paymentPolicy: unified.pricing.paymentPolicy,
    sites: {
      [DEFAULT_SITE_ID]: {
        clarifications: [],
        addons: unified.pricing.addons,
        rules: unified.pricing.rules,
        media: { gallery: [], types: [], typeKeywords: {} },
        availability: unified.availability,
        plans,
        // Pre-sites feeds predate campaign segments.
        entrySegments: {},
      },
    },
  };
}

export const dynamicExperienceSchema = z.union([
  dynamicExperienceSitesSchema,
  dynamicExperienceUnifiedSchema.transform(wrapUnifiedIntoSites),
  dynamicExperienceLegacySchema.transform(legacyToUnified).transform(wrapUnifiedIntoSites),
]);

export const dynamicOwnerImageSchema = z.object({
  url: cdnMediaUrlSchema,
  caption: z.string().default(''),
}).strict();

/** Legacy flat media shape: images live top-level, tagged by experienceId/planId. */
export const dynamicPlanImageSchema = z.object({
  id: z.string().min(1),
  experienceId: z.string().min(1),
  planId: z.string().optional(),
  url: cdnMediaUrlSchema,
  caption: z.string().default(''),
}).strict();

export const dynamicGalleryImageSchema = z.object({
  experienceId: z.string().min(1).optional(),
  url: cdnMediaUrlSchema,
  caption: z.string().default(''),
}).strict();

/** v10 target: top-level media is brand-only. Gallery/planImages nest under sites/plans. */
const dynamicBrandMediaSchema = z.object({
  ownerImage: dynamicOwnerImageSchema.optional(),
}).strict();

/** Legacy/v9: images live flat at the top level, tagged by experienceId/planId. */
const dynamicLegacyFlatMediaSchema = z.object({
  ownerImage: dynamicOwnerImageSchema.optional(),
  planImages: z.array(dynamicPlanImageSchema).default([]),
  galleryImages: z.array(dynamicGalleryImageSchema).default([]),
}).strict();

export const dynamicMediaSchema = z.union([dynamicBrandMediaSchema, dynamicLegacyFlatMediaSchema]);

const referentAttributionSchema = z.object({
  profileId: z.string().min(1),
  version: z.number().int().positive(),
  sources: z.record(z.object({
    role: z.string().min(1),
    sourceLabel: z.string().min(1),
  }).strict()),
}).strict();

const PAYMENT_CREDENTIAL_PATTERN = /(?:https?:\/\/|www\.|wa\.me\/|\b(?:[a-z0-9-]+\.)+(?:com|co|la|net|org|io|app|ly)(?:\/\S*)?|\b(?:transfiere|transfer(?:\s+(?:to|via))?|consigna|consign|send to|paga en|pay at|deposit to|env[ií]a a)\b|\b(?:phone|tel[eé]fono|celular|whatsapp|paypal|banco|bank|cuenta|account|nequi|daviplata|call)\D{0,12}\+?\d(?:[\d\s().-]*\d){6,14}|\+\d(?:[\d\s().-]*\d){7,14}|(?:\+?57[\s.-]*)?3(?:[\s.-]*\d){9})/i;

const publicPaymentTextSchema = z.string().min(1).refine(
  value => !PAYMENT_CREDENTIAL_PATTERN.test(value),
  'Public payment text must not contain phone numbers or URLs',
);

function findPaymentCredential(value: unknown, path: Array<string | number> = []): Array<string | number> | null {
  if (typeof value === 'string') return PAYMENT_CREDENTIAL_PATTERN.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const match = findPaymentCredential(item, [...path, index]);
      if (match) return match;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'url') continue;
    const match = findPaymentCredential(item, [...path, key]);
    if (match) return match;
  }
  return null;
}

const dynamicDataBaseSchema = z.object({
  v: z.number().int(),
  updated: z.string(),
  referentAttribution: referentAttributionSchema.optional(),
  payments: z.object({
    currency: z.string(),
    deposit: z.object({
      type: z.literal('percentage'),
      value: z.number().min(0).max(100),
      label: publicPaymentTextSchema,
      calculationRule: z.string(),
      remainingBalancePercentage: z.number().min(0).max(100),
    }).strict(),
    // Strip unknown keys (phoneNumber, paymentLink, instructions, etc.) so CDN
    // payloads that still carry private payment fields do not fail the whole
    // dynamic load. Only public method metadata is kept for the bot.
    methods: z.array(z.object({
      id: z.string(),
      name: publicPaymentTextSchema,
      type: z.string(),
      enabled: z.boolean(),
      currency: z.string(),
      requiresPaymentProof: z.boolean(),
    }).strip()),
    confirmation: z.object({
      automatic: z.boolean(),
      requiresTeamValidation: z.boolean(),
      message: publicPaymentTextSchema,
    }).strict(),
    displayPolicy: z.object({
      showAfterAvailabilityValidation: z.boolean(),
      showWhenCustomerWantsToReserve: z.boolean(),
      showWhenCustomerAsksHowToPay: z.boolean(),
      doNotRequestPaymentBeforeAvailabilityValidation: z.boolean(),
      neverRequestFullPaymentWithoutConfirmation: z.boolean(),
    }).strict(),
  }).strict().optional(),
  reservationPolicy: z.object({
    rescheduling: z.object({
      allowed: z.literal(true),
      freeUntilDaysBefore: z.number().int().positive(),
      lateChangeRule: z.string().min(1),
    }).strict(),
  }).strict().optional(),
  media: dynamicMediaSchema.optional(),
  experiences: z.record(dynamicExperienceSchema),
}).strict().superRefine((data, ctx) => {
  const credentialPath = findPaymentCredential({
    payments: data.payments,
    reservationPolicy: data.reservationPolicy,
    experiences: data.experiences,
  });
  if (credentialPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: credentialPath,
      message: 'Dynamic prompt data must not contain payment credentials',
    });
  }

  // Until conversations persist a selected site, plan ids must identify one
  // site unambiguously. This prevents quote/extraction from crossing locations.
  for (const [experienceId, experience] of Object.entries(data.experiences)) {
    const planSites = new Map<string, string>();
    for (const [siteId, site] of Object.entries(experience.sites)) {
      for (const planId of Object.keys(site.plans)) {
        const previousSite = planSites.get(planId);
        if (previousSite && previousSite !== siteId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['experiences', experienceId, 'sites', siteId, 'plans', planId],
            message: `Plan id must be unique across sites (already defined in ${previousSite})`,
          });
        } else {
          planSites.set(planId, siteId);
        }
      }
    }
  }

  // Validate gallery image types against the site's own vocabulary.
  // Each site declares its own types (different locations/experiences may differ).
  // If a type is present on any image, the site's vocabulary must be non-empty.
  for (const [expId, exp] of Object.entries(data.experiences)) {
    for (const [siteId, site] of Object.entries(exp.sites)) {
      const vocabulary = site.media.types ?? [];
      const vocabSet = new Set(vocabulary);
      for (const [imgIdx, img] of site.media.gallery.entries()) {
        if (img.type !== undefined) {
          if (vocabulary.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['experiences', expId, 'sites', siteId, 'media', 'gallery', imgIdx, 'type'],
              message: 'Gallery image type must be declared in media.types vocabulary',
            });
          } else if (!vocabSet.has(img.type)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['experiences', expId, 'sites', siteId, 'media', 'gallery', imgIdx, 'type'],
              message: `Unknown type "${img.type}"; valid types: ${vocabulary.join(', ')}`,
            });
          }
        }
      }
      // typeKeywords keys must belong to the same declared vocabulary so a
      // keyword can never select a theme the site has no typed images for.
      for (const keywordType of Object.keys(site.media.typeKeywords)) {
        if (vocabulary.length === 0 || !vocabSet.has(keywordType)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['experiences', expId, 'sites', siteId, 'media', 'typeKeywords', keywordType],
            message: `typeKeywords key "${keywordType}" must be declared in media.types vocabulary`,
          });
        }
      }

      // Segment media categories must resolve to typed photos at the same site.
      for (const [segmentCode, segment] of Object.entries(site.entrySegments)) {
        for (const mediaType of segment.contextualMediaTypes ?? []) {
          const path = ['experiences', expId, 'sites', siteId, 'entrySegments', segmentCode, 'contextualMediaTypes'];
          if (vocabulary.length === 0 || !vocabSet.has(mediaType)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `contextualMediaTypes entry "${mediaType}" must be declared in media.types vocabulary; valid types: ${vocabulary.length > 0 ? vocabulary.join(', ') : '(no types declared)'}`,
            });
          } else if (!site.media.gallery.some(image => image.type === mediaType)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `contextualMediaTypes entry "${mediaType}" must have at least one typed gallery image`,
            });
          } else if ((site.media.typeKeywords[mediaType]?.length ?? 0) === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `contextualMediaTypes entry "${mediaType}" must have at least one media.typeKeywords entry`,
            });
          }
        }
      }
    }
  }
});

type DynamicDataBase = z.infer<typeof dynamicDataBaseSchema>;

/**
 * Distributes legacy flat top-level media (`media.planImages[]` / `media.galleryImages[]`,
 * tagged by experienceId/planId) into the sites/plans they belong to, so every consumer
 * downstream only ever reads nested media. A v10 payload that already nests its media
 * under sites/plans has no flat arrays here and passes through untouched.
 */
function distributeLegacyMediaIntoSites(data: DynamicDataBase): DynamicDataBase {
  const media = data.media;
  const isLegacyFlatMedia = media && ('planImages' in media || 'galleryImages' in media);
  if (!isLegacyFlatMedia) return data;

  const legacy = media as z.infer<typeof dynamicLegacyFlatMediaSchema>;
  const singleExperience = Object.keys(data.experiences).length === 1;

  const experiences: DynamicDataBase['experiences'] = { ...data.experiences };
  for (const [expId, exp] of Object.entries(experiences)) {
    if (!(DEFAULT_SITE_ID in exp.sites)) continue;
    const site = exp.sites[DEFAULT_SITE_ID];

    const gallery = legacy.galleryImages
      .filter(gi => gi.experienceId === expId || (singleExperience && !gi.experienceId))
      .map(gi => ({ url: gi.url, caption: gi.caption }));

    const plans: typeof site.plans = { ...site.plans };
    for (const [planId, plan] of Object.entries(plans)) {
      const planImages = legacy.planImages
        .filter(pi => pi.experienceId === expId && pi.planId === planId)
        .map(pi => ({ id: pi.id, url: pi.url, caption: pi.caption }));
      plans[planId] = { ...plan, media: { planImages } };
    }

    experiences[expId] = {
      ...exp,
      sites: { ...exp.sites, [DEFAULT_SITE_ID]: { ...site, media: { gallery, types: [], typeKeywords: {} }, plans } },
    };
  }

  return { ...data, media: { ownerImage: legacy.ownerImage }, experiences };
}

export const dynamicDataSchema = dynamicDataBaseSchema.transform(distributeLegacyMediaIntoSites);

export type DynamicData = z.infer<typeof dynamicDataSchema>;
export type DynamicExperience = z.infer<typeof dynamicExperienceSchema>;
export type DynamicSite = z.infer<typeof dynamicSiteSchema>;
export type DynamicMedia = DynamicData['media'];
export type DynamicPlanImage = z.infer<typeof dynamicPlanImageSchema>;

/** Reject pricing-only legacy payloads now that the CDN owns all catalog facts. */
export function assertDynamicCatalogReady(data: DynamicData): void {
  const missing: string[] = [];

  for (const [experienceId, experience] of Object.entries(data.experiences)) {
    if (experience.status === 'inactive') continue;
    if (!experience.name) missing.push(`${experienceId}.name`);
    let activePlanCount = 0;

    for (const [siteId, site] of Object.entries(experience.sites)) {
      const activePlans = Object.entries(site.plans).filter(([, plan]) => plan.status !== 'inactive');
      if (activePlans.length === 0) {
        missing.push(`${experienceId}.${siteId}.activePlans`);
        continue;
      }
      activePlanCount += activePlans.length;

      if (!(site.shortDescription ?? experience.shortDescription)) {
        missing.push(`${experienceId}.${siteId}.shortDescription`);
      }
      for (const [planId, plan] of activePlans) {
        if (!plan.name) missing.push(`${experienceId}.${siteId}.${planId}.name`);
        if (!plan.duration) missing.push(`${experienceId}.${siteId}.${planId}.duration`);
        if (!plan.shortDescription) missing.push(`${experienceId}.${siteId}.${planId}.shortDescription`);
      }
    }
    if (activePlanCount === 0) missing.push(`${experienceId}.activePlans`);
  }

  if (missing.length > 0) {
    throw new Error(`Dynamic catalog is incomplete: ${missing.join(', ')}`);
  }
}
