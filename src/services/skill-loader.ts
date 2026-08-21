import { z } from 'zod';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { DynamicDataService, InternalDynamicData, InternalDynamicMedia, InternalExperienceData } from './dynamic-data-service.js';
import { PRICING_NOT_AVAILABLE, AVAILABILITY_NOT_AVAILABLE, transformDynamicData } from './dynamic-data-service.js';
import { assertDynamicCatalogReady, dynamicDataSchema } from './dynamic-data-schema.js';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function substituteTokens(text: string): string {
  return text
    .replace(/\{\{OWNER_NAME\}\}/g, process.env.OWNER_NAME ?? '{{OWNER_NAME}}')
    .replace(/\{\{PARTNER_NAME\}\}/g, process.env.PARTNER_NAME ?? '{{PARTNER_NAME}}');
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const availableDateSchema = z.object({
  date: dateSchema,
  status: z.enum(['available', 'limited', 'unavailable', 'soldout']),
  slotsApprox: z.number().int().nullable(),
  internalNote: z.string().optional(),
});

const pricingItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['plan', 'addon']).optional(),
  siteId: z.string().optional(),
  planId: z.string().optional(),
  label: z.string(),
  pricePerPerson: z.number().int().nullable().optional(),
  couplePrice: z.number().int().nullable().optional(),
  peopleIncluded: z.number().int().nullable().optional(),
  minimumPeople: z.number().int().nullable().optional(),
  publiclyShow: z.boolean(),
  internalNote: z.string().optional(),
  botResponse: z.string().optional(),
});

const commonQuestionSchema = z.object({
  lang: z.enum(['es', 'en']).optional(),
  intent: z.string(),
  question: z.string(),
  answer: z.string(),
});

const experienceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['active', 'inactive']).default('active'),
  clarifications: z.array(z.string()).default([]),
  shortDescription: z.string(),
  fullDescription: z.string().optional(),
  meetingPoint: z.string(),
  route: z.object({
    fromBogota: z.string(),
    alternateRoute: z.string().optional(),
    localAccess: z.string(),
    arrivalTips: z.string().optional(),
    ferryInfo: z.string().optional(),
    botRules: z.array(z.string()),
  }),
  availability: z.object({
    lastUpdated: dateSchema,
    timezone: z.string(),
    availableDates: z.array(availableDateSchema),
    botRule: z.string(),
  }),
  pricing: z.object({
    currency: z.string(),
    lastUpdated: dateSchema,
    items: z.array(pricingItemSchema),
    botRules: z.array(z.string()),
    // Non-price business rules (group formulas, addon/transport policy,
    // cancellation, pet/age, "never invent discounts"). These live in the
    // static skill (not price VALUES) and are always applied ALONGSIDE the
    // remote pricing rules — the dynamic feed only owns the numbers.
    businessRules: z.array(z.string()).default([]),
  }),
  included: z.array(z.string()),
  notIncludedUnlessConfirmed: z.array(z.string()),
  whatToBring: z.array(z.string()),
   plans: z.array(z.object({
     id: z.string(),
     siteId: z.string().optional(),
     name: z.string(),
     duration: z.string(),
     shortDescription: z.string(),
     benefits: z.string(),
     keywords: z.array(z.string()),
     imageId: z.string(),
     clarifications: z.array(z.string()).default([]),
     included: z.array(z.string()).default([]),
     notIncludedUnlessConfirmed: z.array(z.string()).default([]),
     itinerary: z.array(z.object({
       day: z.number().int().positive(),
       title: z.string(),
       activities: z.array(z.string()),
       meals: z.array(z.string()).default([]),
       notes: z.string().optional(),
     })).default([]),
   })),
  petPolicy: z.object({
    allowed: z.boolean(),
    notes: z.string(),
  }).optional(),
  agePolicy: z.object({
    minimumAge: z.number().int(),
    notes: z.string(),
  }).optional(),
  cancellationPolicy: z.object({
    maxReschedules: z.number().int(),
    deadlineDaysBefore: z.number().int(),
    refundAfterDeadline: z.boolean(),
    notes: z.string(),
  }).optional(),
  mineDetails: z.object({
    type: z.string(),
    multipleMines: z.boolean(),
    notes: z.string(),
  }),
  emeraldPolicy: z.object({
    guaranteed: z.boolean(),
    notes: z.string(),
  }),
  haciendaInfo: z.object({
    name: z.string().optional(),
    activities: z.string().optional(),
    amenities: z.array(z.string()).optional(),
    notes: z.string().optional(),
  }).optional(),
  safetyInfo: z.object({
    equipment: z.string().optional(),
    medicalSupport: z.string().optional(),
    regionSecurity: z.string().optional(),
    notes: z.array(z.string()).optional(),
  }).optional(),
  climateInfo: z.object({
    altitude: z.string().optional(),
    temperature: z.string().optional(),
    rainySeason: z.string().optional(),
    drySeason: z.string().optional(),
    notes: z.string().optional(),
  }).optional(),
  difficulty: z.object({
    level: z.string(),
    notes: z.array(z.string()),
  }),
  experienceReality: z.object({
    whatItIs: z.string(),
    whatItIsNot: z.string(),
    physicalDemands: z.string(),
    roadConditions: z.string(),
    idealFor: z.string(),
    notIdealFor: z.string(),
  }).optional(),
  reservationFlow: z.array(z.string()),
  commonQuestions: z.array(commonQuestionSchema),
  botBehavior: z.object({
    adventureFilter: z.string(),
    qualificationPhases: z.object({
      phase1: z.string(),
      phase2: z.string(),
      phase3: z.string(),
    }),
    handoffExactReply: z.object({
      es: z.string(),
      en: z.string(),
    }),
    negativeExamples: z.string(),
  }).optional(),
});

const andeanScapesSchema = z.object({
  skillVersion: z.string(),
  business: z.object({
    name: z.string(),
    location: z.string(),
    shortBrandIntro: z.string().optional(),
    mainExperience: z.string(),
    publicTourUrlEnv: z.string(),
    socialLinks: z.object({
      instagram: z.string(),
    }).optional(),
    languages: z.array(z.string()),
    publicPaymentFallback: z.object({
      depositPercent: z.number().min(0).max(100),
      methodNames: z.array(z.string()).min(1),
    }),
  }),
  // Empty allowed: product catalog SSoT is dynamic JSON when present.
  experiences: z.array(experienceSchema).default([]),
});

const signalSchema = z.object({
  id: z.string(),
  score: z.number().int(),
  keywords: z.array(z.string()).optional(),
  patterns: z.array(z.string()).optional(),
});

const negativeSignalSchema = z.object({
  id: z.string(),
  score: z.number().int(),
  keywords: z.array(z.string()),
});

// Sales methodology lives in the MD skills + referent packs (skills v2), not here.
// This file is scoring/threshold data only.
const salesStrategySchema = z.object({
  hotLeadThreshold: z.number().int(),
  urgentLeadThreshold: z.number().int(),
  maxScore: z.number().int(),
  maxGroupSizePerDate: z.number().int().positive(),
  signals: z.array(signalSchema),
  negativeSignals: z.array(negativeSignalSchema),
  ownerAlertTemplate: z.string(),
});

const mediaPolicySchema = z.object({
  sendImagesEnabled: z.boolean(),
  maxImagesPerCustomerPer72h: z.number().int(),
  preferTourUrlOverImages: z.boolean(),
  botRules: z.array(z.string()),
});

const imageSchema = z.object({
  id: z.string(),
  experienceId: z.string(),
  planId: z.string().optional(),
  type: z.string(),
  value: z.string(),
  caption: z.string(),
});

const mediaSchema = z.object({
  mediaPolicy: mediaPolicySchema,
  images: z.array(imageSchema),
});

const langFallbackSchema = z.object({
  optOutConfirmation: z.string(),
  askName: z.string(),
  askPlan: z.string(),
  plansListReply: z.string(),
  askPeople: z.string(),
  askDate: z.string(),
  askTransport: z.string(),
  childSuitabilityBoundary: z.string(),
  dateOptionsOffer: z.string(),
  advanceQuestionPeople: z.string(),
  advanceQuestionTransportSolo: z.string(),
  advanceQuestionTransport: z.string(),
  advanceQuestionDateOrLogistics: z.string(),
  advanceQuestionDateOnly: z.string(),
  advanceQuestionNameSolo: z.string(),
  advanceQuestionName: z.string(),
  advanceQuestionNextStep: z.string(),
  priceDependsOnGroup: z.string(),
  clarifyName: z.string(),
  clarifyPlan: z.string(),
  clarifyPeople: z.string(),
  clarifyDate: z.string(),
  clarifyTransport: z.string(),
  aiFailureQualified: z.string(),
  aiFailureQualifiedV2: z.string(),
  aiFailureQualifiedV3: z.string(),
  aiBudgetExhausted: z.string(),
  llmFailureWarm: z.string().optional(),
  messageLimitReached: z.string(),
  messageLimitHandoff: z.string(),
  messageLimitAfterPrice: z.string(),
  messageLimitAfterPriceAfterHours: z.string(),
  messageLimitAfterPriceMorningHours: z.string(),
  handoffMessage: z.string(),
  repairPriceNotPresented: z.string(),
  repairPricePresented: z.string(),
  handedOffVariant0: z.string(),
  handedOffVariant1: z.string(),
  handedOffTypo: z.string(),
  handedOffQuestion: z.string(),
  handedOffThanks: z.string(),
  adventureClarifier: z.string(),
  disculpaYaDicho: z.string(),
  objectionResolvedContinue: z.string(),
  quoteContext: z.string(),
  quoteNextStep: z.string(),
  quoteNextStepSolo: z.string(),
  quoteNextStepDateDeferred: z.string(),
  reservationClosing: z.string(),
  reservationClosingLimited: z.string(),
  paymentMethodsReply: z.string(),
  reservationPendingOwner: z.string(),
  reservationPendingAck: z.string(),
  reservationSoftHold: z.string(),
  priceGateTeaser: z.string(),
  priceFollowUpCatalog: z.string(),
  priceFollowUpCase: z.string(),
  priceFollowUpLabelCouple: z.string(),
  priceFollowUpLabelPeople: z.string(),
  priceFollowUpUnitPerson: z.string(),
  priceFollowUpUnitPeople: z.string(),
  quoteFitSolo: z.string(),
  quoteFitCouple: z.string(),
  quoteFitGroup: z.string(),
  quoteValueStack: z.string(),
  quoteAnchor: z.string(),
  quotePlanBase: z.string(),
  quotePlanBaseSolo: z.string(),
  quoteAddons: z.string(),
  quoteTransport: z.string(),
  quoteTotal: z.string(),
  quoteTransportConfirm: z.string(),
  transportPriceInquiry: z.string(),
  safeReservationHandoff: z.string(),
  safeReservationHandoffAlt1: z.string(),
  safeReservationHandoffAlt2: z.string(),
  safeReservationHandoffAfterHours: z.string(),
  safeReservationHandoffMorningHours: z.string(),
  referralHandoff: z.string(),
  softCloseReply: z.string(),
  confirmReservationPrompt: z.string(),
  internalDatePending: z.string(),
  priceUnavailable: z.string(),
  priceUnavailableKnownGroup: z.string(),
  partyComparisonUnavailable: z.string(),
  partyComparisonNeedsPlan: z.string(),
  partyComparisonQuote: z.string(),
  futureDateValidation: z.string(),
  dateSelectedLimited: z.string(),
  dateSelectedLimitedNoDate: z.string(),
  answerQuestionBeforeQualification: z.string(),
  itineraryReply: z.string(),
  dynamicDataUnavailable: z.string(),
  experienceInactive: z.string(),
  planUnavailable: z.string(),
  pastDateReply: z.string(),
  systemErrorRetry: z.string(),
  largeGroupReview: z.string(),
  largeGroupEscalate: z.string(),
  organizerContactReceived: z.string(),
  wrongServiceNatureOnly: z.string(),
  reservationPolicyUnavailable: z.string(),
  paymentLinkSent: z.string(),
  paymentApprovedOwnerAlert: z.string(),
  humanPendingPaymentAck: z.string(),
  afterPriceNextStep: z.string(),
  inclusionsPackageReply: z.string(),
  availabilityListReply: z.string(),
  inclusionsPadSuffix: z.string(),
  availabilityRecommendReply: z.string(),
  availabilityWindowNoMatchClosest: z.string(),
  availabilityWindowNoMatch: z.string(),
  availabilityLimitedClause: z.string(),
  painReplyPrice: z.string(),
  painReplyDateTime: z.string(),
  painReplySecurity: z.string(),
  painReplyLogistics: z.string(),
  painReplyExperienceClarity: z.string(),
  painReplyPartnerGroup: z.string(),
  multiExperienceIntro: z.string(),
  experienceSelected: z.string(),
  closeDepositPriceLine: z.string(),
  transportAdditionalLabel: z.string(),
});

const fallbackRepliesSchema = z.object({
  es: langFallbackSchema,
  en: langFallbackSchema,
});

export type AndeanScapesSkill = z.infer<typeof andeanScapesSchema>;
export type SalesStrategySkill = z.infer<typeof salesStrategySchema>;
export type MediaSkill = z.infer<typeof mediaSchema>;
export type FallbackReplies = z.infer<typeof fallbackRepliesSchema>;

export interface Skills {
  andeanScapes: AndeanScapesSkill;
  salesStrategy: SalesStrategySkill;
  media: MediaSkill;
  fallbackReplies: FallbackReplies;
  dynamicMedia: InternalDynamicMedia | null;
  dynamicData: InternalDynamicData | null;
}

let cached: Skills | null = null;
let cachedService: DynamicDataService | null = null;

function loadJson(filename: string): unknown {
  const path = join(__dirname, '..', 'data', filename);
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(substituteTokens(raw));
}

type Experience = AndeanScapesSkill['experiences'][number];

/**
 * Build runtime experiences solely from dynamic catalog.
 * Missing dynamic experience key = deleted. No static resurrection.
 */
export function buildExperiencesFromDynamic(dynData: InternalDynamicData): Experience[] {
  return Object.entries(dynData.experiences).map(([expId, dyn]) => experienceFromDynamic(expId, dyn));
}

function experienceFromDynamic(expId: string, dyn: InternalExperienceData): Experience {
  // Site logistics stay site-owned. Only collapse into experience root when there is
  // exactly one site (current prod). Multi-site keeps root free of site-0 leakage;
  // CATALOGO scopes via scopeExperienceToSite.
  const siteEntries = Object.values(dyn.sites);
  const site = siteEntries.length === 1 ? siteEntries[0] : undefined;
  const route = site?.route ?? dyn.route;
  const shortDescription = site?.shortDescription ?? dyn.shortDescription ?? '';
  const fullDescription = site?.fullDescription ?? dyn.fullDescription;
  const meetingPoint = site?.meetingPoint ?? dyn.meetingPoint ?? '';
  const included = site?.included ?? dyn.included ?? [];
  const notIncluded = site?.notIncludedUnlessConfirmed ?? dyn.notIncludedUnlessConfirmed ?? [];
  const whatToBring = site?.whatToBring ?? dyn.whatToBring ?? [];
  const mineDetails = site?.mineDetails ?? dyn.mineDetails;
  const climateInfo = site?.climateInfo ?? dyn.climateInfo;
  const difficulty = site?.difficulty ?? dyn.difficulty;
  const experienceReality = site?.experienceReality ?? dyn.experienceReality;
  const safetyFaqs = site?.safetyFaqs ?? dyn.safetyFaqs ?? [];

  const plans = dyn.plans.map(plan => ({
    id: plan.id,
    siteId: plan.siteId,
    name: plan.name ?? plan.id,
    duration: plan.duration ?? '',
    shortDescription: plan.shortDescription ?? '',
    benefits: plan.benefits ?? '',
    keywords: plan.keywords ?? [],
    imageId: plan.imageId ?? '',
    clarifications: plan.clarifications ?? dyn.clarifications?.plans?.[plan.id] ?? [],
    included: plan.included ?? [],
    notIncludedUnlessConfirmed: plan.notIncludedUnlessConfirmed ?? [],
    itinerary: (plan.itinerary ?? []).map(day => ({ ...day, meals: day.meals ?? [] })),
  }));

  const pricingItems: Experience['pricing']['items'] = dyn.pricing.items.map(item => ({
    id: item.id,
    kind: item.kind,
    siteId: item.siteId,
    planId: item.planId,
    label: item.label,
    pricePerPerson: item.pricePerPerson ?? null,
    couplePrice: item.couplePrice ?? null,
    peopleIncluded: item.peopleIncluded ?? null,
    publiclyShow: item.publiclyShow,
  }));

  const commonQuestions = safetyFaqs.map(faq => ({
    lang: faq.lang,
    intent: faq.intent,
    question: faq.question ?? faq.intent,
    answer: faq.answer,
  }));

  return {
    id: expId,
    name: dyn.name ?? expId,
    status: dyn.status ?? 'active',
    clarifications: dyn.clarifications?.experience ?? [],
    shortDescription,
    fullDescription,
    meetingPoint,
    route: {
      fromBogota: route?.fromBogota ?? '',
      alternateRoute: route?.alternateRoute,
      localAccess: route?.localAccess ?? '',
      arrivalTips: route?.arrivalTips,
      ferryInfo: route?.ferryInfo,
      botRules: route?.botRules ?? [],
    },
    availability: {
      lastUpdated: dyn.availability.lastUpdated.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '1970-01-01',
      timezone: dyn.availability.timezone,
      availableDates: dyn.availability.availableDates.map(d => ({
        date: d.date,
        status: d.status as Experience['availability']['availableDates'][number]['status'],
        slotsApprox: d.slotsApprox,
      })),
      botRule: dyn.availability.botRule,
    },
    pricing: {
      currency: dyn.pricing.currency,
      lastUpdated: dyn.pricing.lastUpdated.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '1970-01-01',
      items: pricingItems,
      botRules: dyn.pricing.botRules,
      businessRules: [],
    },
    included,
    notIncludedUnlessConfirmed: notIncluded,
    whatToBring,
    plans,
    petPolicy: dyn.petPolicy?.allowed !== undefined
      ? { allowed: dyn.petPolicy.allowed, notes: dyn.petPolicy.notes ?? '' }
      : undefined,
    agePolicy: dyn.agePolicy?.minimumAge !== undefined
      ? { minimumAge: dyn.agePolicy.minimumAge, notes: dyn.agePolicy.notes ?? '' }
      : undefined,
    cancellationPolicy: dyn.cancellationPolicy?.deadlineDaysBefore !== undefined
      ? {
          maxReschedules: dyn.cancellationPolicy.maxReschedules ?? 0,
          deadlineDaysBefore: dyn.cancellationPolicy.deadlineDaysBefore,
          refundAfterDeadline: dyn.cancellationPolicy.refundAfterDeadline ?? false,
          notes: dyn.cancellationPolicy.notes ?? '',
        }
      : undefined,
    mineDetails: {
      type: mineDetails?.type ?? '',
      multipleMines: mineDetails?.multipleMines ?? true,
      notes: mineDetails?.notes ?? '',
    },
    emeraldPolicy: {
      guaranteed: dyn.emeraldPolicy?.guaranteed ?? false,
      notes: dyn.emeraldPolicy?.notes ?? '',
    },
    haciendaInfo: site?.haciendaInfo ?? dyn.haciendaInfo,
    safetyInfo: site?.safetyInfo ?? dyn.safetyInfo,
    climateInfo,
    difficulty: {
      level: difficulty?.level ?? '',
      notes: difficulty?.notes ?? [],
    },
    experienceReality: experienceReality
      ? {
          whatItIs: experienceReality.whatItIs ?? '',
          whatItIsNot: experienceReality.whatItIsNot ?? '',
          physicalDemands: experienceReality.physicalDemands ?? '',
          roadConditions: experienceReality.roadConditions ?? '',
          idealFor: experienceReality.idealFor ?? '',
          notIdealFor: experienceReality.notIdealFor ?? '',
        }
      : undefined,
    reservationFlow: [],
    commonQuestions,
  };
}

/** Offline/CI catalog path: committed twin of CDN dynamic JSON. */
function resolveOfflineCatalogPath(): string | null {
  const candidates = [
    join(__dirname, '..', 'data', 'bot-dynamic.ci.json'),
    join(__dirname, '..', '..', 'scripts', 'bot-dynamic.ci.json'),
    join(process.cwd(), 'scripts', 'bot-dynamic.ci.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadOfflineCatalog(): InternalDynamicData | null {
  const path = resolveOfflineCatalogPath();
  if (!path) throw new Error('Offline dynamic catalog not found');
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const validated = dynamicDataSchema.parse(raw);
  assertDynamicCatalogReady(validated);
  return transformDynamicData(validated);
}

function applyAuthoritativeCatalog(
  _brand: AndeanScapesSkill,
  dynData: InternalDynamicData | null,
  staticExperiences: readonly Experience[],
): { experiences: Experience[]; dynamicMedia: InternalDynamicMedia | null; dynamicData: InternalDynamicData | null } {
  // Remote/service snapshot wins when present (even empty = intentional wipe).
  if (dynData) {
    return {
      experiences: buildExperiencesFromDynamic(dynData),
      dynamicMedia: dynData.media,
      dynamicData: dynData,
    };
  }
  // Service configured but no successful payload yet → degraded empty catalog.
  // Do NOT fall back to offline CI fixture (that would hide real CDN outages).
  if (cachedService) {
    return {
      experiences: [],
      dynamicMedia: null,
      dynamicData: null,
    };
  }
  // No dynamic service (local/tests): load committed offline CI catalog as SSoT.
  const offline = loadOfflineCatalog();
  if (offline) {
    return {
      experiences: buildExperiencesFromDynamic(offline),
      dynamicMedia: offline.media,
      dynamicData: offline,
    };
  }
  return {
    experiences: [...staticExperiences],
    dynamicMedia: null,
    dynamicData: null,
  };
}

function mergeDynamicIntoStatic(dynData: InternalDynamicData | null): void {
  if (!cached) return;
  const applied = applyAuthoritativeCatalog(cached.andeanScapes, dynData, []);
  cached = {
    ...cached,
    andeanScapes: { ...cached.andeanScapes, experiences: applied.experiences },
    dynamicMedia: applied.dynamicMedia,
    dynamicData: applied.dynamicData,
  };
}

export function setDynamicService(service: DynamicDataService | null): void {
  cachedService = service;
  // Drop skills cache so next loadSkills/getSkills rebuilds from the new service
  // (or offline CI catalog when service is cleared). Prevents stale merges across tests.
  cached = null;
}

export function getDynamicService(): DynamicDataService | null {
  return cachedService;
}

/**
 * Returns true when a DYNAMIC_SKILL_URL is configured and the last remote fetch
 * succeeded (200 or 304). Returns false when no service is configured (tests /
 * local dev with no URL) so callers treat the absence of a dynamic service as
 * "data available" — only fail-safe when the URL is explicitly set but remote
 * is currently unreachable.
 */
export function isDynamicDataFresh(): boolean {
  if (!cachedService) return true;
  return cachedService.lastFetchOk;
}

export async function refreshSkills(force = false): Promise<void> {
  if (!cachedService) return;
  const before = cachedService.getData();
  if (force) {
    await cachedService.forceRefresh();
  } else {
    await cachedService.refreshIfStale();
  }
  const after = cachedService.getData();
  if (after !== before && cached) {
    mergeDynamicIntoStatic(after);
  }
}

export function loadSkills(): Skills {
  const rawAndean = loadJson('andean-scapes.skill.json');
  const rawSales = loadJson('sales-strategy.skill.json');
  const rawMedia = loadJson('media.skill.json');
  const rawFallback = loadJson('fallback-replies.json');

  const andeanScapes = andeanScapesSchema.parse(rawAndean);
  const staticExperiences = andeanScapes.experiences;
  const dynFromService = cachedService?.getData() ?? null;
  const applied = applyAuthoritativeCatalog(andeanScapes, dynFromService, staticExperiences);

  const skills: Skills = {
    andeanScapes: { ...andeanScapes, experiences: applied.experiences },
    salesStrategy: salesStrategySchema.parse(rawSales),
    media: mediaSchema.parse(rawMedia),
    fallbackReplies: fallbackRepliesSchema.parse(rawFallback),
    dynamicMedia: applied.dynamicMedia,
    dynamicData: applied.dynamicData,
  };

  cached = skills;
  return skills;
}

export function getSkills(): Skills {
  if (!cached) {
    return loadSkills();
  }
  return cached;
}

export function stripSkillsPricing(): void {
  if (!cached) return;
  cached = {
    ...cached,
    andeanScapes: {
      ...cached.andeanScapes,
      experiences: cached.andeanScapes.experiences.map(exp => ({
        ...exp,
        pricing: { currency: 'COP', lastUpdated: '1970-01-01', items: [], botRules: [PRICING_NOT_AVAILABLE], businessRules: exp.pricing.businessRules },
        availability: { lastUpdated: '1970-01-01', timezone: 'America/Bogota', availableDates: [], botRule: AVAILABILITY_NOT_AVAILABLE },
      })) as typeof cached.andeanScapes.experiences,
    },
  };
}
