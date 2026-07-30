import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Skills } from './skill-loader.js';
import { substituteTokens } from './skill-loader.js';
import { getActiveExperience, getFutureAvailableDates, getPaymentInfo, getPlans, getShortDescription, isPricingAvailable, isAvailabilityAvailable, resolveExperience } from './product-registry.js';
import type { CustomerContext } from './customer-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSystemPrompt(): string {
  return substituteTokens(
    readFileSync(join(__dirname, '..', 'prompts', 'deepseek-system.prompt.md'), 'utf-8')
  );
}

function readFollowUpPrompt(): string {
  return substituteTokens(
    readFileSync(join(__dirname, '..', 'prompts', 'deepseek-follow-up.prompt.md'), 'utf-8')
  );
}

export function buildFollowUpPrompt(input: {
  skills: Skills;
  lang: 'es' | 'en';
  phase: string | null;
  stage: 'first_nudge' | 'second_nudge';
  reviewReminder?: boolean;
  knownPeople?: number | null;
  knownDate?: string | null;
  knownPriceFormatted?: string | null;
}): string {
  const experience = getActiveExperience(input.skills);
  const knownLines: string[] = [];
  if (input.knownPeople != null) knownLines.push(`Known people: ${input.knownPeople}`);
  if (input.knownDate) knownLines.push(`Known date: ${input.knownDate}`);
  if (input.knownPriceFormatted) knownLines.push(`Known quoted price: ${input.knownPriceFormatted}`);
  return [
    readFollowUpPrompt(),
    '',
    'FOLLOW-UP BUSINESS CONTEXT:',
    `Supported experience: ${experience.name}`,
    `Description: ${getShortDescription(experience)}`,
    '',
    'FOLLOW-UP SETTINGS:',
    `Language: ${input.lang}`,
    `Phase: ${input.phase ?? 'unknown'}`,
    `Stage: ${input.stage}`,
    ...(input.reviewReminder ? ['Mode: review_reminder'] : []),
    ...knownLines,
  ].join('\n');
}

export function buildSystemPrompt(skills: Skills, lang?: string, collectedFields?: Record<string, unknown>, salesPhase?: string, customerContext?: CustomerContext, selectedExperienceId?: string | null): string {
  const base = readSystemPrompt();
  const exp = resolveExperience(skills, selectedExperienceId);
  const route = exp.route;
  const tactics = skills.salesStrategy.salesTactics;

  const pricingAvailable = isPricingAvailable(exp);
  const availabilityAvailable = isAvailabilityAvailable(exp);
  const availableDates = getFutureAvailableDates(exp);

  const dateList = availabilityAvailable
    ? availableDates
        .map(d => {
          const dObj = new Date(d.date + 'T00:00:00');
          const dayName = dObj.toLocaleDateString(lang === 'en' ? 'en-US' : 'es-CO', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          return `${dayName} (${d.status}${d.slotsApprox ? `, ~${d.slotsApprox} slots` : ''})`;
        })
        .join(', ')
    : null;

  const pricingItems = pricingAvailable
    ? exp.pricing.items
        .filter(i => i.publiclyShow)
        .map(i =>
          i.couplePrice ? `${i.label}: ${i.couplePrice.toLocaleString('en-US')} COP total` : i.pricePerPerson ? `${i.label}: ${i.pricePerPerson.toLocaleString('en-US')} COP` : `${i.label}: consultar`
        ).join(' | ')
    : null;

  const pricingRules = pricingAvailable ? exp.pricing.botRules.join('; ') : null;
  // Durable business rules (group formulas, addon/transport policy, cancellation,
  // pet/age, never-invent-discounts) apply even when live pricing is unavailable.
  // When pricing IS available they are already merged into botRules, so only
  // surface them standalone in the unavailable case to avoid duplication.
  const businessRules = !pricingAvailable && exp.pricing.businessRules.length > 0
    ? exp.pricing.businessRules.join('; ')
    : null;
  const included = exp.included.join(', ');
  const notIncluded = exp.notIncludedUnlessConfirmed.join(', ');
  const reservationFlow = exp.reservationFlow.join('; ');

  // ── Payment info (from remote dynamic JSON) ──────────────────────────────
  const paymentData = getPaymentInfo(skills);
  const paymentFacts: string[] = [];
  if (paymentData) {
    paymentFacts.push(`Payment currency: ${paymentData.currency}`);
    paymentFacts.push(`Deposit required: ${paymentData.deposit.value}% (${paymentData.deposit.label})`);
    const enabledMethods = paymentData.methods.filter(m => m.enabled).map(m => m.name);
    if (enabledMethods.length > 0) {
      paymentFacts.push(`Enabled payment method names: ${enabledMethods.join(', ')}`);
    }
    paymentFacts.push(`Payment details require prior availability validation: ${paymentData.displayPolicy.showMethodsAfterAvailabilityValidation}`);
    paymentFacts.push(`Never reveal phone numbers, payment links, transfer instructions, or request payment. The deterministic system owns payment-detail release.`);
  }
  // ──────────────────────────────────────────────────────────────────────────

  const ferryInfo = route.ferryInfo ?? '';
  const alternateRoute = route.alternateRoute ?? '';
  const arrivalTips = route.arrivalTips ?? '';
  const fromBogota = route.fromBogota ?? '';
  const routeBotRules = route.botRules.join('; ');

  const climateText = exp.climateInfo
    ? `${exp.climateInfo.temperature ?? ''}. ${exp.climateInfo.rainySeason ?? ''}. ${exp.climateInfo.notes ?? ''}`
    : '';

  const difficultyText = `${exp.difficulty.level}. ${exp.difficulty.notes.join('; ')}`;

  const roadInfo = exp.experienceReality?.roadConditions ?? '';
  const idealFor = exp.experienceReality?.idealFor ?? '';
  const notIdealFor = exp.experienceReality?.notIdealFor ?? '';

  const adventureFilter = exp.botBehavior?.adventureFilter ?? '';
  const qualPhases = exp.botBehavior?.qualificationPhases;
  const handoffExactReply = exp.botBehavior?.handoffExactReply;
  const negativeExamples = exp.botBehavior?.negativeExamples ?? '';

  const shortDesc = exp.shortDescription;
  const meetingPt = exp.meetingPoint;
  const plansList = getPlans(exp)
    .map(p => `${p.id} — ${p.name} (${p.duration}): ${p.shortDescription} | Benefits: ${p.benefits}`).join('\n');

  const dataUnavailableRules = [
    !pricingAvailable ? '[CRITICAL RULE] NO hay precios actualizados. NO des cifras ni calcules valores; explica que el equipo debe confirmarlos.' : null,
    !availabilityAvailable ? '[CRITICAL RULE] NO hay fechas publicadas. NO des fechas concretas ni prometas cupo; explica que debes verificar disponibilidad.' : null,
  ].filter((rule): rule is string => rule !== null);

  const facts = [
    `Business: ${skills.andeanScapes.business.name} — ${shortDesc}`,
    `Brand intro: ${skills.andeanScapes.business.shortBrandIntro ?? ''}`,
    `Location: ${skills.andeanScapes.business.location}${meetingPt ? '. Meeting point: ' + meetingPt : ''}`,
    lang ? `Language: ${lang}. Keep this language unless the customer explicitly asks to switch.` : null,
    '---',
    `AVAILABLE PLANS:\n${plansList}`,
    '---',
    `Route from Bogota: ${fromBogota}`,
    alternateRoute ? `Alternate route: ${alternateRoute}` : null,
    ferryInfo ? `Ferry: ${ferryInfo}` : null,
    arrivalTips ? `Arrival tips: ${arrivalTips}` : null,
    routeBotRules ? `Route rules: ${routeBotRules}` : null,
    '---',
    availabilityAvailable ? `Availability: ${dateList}` : null,
    availabilityAvailable ? `Availability rule: ${exp.availability.botRule}` : null,
    '---',
    pricingAvailable ? `Pricing: ${pricingItems}` : null,
    pricingAvailable ? `Pricing rules: ${pricingRules}` : null,
    businessRules ? `Business rules: ${businessRules}` : null,
    '---',
    `Included: ${included}`,
    `NOT included: ${notIncluded}`,
    `Reservation flow: ${reservationFlow}`,
    ...paymentFacts,
    '---',
    climateText ? `Climate: ${climateText}` : null,
    roadInfo ? `Road info: ${roadInfo}` : null,
    difficultyText ? `Difficulty: ${difficultyText}` : null,
    `Mine assignment: ${exp.mineDetails.notes}`,
    `Emerald finding policy: ${exp.emeraldPolicy.notes}`,
    idealFor ? `Ideal for: ${idealFor}` : null,
    notIdealFor ? `NOT ideal for: ${notIdealFor}` : null,
    '---',
    `Adventure filter: ${adventureFilter}`,
    qualPhases?.phase1 ? `Phase 1: ${qualPhases.phase1}` : null,
    qualPhases?.phase2 ? `Phase 2: ${qualPhases.phase2}` : null,
    qualPhases?.phase3 ? `Phase 3: ${qualPhases.phase3}` : null,
    handoffExactReply ? `Handoff Exact Reply (ES): ${handoffExactReply.es}` : null,
    handoffExactReply ? `Handoff Exact Reply (EN): ${handoffExactReply.en}` : null,
    negativeExamples ? `Negative examples: ${negativeExamples}` : null,
  ].filter((f): f is string => f !== null);

  if (dataUnavailableRules.length > 0) {
    facts.unshift(...dataUnavailableRules);
  }

  if (tactics) {
    facts.push(
      `Sales attitude: ${tactics.tonePersonality || ''}`,
      `Power confidence: ${tactics.powerConfidence?.attitude || ''}`,
      `Service rule: ${tactics.serviceOverSales || ''}`,
      `Meta: ${tactics.metaRule || ''}`,
      `First contact: ${tactics.firstContact || ''}`,
      `Typo handling: ${tactics.typoHandling || ''}`,
      `Human sell formula: ${tactics.humanSellFormula || ''}`,
      `Customer-first selling: ${tactics.customerFirstSelling || ''}`,
      `Micro-question flow: ${tactics.microQuestionFlow || ''}`,
      `Recommend not describe: ${tactics.recommendNotDescribe || ''}`,
      `Short storytelling: ${tactics.shortStorytelling || ''}`,
      `Soft closing: ${tactics.softClosing || ''}`,
      `Media restraint: ${tactics.mediaRestraint || ''}`,
      `Message style: ${tactics.messageStyle || ''}`,
      `Hot lead behavior: ${tactics.hotLeadBehavior || ''}`,
      `Rarity positioning: ${tactics.rarityPositioning || ''}`,
      `Safety & logistics value: ${tactics.safetyLogisticsValue || ''}`,
      `Against mass tourism: ${tactics.againstMassTourism || ''}`,
      `Authenticity & community: ${tactics.authenticityCommunity || ''}`,
      `Follow-up reply strategy: ${tactics.followUpReplyStrategy || ''}`,
      `Pain response strategy: ${tactics.painResponseStrategy || ''}`,
      `Invisible qualification: ${tactics.invisibleQualification || ''}`
    );
    if (pricingAvailable) {
      facts.push(`Closing: ${tactics.closing?.assumptive || ''} | ${tactics.closing?.softTakeaway || ''}`);
      facts.push(`Price with context: ${tactics.priceWithContext || ''}`);
    }
  }

  if (collectedFields && Object.keys(collectedFields).length > 0) {
    const fieldLines: string[] = [];
    const populatedCount = Object.values(collectedFields).filter(v => v != null).length;
    for (const [k, v] of Object.entries(collectedFields)) {
      if (v != null) fieldLines.push(`  - ${k}: ${v}`);
    }
    facts.unshift('LO QUE YA SABEMOS DE ESTE CLIENTE (NO vuelvas a preguntar esto):\n' + fieldLines.join('\n'));
    if (populatedCount >= 2) {
      facts.unshift('CONTINUACION: Esta conversacion ya esta avanzada. NO te presentes de nuevo ni empieces desde cero. Sigue desde donde quedaste usando los datos de arriba.');
    }
  }

  if (salesPhase) {
    facts.push('', `SALES PHASE ACTUAL: ${salesPhase}`);
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
    facts.unshift(`EXPLICIT CONTEXT FROM THE LATEST CUSTOMER MESSAGE:\n${customerContextLines.map(line => `  - ${line}`).join('\n')}`);
  }

  return `${base}\n\n---\n${facts.join('\n')}`;
}
