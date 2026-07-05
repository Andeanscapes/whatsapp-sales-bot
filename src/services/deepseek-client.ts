import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Skills } from './skill-loader.js';
import { substituteTokens } from './skill-loader.js';
import { getActiveExperience, getPlans, isPricingAvailable, isAvailabilityAvailable } from './product-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSystemPrompt(): string {
  return substituteTokens(
    readFileSync(join(__dirname, '..', 'prompts', 'deepseek-system.prompt.md'), 'utf-8')
  );
}

export function buildSystemPrompt(skills: Skills, lang?: string, collectedFields?: Record<string, unknown>, salesPhase?: string): string {
  const base = readSystemPrompt();
  const exp = getActiveExperience(skills);
  const route = exp.route;
  const tactics = skills.salesStrategy.salesTactics;

  const pricingAvailable = isPricingAvailable(exp);
  const availabilityAvailable = isAvailabilityAvailable(exp);

  const dateList = availabilityAvailable
    ? exp.availability.availableDates
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

  const dataUnavailableRule = (!pricingAvailable || !availabilityAvailable)
    ? '[CRITICAL RULE] NO hay precios ni fechas disponibles — el equipo los esta ajustando. IGNORA las fases de precio/fechas. NO des ninguna cifra. NO des ninguna fecha concreta. Responde solo con la info que SI tienes (ruta, inclusiones, clima, etc) y di que el equipo confirmara precios y disponibilidad.'
    : null;

  const facts = [
    `Business: ${skills.andeanScapes.business.name} — ${shortDesc}`,
    `Brand intro: ${skills.andeanScapes.business.shortBrandIntro ?? ''}`,
    `Location: ${skills.andeanScapes.business.location}${meetingPt ? '. Meeting point: ' + meetingPt : ''}`,
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
    '---',
    climateText ? `Climate: ${climateText}` : null,
    roadInfo ? `Road info: ${roadInfo}` : null,
    difficultyText ? `Difficulty: ${difficultyText}` : null,
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

  if (dataUnavailableRule) {
    facts.unshift(dataUnavailableRule);
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
    for (const [k, v] of Object.entries(collectedFields)) {
      if (v != null) fieldLines.push(`  - ${k}: ${v}`);
    }
    facts.unshift('LO QUE YA SABEMOS DE ESTE CLIENTE (NO vuelvas a preguntar esto):\n' + fieldLines.join('\n'));
  }

  if (salesPhase) {
    facts.push('', `SALES PHASE ACTUAL: ${salesPhase}`);
  }

  return `${base}\n\n---\n${facts.join('\n')}`;
}
