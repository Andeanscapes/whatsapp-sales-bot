import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Skills } from './skill-loader.js';
import { substituteTokens } from './skill-loader.js';
import type { CustomerContext } from './customer-context.js';
import {
  getExperiences,
  getFutureAvailableDates,
  getGalleryImages,
  getPaymentInfo,
  getPlans,
  isAvailabilityAvailable,
  isPricingAvailable,
  resolveExperience,
  type ActiveExperience,
} from './product-registry.js';
import { getEntrySalesComposition, renderReferentStrategies } from './sales-composition.js';
import type { EntryMarker } from './entry-marker.js';
import { calculatePriceQuote, type TransportNeed } from './pricing-calculator.js';
import { AVAILABILITY_NOT_AVAILABLE, type InternalExperienceData, type InternalSiteData } from './dynamic-data-service.js';
import type { LeadPain } from '../db/repositories/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

/**
 * RUNTIME label for the emoji-rotation list.
 *
 * Exported because the prompt skills reference it by name to tell the model where
 * the list comes from. Renaming it here without updating those files would leave
 * the instruction pointing at a block that no longer exists — a test asserts both
 * stay in sync.
 */
export const USED_EMOJIS_RUNTIME_LABEL = 'EMOJIS YA USADOS EN ESTE HILO';

function readPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), 'utf-8');
}

function formatMoney(amount: number, currency: string): string {
  const formatted = amount.toLocaleString('es-CO');
  return currency === 'COP' ? `$${formatted}` : `${formatted} ${currency}`;
}

/**
 * FAQ intents whose answers are safety-critical (health limits, booking windows).
 * These are the topics the engine used to overwrite the LLM reply for; now they are
 * grounded in the prompt instead so the model answers them from validated copy.
 */
const SAFETY_FAQ_INTENTS = new Set(['physical_recovery', 'reservation_lead_time']);

function stripDynamicContextHeader(template: string): string {
  const marker = '# END HEADER';
  const idx = template.indexOf(marker);
  if (idx === -1) return template.trim();
  return template.slice(idx + marker.length).trim();
}

export function renderCatalog(skills: Skills, lang: string = 'es'): string {
  const experiences = getExperiences(skills);
  if (experiences.length === 0) {
    return 'CATALOGO: no hay experiencias cargadas';
  }

  const location = skills.andeanScapes.business.location;
  return experiences.flatMap(exp => {
    const dynamicExperience = skills.dynamicData?.experiences[exp.id];
    if (!dynamicExperience || Object.keys(dynamicExperience.sites).length === 0) {
      return [renderOneExperienceCatalog(exp, location, lang)];
    }
    const multipleSites = Object.keys(dynamicExperience.sites).length > 1;
    return Object.entries(dynamicExperience.sites).map(([siteId, site]) => {
      const scoped = scopeExperienceToSite(exp, siteId, site);
      return renderOneExperienceCatalog(
        scoped,
        site.location ?? location,
        lang,
        multipleSites ? `${siteId}${site.name ? ` — ${site.name}` : ''}` : undefined,
      );
    });
  }).join('\n\n');
}

function scopeExperienceToSite(
  exp: ActiveExperience,
  siteId: string,
  site: InternalSiteData,
): ActiveExperience {
  const route = site.route;
  const safetyFaqs = site.safetyFaqs?.map(faq => ({
    lang: faq.lang,
    intent: faq.intent,
    question: faq.question ?? faq.intent,
    answer: faq.answer,
  }));
  return {
    ...exp,
    clarifications: [...exp.clarifications, ...site.clarifications],
    shortDescription: site.shortDescription ?? exp.shortDescription,
    fullDescription: site.fullDescription ?? exp.fullDescription,
    meetingPoint: site.meetingPoint ?? exp.meetingPoint,
    route: route ? {
      fromBogota: route.fromBogota ?? '',
      alternateRoute: route.alternateRoute,
      localAccess: route.localAccess ?? '',
      arrivalTips: route.arrivalTips,
      ferryInfo: route.ferryInfo,
      botRules: route.botRules ?? [],
    } : exp.route,
    included: site.included ?? exp.included,
    notIncludedUnlessConfirmed: site.notIncludedUnlessConfirmed ?? exp.notIncludedUnlessConfirmed,
    whatToBring: site.whatToBring ?? exp.whatToBring,
    plans: exp.plans.filter(plan => plan.siteId === siteId),
    mineDetails: site.mineDetails ? {
      type: site.mineDetails.type ?? '',
      multipleMines: site.mineDetails.multipleMines ?? true,
      notes: site.mineDetails.notes ?? '',
    } : exp.mineDetails,
    climateInfo: site.climateInfo ?? exp.climateInfo,
    difficulty: site.difficulty ? {
      level: site.difficulty.level ?? '',
      notes: site.difficulty.notes ?? [],
    } : exp.difficulty,
    experienceReality: site.experienceReality ? {
      whatItIs: site.experienceReality.whatItIs ?? '',
      whatItIsNot: site.experienceReality.whatItIsNot ?? '',
      physicalDemands: site.experienceReality.physicalDemands ?? '',
      roadConditions: site.experienceReality.roadConditions ?? '',
      idealFor: site.experienceReality.idealFor ?? '',
      notIdealFor: site.experienceReality.notIdealFor ?? '',
    } : exp.experienceReality,
    haciendaInfo: site.haciendaInfo ?? exp.haciendaInfo,
    safetyInfo: site.safetyInfo ?? exp.safetyInfo,
    commonQuestions: safetyFaqs ?? exp.commonQuestions,
  };
}

function renderOneExperienceCatalog(exp: ActiveExperience, location: string, lang: string = 'es', siteLabel?: string): string {
  const lines: string[] = [
    `### ${exp.id}${siteLabel ? ` / SITE ${siteLabel}` : ''} — ${exp.name}`,
    `status: ${exp.status}`,
    `location: ${location}`,
    `short: ${exp.shortDescription}`,
  ];

  // Clarifications at top level: highest priority, overrides other CATALOGO data.
  if (exp.clarifications && exp.clarifications.length > 0) {
    lines.push('', 'CLARIFICACIONES (prioridad maxima; corrigen cualquier otro dato de este bloque):');
    for (const clarification of exp.clarifications) {
      lines.push(`- ${clarification}`);
    }
  }

  if (exp.meetingPoint) lines.push(`meetingPoint: ${exp.meetingPoint}`);

  const reality = exp.experienceReality;
  if (reality) {
    if (reality.whatItIs) lines.push(`whatItIs: ${reality.whatItIs}`);
    if (reality.whatItIsNot) lines.push(`whatItIsNot: ${reality.whatItIsNot}`);
    if (reality.idealFor) lines.push(`idealFor: ${reality.idealFor}`);
    if (reality.notIdealFor) lines.push(`notIdealFor: ${reality.notIdealFor}`);
    if (reality.physicalDemands) lines.push(`physicalDemands: ${reality.physicalDemands}`);
    if (reality.roadConditions) lines.push(`roadConditions: ${reality.roadConditions}`);
  }

  const plans = getPlans(exp);
  if (plans.length > 0) {
    lines.push('', 'PLANS:');
    for (const plan of plans) {
      lines.push(`- ${plan.id}: ${plan.name} | duration: ${plan.duration}`);
      lines.push(`  short: ${plan.shortDescription}`);
      if (plan.benefits) lines.push(`  benefits: ${plan.benefits}`);
      if (plan.keywords?.length) lines.push(`  keywords: ${plan.keywords.join(', ')}`);
      if (plan.included.length > 0) lines.push(`  includes: ${plan.included.join(', ')}`);
      if (plan.notIncludedUnlessConfirmed.length > 0) {
        lines.push(`  notIncludedUnlessConfirmed: ${plan.notIncludedUnlessConfirmed.join(', ')}`);
      }
      if (plan.itinerary.length > 0) {
        lines.push(`  itinerary: ${plan.itinerary.map(day => `day ${day.day} ${day.title}: ${day.activities.join(', ')}`).join(' | ')}`);
      }
      if (plan.clarifications && plan.clarifications.length > 0) {
        lines.push(`  clarifications: ${plan.clarifications.join(' / ')}`);
      }
    }
  }

  if (exp.included.length > 0) {
    lines.push('', `INCLUDES: ${exp.included.join(', ')}`);
  }
  if (exp.notIncludedUnlessConfirmed.length > 0) {
    lines.push(`NOT_INCLUDED_UNLESS_CONFIRMED: ${exp.notIncludedUnlessConfirmed.join(', ')}`);
  }

  const routeBits = [
    exp.route.fromBogota ? `fromBogota: ${exp.route.fromBogota}` : null,
    exp.route.alternateRoute ? `alternate: ${exp.route.alternateRoute}` : null,
    exp.route.localAccess ? `localAccess: ${exp.route.localAccess}` : null,
    exp.route.ferryInfo ? `ferry: ${exp.route.ferryInfo}` : null,
    exp.route.arrivalTips ? `arrivalTips: ${exp.route.arrivalTips}` : null,
    exp.route.botRules.length > 0 ? `routeRules: ${exp.route.botRules.join('; ')}` : null,
  ].filter((line): line is string => line !== null);
  if (routeBits.length > 0) {
    lines.push('', 'LOGISTICS / ROUTE:');
    lines.push(...routeBits);
  }

  lines.push('', `SAFETY / MINE: ${exp.mineDetails.notes}`);
  if (exp.safetyInfo) {
    const safety = [exp.safetyInfo.equipment, exp.safetyInfo.medicalSupport, exp.safetyInfo.regionSecurity, ...(exp.safetyInfo.notes ?? [])]
      .filter(Boolean);
    if (safety.length > 0) lines.push(`SAFETY_DETAILS: ${safety.join('; ')}`);
  }
  if (exp.haciendaInfo) {
    const hacienda = [exp.haciendaInfo.name, exp.haciendaInfo.activities, ...(exp.haciendaInfo.amenities ?? []), exp.haciendaInfo.notes]
      .filter(Boolean);
    if (hacienda.length > 0) lines.push(`HOST_SITE: ${hacienda.join('; ')}`);
  }
  lines.push(`EMERALD_POLICY: ${exp.emeraldPolicy.notes}`);
  lines.push(`DIFFICULTY: ${exp.difficulty.level}. ${exp.difficulty.notes.join('; ')}`);

  if (exp.climateInfo) {
    const climate = [
      exp.climateInfo.temperature,
      exp.climateInfo.rainySeason,
      exp.climateInfo.notes,
    ].filter(Boolean).join('. ');
    if (climate) lines.push(`CLIMATE: ${climate}`);
  }

  if (exp.whatToBring.length > 0) {
    lines.push(`WHAT_TO_BRING: ${exp.whatToBring.join(', ')}`);
  }

  const policyBits: string[] = [];
  if (exp.agePolicy) policyBits.push(`age min ${exp.agePolicy.minimumAge}: ${exp.agePolicy.notes}`);
  if (exp.petPolicy) policyBits.push(`pets ${exp.petPolicy.allowed ? 'allowed' : 'not allowed'}: ${exp.petPolicy.notes}`);
  if (exp.cancellationPolicy) policyBits.push(`cancel: ${exp.cancellationPolicy.notes}`);
  if (policyBits.length > 0) {
    lines.push(`POLICIES: ${policyBits.join(' | ')}`);
  }

  // Safety-critical FAQs are rendered verbatim. The engine no longer swaps the
  // model's reply for curated copy, so these health/booking-window answers must
  // be in the prompt or the model would have to improvise them.
  // One answer per intent in the active language; falls back to another language
  // when that intent has no copy for `lang`, so an intent is never dropped.
  const byIntent = new Map<string, typeof exp.commonQuestions[number]>();
  for (const q of exp.commonQuestions) {
    if (!SAFETY_FAQ_INTENTS.has(q.intent)) continue;
    const chosen = byIntent.get(q.intent);
    if (!chosen || (q.lang === lang && chosen.lang !== lang)) {
      byIntent.set(q.intent, q);
    }
  }
  const safetyAnswers = [...byIntent.values()];
  if (safetyAnswers.length > 0) {
    lines.push('', 'SAFETY_FAQ (usa estas respuestas casi textuales; no improvises sobre salud ni plazos):');
    for (const q of safetyAnswers) {
      lines.push(`- [${q.intent}${q.lang ? `/${q.lang}` : ''}] ${q.answer}`);
    }
  }

  return lines.join('\n');
}

/** Original flat rendering, used when there is no structured per-site dynamic data
 * (static-only fallback, or dynamic pricing genuinely unavailable). */
function renderFlatPricing(blocks: string[], exp: ActiveExperience): void {
  blocks.push('PLANS_PRICES:');
  for (const item of exp.pricing.items.filter(i => i.publiclyShow)) {
    const parts: string[] = [];
    if (item.pricePerPerson != null) parts.push(`individual ${formatMoney(item.pricePerPerson, exp.pricing.currency)}`);
    if (item.couplePrice != null) parts.push(`couple ${formatMoney(item.couplePrice, exp.pricing.currency)}`);
    const priceLine = parts.length > 0 ? parts.join(' | ') : 'consultar';
    const planKey = item.planId ?? item.id;
    blocks.push(`  ${planKey} (${item.label}): ${priceLine}`);
  }
  const pricingRules = [...new Set([...exp.pricing.botRules, ...exp.pricing.businessRules])];
  if (pricingRules.length > 0) {
    blocks.push(`PRICING_RULES: ${pricingRules.join('; ')}`);
  }
}

function renderFlatAvailability(blocks: string[], exp: ActiveExperience): void {
  if (!isAvailabilityAvailable(exp)) {
    blocks.push('AVAILABILITY: NO DISPONIBLE — el equipo confirma');
    return;
  }
  const dates = getFutureAvailableDates(exp);
  blocks.push(`AVAILABILITY tz=${exp.availability.timezone || 'America/Bogota'}:`);
  for (const d of dates) {
    const slots = d.slotsApprox != null ? `, ~${d.slotsApprox} slots` : '';
    blocks.push(`  ${d.date} (${d.status}${slots})`);
  }
  blocks.push(`AVAILABILITY_RULE: ${exp.availability.botRule}`);
}

/**
 * Emits the ONE campaign segment matching the lead's entry marker, never the whole
 * map. Rendering all six would cost ~950 tokens per request and invite cross-segment
 * bleed (a 4x4 hook offered to a family lead). No marker, or a marker the feed does
 * not define, renders nothing — the sales skill then uses its generic first-contact
 * path.
 */
function renderEntrySegment(
  blocks: string[],
  site: InternalSiteData,
  entryMarkerCode?: string | null,
): void {
  if (!entryMarkerCode) return;
  const segment = site.entrySegments?.[entryMarkerCode];
  if (!segment) return;

  blocks.push(`  ENTRY_SEGMENT ${entryMarkerCode}${segment.label ? ` (${segment.label})` : ''}:`);
  if (segment.valueHook) blocks.push(`    valueHook: ${segment.valueHook}`);
  if (segment.diagnosisQuestion) blocks.push(`    diagnosisQuestion: ${segment.diagnosisQuestion}`);
  if (segment.planMatch) blocks.push(`    planMatch: ${segment.planMatch}`);
}

/**
 * Site-grouped rendering: every plan price, addon, rule, and availability window is
 * scoped under `SITE <id>:` and pulled straight from the structured dynamic data (not
 * the flattened compat fields), so an addon or rule defined at one site can never be
 * misread as applying to another. Addons are tagged `[plans: ...]` when scoped to
 * specific plans, or `[site-wide]` when the site offers them independent of plan.
 *
 * Static `businessRules` (experience-level, not site-owned) are emitted once after all
 * SITE blocks, deduped against every site's rules so the prior DATOS contract
 * (botRules ∪ businessRules) is preserved on the live sites path.
 */
function renderSiteBlocks(
  blocks: string[],
  dynExp: InternalExperienceData,
  sites: Record<string, InternalSiteData>,
  currency: string,
  businessRules: string[] = [],
  includePricing = true,
  entryMarkerCode?: string | null,
): void {
  const emittedSiteRules = new Set<string>();

  for (const [siteId, site] of Object.entries(sites)) {
    blocks.push('', `SITE ${siteId}:`);
    renderEntrySegment(blocks, site, entryMarkerCode);
    const siteItems = includePricing
      ? dynExp.pricing.items.filter(i => i.siteId === siteId && i.publiclyShow)
      : [];

    const planItems = siteItems.filter(i => i.kind === 'plan');
    if (planItems.length > 0) {
      blocks.push('  PLANS_PRICES:');
      for (const item of planItems) {
        const parts: string[] = [];
        if (item.pricePerPerson != null) parts.push(`individual ${formatMoney(item.pricePerPerson, currency)}`);
        if (item.couplePrice != null) parts.push(`couple ${formatMoney(item.couplePrice, currency)}`);
        const priceLine = parts.length > 0 ? parts.join(' | ') : 'consultar';
        blocks.push(`    ${item.planId ?? item.id} (${item.label}): ${priceLine}`);
      }
    }

    const addonItems = siteItems.filter(i => i.kind === 'addon');
    if (addonItems.length > 0) {
      blocks.push('  ADDONS:');
      const byAddonId = new Map<string, typeof addonItems>();
      for (const item of addonItems) {
        byAddonId.set(item.id, [...(byAddonId.get(item.id) ?? []), item]);
      }
      for (const [addonId, group] of byAddonId) {
        const planTags = group.map(i => i.planId).filter((p): p is string => Boolean(p));
        const scope = planTags.length > 0 ? `plans: ${planTags.join(', ')}` : 'site-wide';
        const first = group[0];
        const priceParts: string[] = [];
        if (first.pricePerPerson != null) priceParts.push(`${formatMoney(first.pricePerPerson, currency)} pp`);
        if (first.couplePrice != null) {
          const maxNote = first.peopleIncluded != null ? ` (max ${first.peopleIncluded})` : '';
          priceParts.push(`${formatMoney(first.couplePrice, currency)}${maxNote}`);
        }
        const priceLine = priceParts.length > 0 ? priceParts.join(' | ') : 'consultar';
        blocks.push(`    ${addonId} [${scope}] (${first.label}): ${priceLine}`);
      }
    }

    if (includePricing && site.rules.length > 0) {
      blocks.push(`  PRICING_RULES: ${site.rules.join('; ')}`);
      for (const rule of site.rules) emittedSiteRules.add(rule);
    }

    const bookableDates = site.availability.availableDates.filter(
      d => d.status === 'available' || d.status === 'limited',
    );
    if (site.availability.botRule !== AVAILABILITY_NOT_AVAILABLE || bookableDates.length > 0) {
      blocks.push(`  AVAILABILITY tz=${site.availability.timezone}:`);
      for (const d of bookableDates) {
        const slots = d.slotsApprox != null ? `, ~${d.slotsApprox} slots` : '';
        blocks.push(`    ${d.date} (${d.status}${slots})`);
      }
      blocks.push(`  AVAILABILITY_RULE: ${site.availability.botRule}`);
    } else {
      blocks.push('  AVAILABILITY: NO DISPONIBLE — el equipo confirma');
    }
  }

  const leftoverBusinessRules = includePricing
    ? [...new Set(businessRules.map(r => r.trim()).filter(Boolean))]
      .filter(rule => !emittedSiteRules.has(rule))
    : [];
  if (leftoverBusinessRules.length > 0) {
    blocks.push(`PRICING_RULES: ${leftoverBusinessRules.join('; ')}`);
  }
}

export function renderBusinessData(skills: Skills, entryMarkerCode?: string | null): string {
  const blocks: string[] = [];
  const business = skills.andeanScapes.business;
  blocks.push('BRAND:');
  blocks.push(`name: ${business.name}`);
  blocks.push(`location: ${business.location}`);
  if (business.shortBrandIntro) {
    blocks.push(`shortBrandIntro: ${business.shortBrandIntro}`);
  }

  const paymentData = getPaymentInfo(skills);

  if (paymentData) {
    const enabledMethods = paymentData.methods.filter(m => m.enabled).map(m => m.name);
    blocks.push('PAYMENTS (global):');
    blocks.push(`currency: ${paymentData.currency}`);
    blocks.push(
      `deposit: ${paymentData.deposit.value}% — ${paymentData.deposit.label}; remaining ${paymentData.deposit.remainingBalance.value}%`,
    );
    if (enabledMethods.length > 0) {
      blocks.push(`methods_enabled: ${enabledMethods.join(', ')}`);
    }
    blocks.push(`confirmation: ${paymentData.confirmation.message}`);
    blocks.push(
      `displayPolicy: no payment details before availability validation=${paymentData.displayPolicy.showMethodsAfterAvailabilityValidation}; never full pay without confirmation=${paymentData.displayPolicy.neverRequestFullPaymentWithoutConfirmation}; LLM never outputs phones/links`,
    );
  } else if (!skills.dynamicData) {
    const fallback = skills.andeanScapes.business.publicPaymentFallback;
    blocks.push('PAYMENTS (global):');
    blocks.push(`deposit: ${fallback.depositPercent}%`);
    blocks.push(`methods_enabled: ${fallback.methodNames.join(', ')}`);
    blocks.push('displayPolicy: LLM never outputs phones/links; deterministic system owns payment-detail release');
  } else {
    blocks.push('PAYMENTS (global): NO DISPONIBLE — el equipo confirma');
  }

  const reservationPolicy = skills.dynamicData?.reservationPolicy;
  if (reservationPolicy?.rescheduling) {
    blocks.push('');
    blocks.push('RESERVATION_POLICY:');
    blocks.push(
      `reschedule free until ${reservationPolicy.rescheduling.freeUntilDaysBefore} days before; late: ${reservationPolicy.rescheduling.lateChangeRule}`,
    );
  }

  for (const exp of getExperiences(skills)) {
    blocks.push('');
    blocks.push(`### ${exp.id} — LIVE DATA`);
    blocks.push(`currency: ${exp.pricing.currency}`);

    const dynExp = skills.dynamicData?.experiences[exp.id];
    const sites = dynExp?.sites;
    const pricingAvailable = isPricingAvailable(exp);

    if (dynExp && sites && Object.keys(sites).length > 0) {
      if (!pricingAvailable) blocks.push('PRICING: NO DISPONIBLE — el equipo confirma');
      renderSiteBlocks(
        blocks,
        dynExp,
        sites,
        exp.pricing.currency,
        exp.pricing.businessRules,
        pricingAvailable,
        entryMarkerCode,
      );
    } else if (!pricingAvailable) {
      blocks.push('PRICING: NO DISPONIBLE — el equipo confirma');
      renderFlatAvailability(blocks, exp);
    } else {
      // Defensive fallback: pricing is available but the dynamic feed did not report
      // structured site data (should not happen once every payload uses sites).
      renderFlatPricing(blocks, exp);
      renderFlatAvailability(blocks, exp);
    }

    blocks.push('media: ownerImage/planImages/gallery available for code-side send');
  }

  return blocks.join('\n');
}

/** True when any site in the live feed defines copy for this entry marker code. */
function hasEntrySegment(skills: Skills, entryMarkerCode: string): boolean {
  const experiences = Object.values(skills.dynamicData?.experiences ?? {});
  return experiences.some(exp =>
    Object.values(exp.sites).some(site => site.entrySegments?.[entryMarkerCode] != null),
  );
}

export interface AssembleSystemPromptInput {
  skills: Skills;
  lang?: string;
  collectedFields?: Record<string, unknown>;
  salesPhase?: string;
  customerContext?: CustomerContext;
  selectedExperienceId?: string | null;
  entryMarker?: EntryMarker | null;
  priorContext?: string | null;
  leadPain?: LeadPain | null;
  /** True when the customer already saw a plan total earlier in this conversation. */
  priceGiven?: boolean;
  /** Latest inbound text — used only for RUNTIME intent cues, never quoted back. */
  latestCustomerMessage?: string;
  /**
   * Emoji graphemes this thread already used in our own replies. Passed as state so
   * the model can pick a different one: a static "no repitas" rule has no per-turn
   * signal behind it and the model defaults to the same glyph. It never selects the
   * emoji for the model, and an empty list adds no line at all.
   */
  usedEmojis?: string[];
  /** True only when this inbound selected a concrete date from current availability. */
  dateSelectedThisTurn?: boolean;
  /** True when this inbound accepts the hard T3b validation CTA. */
  closeCtaAcceptedThisTurn?: boolean;
  /**
   * Proactive (non-inbound) turn. `consent_ask` asks permission to keep writing
   * after the 24h window closes. The MODEL writes the text; the engine only
   * validates and strips the marker (see AGENTS.md invariants 8 and 9).
   */
  proactiveMode?: 'consent_ask';
  /** Retry after an invalid consent draft; reinforces shape without supplying copy. */
  consentAskRetryInstruction?: boolean;
  /**
   * True when this is a consent ask AND the customer previously opted out and
   * has now returned. Signals the model to use a different tone: acknowledge
   * their control, answer their question, and ask only if they want to hear
   * about future updates.
   */
  reaskAfterOptOut?: boolean;
  /**
   * True when this inbound is the customer accepting the follow-up permission.
   * Without this the model can read a bare "si" as a booking confirmation.
   */
  consentAcceptedThisTurn?: boolean;
  /** New inbound reopened permission eligibility after a customer opt-out. */
  followupReopenedThisTurn?: boolean;
  /** True after any LLM gallery was delivered in this conversation. */
  galleryShown?: boolean;
  galleryRequestThemes?: string[];
  galleryImagesRemaining?: number;
  galleryRetryInstruction?: boolean;
  advanceQuestionRetryInstruction?: boolean;
}

export function assembleSystemPrompt(input: AssembleSystemPromptInput): string {
  const { skills, lang, collectedFields, salesPhase, customerContext, selectedExperienceId, entryMarker, priorContext, leadPain, priceGiven, latestCustomerMessage, dateSelectedThisTurn, closeCtaAcceptedThisTurn, proactiveMode, consentAskRetryInstruction, reaskAfterOptOut, consentAcceptedThisTurn, followupReopenedThisTurn, usedEmojis, galleryShown, galleryRequestThemes, galleryImagesRemaining, galleryRetryInstruction, advanceQuestionRetryInstruction } = input;

  const personality = substituteTokens(readPrompt('seller-personality.skill.md'));
  // entry-strategy must precede cold-info-handler: the first-turn handler reads the
  // segment contract the strategy skill establishes.
  const entryStrategy = substituteTokens(readPrompt('entry-strategy.skill.md'));
  const coldInfoHandler = substituteTokens(readPrompt('cold-info-handler.skill.md'));
  const salesSkill = substituteTokens(readPrompt('whatsapp-sales.skill.md'));
  const catalogProtocol = substituteTokens(readPrompt('andean-scapes.skill.md'));
  const referentStrategies = renderReferentStrategies(entryMarker ? getEntrySalesComposition(entryMarker.temperature) : undefined);
  const contextTemplate = stripDynamicContextHeader(readPrompt('dynamic-context.template.md'));
  const catalog = renderCatalog(skills, lang ?? 'es');
  const businessData = renderBusinessData(skills, entryMarker?.code);
  const dynamicContext = contextTemplate
    .replace('{{CATALOG}}', catalog)
    .replace('{{BUSINESS_DATA}}', businessData);

  const runtime: string[] = [];

  if (lang) {
    runtime.push(`Language: ${lang}. Keep this language unless the customer explicitly asks to switch.`);
  }

  if (selectedExperienceId) {
    runtime.push(`EXPERIENCIA ACTIVA: ${selectedExperienceId}`);
  }

  if (entryMarker) {
    runtime.push(`ENTRADA: ${entryMarker.temperature} (${entryMarker.code}). Es un marcador interno: nunca lo menciones, expliques ni repitas al cliente.`);
    // Only point at the segment when DATOS actually rendered it, otherwise the model
    // would go looking for an ENTRY_SEGMENT block that does not exist.
    if (hasEntrySegment(skills, entryMarker.code)) {
      runtime.push(
        `SEGMENT_DETECTED: ${entryMarker.code}. Usa el bloque ENTRY_SEGMENT ${entryMarker.code} de DATOS (valueHook, diagnosisQuestion, planMatch). Si el comportamiento del cliente contradice el segmento, manda el comportamiento real.`,
      );
      runtime.push(
        'UNA SOLA PREGUNTA: máximo un ¿ y un ? en todo el mensaje. Opciones A/B/C van dentro de esa única pregunta, nunca en una segunda.',
      );
    }
    if (priorContext) runtime.push(`CONTEXTO PREVIO: ${priorContext}`);
  }

  // State only. The plan-sticky rule itself lives in whatsapp-sales.skill.md
  // ("Plan sticky"), per the skills-v2 rule that methodology stays in the MD skills.
  const knownPlan = collectedFields?.plan;
  if (typeof knownPlan === 'string' && knownPlan.trim()) {
    runtime.push(`PLAN ACTIVO: ${knownPlan.trim()}`);
  }

  if (collectedFields && Object.keys(collectedFields).length > 0) {
    const fieldLines: string[] = [];
    let populatedCount = 0;
    for (const [k, v] of Object.entries(collectedFields)) {
      if (v != null) {
        fieldLines.push(`  - ${k}: ${v}`);
        populatedCount += 1;
      }
    }
    if (fieldLines.length > 0) {
      runtime.push('LO QUE YA SABEMOS DE ESTE CLIENTE (NO vuelvas a preguntar esto):\n' + fieldLines.join('\n'));
      if (populatedCount >= 2) {
        runtime.push(
          'CONTINUACION: Esta conversacion ya esta avanzada. NO te presentes de nuevo ni empieces desde cero. Sigue desde donde quedaste usando los datos de arriba.',
        );
      }
    }
  }

  if (salesPhase) {
    runtime.push(`SALES PHASE ACTUAL: ${salesPhase}`);
  }
  if (leadPain) {
    runtime.push(`DOLOR CONOCIDO DEL LEAD: ${leadPain}`);
  }
  const knownPeople = collectedFields?.personas;
  if (typeof knownPeople === 'number' && knownPeople > skills.salesStrategy.maxGroupSizePerDate) {
    runtime.push(`GRUPO GRANDE: ${knownPeople} personas (max regular ${skills.salesStrategy.maxGroupSizePerDate}). El equipo debe validar capacidad y precio exacto. No inventes.`);
  }
  // QUOTE LOCK only when the plan is genuinely settled: either the customer chose
  // it, or the experience has exactly one plan so there is nothing to choose.
  // Never fall back to plans[0] — that would inject an "authoritative" total for a
  // plan the customer never picked and push the model past the price gate.
  const activeExperience = resolveExperience(skills, selectedExperienceId);
  const activePlans = getPlans(activeExperience);
  const lockedPlanId =
    typeof knownPlan === 'string' && knownPlan.trim() ? knownPlan.trim()
    : activePlans.length === 1 ? activePlans[0].id
    : null;
  const knownDate = collectedFields?.date ?? collectedFields?.fecha;
  // Day-level only ("14 de noviembre", "7 de agosto"). Month-only ("noviembre") is
  // still discovery — T3b would skip motive/date choice and jump to payment CTA.
  const hasConcreteDate = typeof knownDate === 'string' && (
    /\b\d{1,2}\b/.test(knownDate)
    || /\b\d{4}-\d{2}-\d{2}\b/.test(knownDate)
  );
  // Date accept without price: must deliver exact total first (T3a).
  // Date accept with price: close CTA + anticipo flow (T3b).
  const priceBeforeCloseTurn = Boolean(
    !priceGiven && dateSelectedThisTurn && hasConcreteDate && typeof knownPeople === 'number' && lockedPlanId,
  );
  const t3bCloseTurn = Boolean(
    !closeCtaAcceptedThisTurn && priceGiven && hasConcreteDate && typeof knownPeople === 'number' && lockedPlanId,
  );
  // Pushed here, not with the other phase cues, because its wording depends on
  // `t3bCloseTurn`. The generic tail ("Fechas/motivo → solo fechas + 1 pregunta") is right
  // while the customer is still choosing a date, but on a close turn it CONTRADICTS
  // `ESTADO DE TURNO: T3b` — the inbound IS a date, so the model read "only dates + 1
  // question" and answered with a T3a-shaped soft question instead of the anticipo CTA
  // (live `vacation-motive-discovery-baredate`, 1/3 runs). The no-re-quote half must stay
  // in both variants: it is what stops the model re-pricing a DIFFERENT plan on the close.
  if (priceGiven) {
    runtime.push(
      t3bCloseTurn
        ? 'PRECIO YA ENTREGADO: no repitas el total ni $ ni COP, y no cotices otro plan. Este turno cierra (T3b), no vuelve a ofrecer fechas.'
        : 'PRECIO YA ENTREGADO: no repitas $ ni COP del plan salvo que el cliente pida otra cotización. Fechas/motivo → solo fechas + 1 pregunta.',
    );
  }
  if (priceBeforeCloseTurn) {
    const quote = calculatePriceQuote(activeExperience, {
      planId: lockedPlanId,
      people: knownPeople,
      transportNeed: typeof collectedFields?.transporte === 'string'
        ? collectedFields.transporte as TransportNeed
        : undefined,
    });
    if (quote) {
      runtime.push(
        'ESTADO DE TURNO: T3a. El cliente eligió una fecha concreta en este inbound y todavía no recibió el precio. Aplica whatsapp-sales.skill.md §T3a usando QUOTE LOCK.',
      );
    }
  }
  if (t3bCloseTurn) {
    runtime.push(
      'ESTADO DE TURNO: T3b. Hay fecha concreta y el precio ya fue entregado. Aplica whatsapp-sales.skill.md §T3b.',
    );
  }
  if (closeCtaAcceptedThisTurn) {
    const missingOperationalField = collectedFields?.nombre == null
      ? 'nombre'
      : collectedFields?.transporte == null
        ? 'transporte'
        : 'ninguno';
    runtime.push(`ESTADO DE TURNO: POST-CTA. El cliente aceptó iniciar la validación y la alerta al equipo ya está en curso. Aplica whatsapp-sales.skill.md §POST-CTA. DATO OPERATIVO FALTANTE: ${missingOperationalField}.`);
  }
  const asksHowToReserve = typeof latestCustomerMessage === 'string'
    && /\b(?:c[oó]mo\s+reservo|como\s+reservo|c[oó]mo\s+pago|como\s+pago|c[oó]mo\s+se\s+reserva|quiero\s+reservar|how\s+(?:do\s+i\s+)?(?:book|reserve|pay)|what(?:'s|\s+is)\s+next\s+to\s+book)\b/i.test(latestCustomerMessage);
  if (!priceBeforeCloseTurn && !closeCtaAcceptedThisTurn && (asksHowToReserve || salesPhase === 'closing')) {
    runtime.push('INTENCION DE RESERVA: el cliente preguntó cómo continuar. Aplica el turno correspondiente de whatsapp-sales.skill.md según los datos conocidos.');
  }
  if (typeof knownPeople === 'number' && !lockedPlanId && activePlans.length > 1) {
    runtime.push('PRICE GATE ACTIVO: ya conoces el grupo, pero falta elegir plan. No escribas precios ni totales; pregunta por el plan o la duracion.');
  }
  if (!t3bCloseTurn && typeof knownPeople === 'number' && lockedPlanId && isPricingAvailable(activeExperience)) {
    const quote = calculatePriceQuote(activeExperience, {
      planId: lockedPlanId,
      people: knownPeople,
      transportNeed: typeof collectedFields?.transporte === 'string'
        ? collectedFields.transporte as TransportNeed
        : undefined,
    });
    if (quote) {
      const amount = quote.total ?? quote.planTotal;
      const transportNote = quote.requiresTransportConfirmation
        ? ' Transporte adicional pendiente de confirmacion; no inventes ese valor.'
        : '';
      // The plan is settled and no price has gone out yet, so the total belongs in
      // THIS reply. Live `plan-selection-gallery` (0/2 runs) described the chosen plan
      // and asked for a month instead, stranding the lead one turn short of the quote
      // that §FASE 3 already required. Gated on `!priceGiven` so it can never
      // contradict the `PRECIO YA ENTREGADO` cue pushed above, which forbids
      // repeating the total — that contradiction class already cost a live suite once.
      const quoteDueNote = priceGiven
        ? ''
        : ' Este turno entrega ese total; no lo pospongas para despues de preguntar fecha o mes.';
      runtime.push(
        `QUOTE LOCK: escribe "Para ${quote.people} personas, el plan queda en ${formatMoney(amount, quote.currency)} ${quote.currency}". Copia esas personas y ese total; no recalcules ni redondees otra cifra.${transportNote}${quoteDueNote}`,
      );
    }
  }
  if (collectedFields?.mascota === 'yes') {
    runtime.push('PET: usa petPolicy del CATALOGO para confirmar que la mascota es bienvenida.');
  }

  const customerContextLines = [
    customerContext?.name ? `Name: ${customerContext.name}` : null,
    customerContext?.people != null ? `People: ${customerContext.people}` : null,
    customerContext?.date ? `Date mentioned: ${customerContext.date}` : null,
    customerContext?.transport ? `Transport mentioned: ${customerContext.transport}` : null,
    customerContext?.childAges?.length ? `Child ages mentioned: ${customerContext.childAges.join(', ')}` : null,
    customerContext?.groupRelationship ? `Group relationship: ${customerContext.groupRelationship}` : null,
    customerContext?.lodgingNeeded ? 'Lodging mentioned: yes' : null,
    customerContext?.pet ? 'Pet mentioned: yes' : null,
  ].filter((line): line is string => line !== null);
  if (customerContextLines.length > 0) {
    runtime.push(
      `EXPLICIT CONTEXT FROM THE LATEST CUSTOMER MESSAGE:\n${customerContextLines.map(line => `  - ${line}`).join('\n')}`,
    );
  }

  // Style state, not copy: the model still decides which glyph fits, or none.
  if (usedEmojis && usedEmojis.length > 0) {
    runtime.push(
      `${USED_EMOJIS_RUNTIME_LABEL}: ${usedEmojis.join(' ')} — no repitas ninguno de estos. Si te sirve un emoji en este turno, elegí otro del allowlist que calce con el tema; si los que calzan ya salieron, escribe sin emoji.`,
    );
  }

  // GALERIA: list available themes so LLM can emit valid markers
  const galleryImages = getGalleryImages(skills, selectedExperienceId ?? activeExperience.id);
  const collectedPlanId = typeof collectedFields?.plan === 'string' ? collectedFields.plan : null;
  const selectedPlanSiteId = collectedPlanId
    ? activeExperience.plans.find(plan => plan.id === collectedPlanId)?.siteId
    : undefined;
  const sitesByTheme = new Map<string, Set<string>>();
  for (const image of galleryImages) {
    if (!image.type) continue;
    const sites = sitesByTheme.get(image.type) ?? new Set<string>();
    sites.add(image.siteId ?? '');
    sitesByTheme.set(image.type, sites);
  }
  const galleryThemes = [...sitesByTheme.entries()]
    .filter(([, sites]) => selectedPlanSiteId ? sites.has(selectedPlanSiteId) : sites.size === 1)
    .map(([theme]) => theme);
  if (galleryThemes.length > 0) {
    runtime.push(`TEMAS DE GALERIA DISPONIBLES: ${galleryThemes.join(', ')}.`);
  }
  if (galleryShown) runtime.push('GALERIA_YA_MOSTRADA: true');
  if (galleryRequestThemes && galleryRequestThemes.length > 0) {
    runtime.push(`PEDIDO DE FOTOS ESTE TURNO: ${galleryRequestThemes.join(', ')}.`);
  }
  if (galleryImagesRemaining !== undefined) {
    runtime.push(`CUPO_FOTOS_RESTANTE: ${galleryImagesRemaining}.`);
  }
  if (galleryRetryInstruction && galleryRequestThemes && galleryRequestThemes.length > 0) {
    const exactMarker = `[[FOTOS:${galleryRequestThemes.join(',')}]]`;
    runtime.push(`CORRECCION FOTOS: el pedido explicito de fotos quedo sin marcador. Reescribe este mismo turno sin agregar copy del sistema y termina literalmente con ${exactMarker} en su propia linea. Conserva exactamente esos ids; no escribas "tema" ni sustituyas el marcador.`);
  }
  if (advanceQuestionRetryInstruction) {
    runtime.push('CORRECCION PREGUNTA: reescribe este mismo turno completo. El texto visible debe terminar con exactamente una pregunta de avance adecuada a la fase actual. No agregues una pregunta generica si corresponde pedir fecha, plan, grupo o cierre. Si hay marcador [[FOTOS:...]], la pregunta va inmediatamente antes y el marcador conserva la ultima linea.');
  }

  // Pushed last so it overrides the sales-turn cues above: this turn is not a
  // reply to an inbound and must not continue the sales script.
  if (proactiveMode === 'consent_ask') {
    runtime.push(
      [
        'ESTADO DE TURNO: PERMISO-SEGUIMIENTO.',
        'Este estado ANULA cualquier pregunta pendiente, CTA, fase de venta o instrucción comercial anterior.',
        'El mensaje actual contiene el marcador interno [[PROACTIVE_FOLLOWUP_CONSENT_TURN]]: NO es texto del cliente y nunca debes repetirlo.',
        // The post-stop variant is an ADDITION to §PERMISO-SEGUIMIENTO, never a
        // replacement: it only reframes tone. Presenting it as an alternative
        // section let the model drop the mandatory marker.
        reaskAfterOptOut
          ? 'Aplica whatsapp-sales.skill.md §PERMISO-SEGUIMIENTO y ADEMAS la variante §PERMISO-SEGUIMIENTO-POST-PARADA (mismo turno proactivo, tono mas breve, sin mencionar la pausa anterior).'
          : 'Aplica únicamente whatsapp-sales.skill.md §PERMISO-SEGUIMIENTO.',
        'Tu salida debe ser solo el breve mensaje de permiso, con exactamente una pregunta, y terminar literalmente con [[FOLLOWUP_CONSENT]].',
        'Prohibido preguntar por fecha, plan, precio, personas, reserva o pago en este turno.',
      ].join(' '),
    );
    if (consentAskRetryInstruction) {
      runtime.push('CORRECCION PERMISO: el borrador anterior fue invalido porque no cumplio el formato interno. Reescribe el mensaje completo aplicando §PERMISO-SEGUIMIENTO. No continues la venta ni respondas preguntas pendientes. La ultima linea debe ser exactamente [[FOLLOWUP_CONSENT]].');
    }
  }
  if (consentAcceptedThisTurn) {
    runtime.push('ESTADO DE TURNO: PERMISO-CONCEDIDO. Aplica whatsapp-sales.skill.md §PERMISO-CONCEDIDO. El cliente aceptó recibir mensajes futuros; NO es una confirmación de reserva, fecha ni pago.');
  }
  if (followupReopenedThisTurn) {
    runtime.push(
      'CONVERSACION REACTIVADA POR EL CLIENTE: antes pidió detener mensajes automáticos y ahora inició voluntariamente una nueva conversación. Responde su consulta normalmente. Si es útil, aclara brevemente que su solicitud anterior detuvo los seguimientos; este inbound permite conversar pero NO vuelve a autorizar templates ni mensajes futuros. Solo un nuevo "sí" a una pregunta posterior de permiso puede reactivarlos.',
    );
  }

  const parts = [
    personality.trim(),
    '',
    entryStrategy.trim(),
    '',
    coldInfoHandler.trim(),
    '',
    salesSkill.trim(),
    '',
    catalogProtocol.trim(),
    '',
    referentStrategies.trim(),
    '',
    dynamicContext.trim(),
  ];
  if (runtime.length > 0) {
    parts.push('', '---', 'RUNTIME:', ...runtime);
  }

  return parts.join('\n');
}
