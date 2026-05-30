import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Skills } from './skill-loader.js';
import { substituteTokens } from './skill-loader.js';
import { getActiveExperience, getPlans } from './product-registry.js';

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

  const dateList = exp.availability.availableDates
    .map(d => {
      const dObj = new Date(d.date + 'T00:00:00');
      const dayName = dObj.toLocaleDateString(lang === 'en' ? 'en-US' : 'es-CO', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      return `${dayName} (${d.status}${d.slotsApprox ? `, ~${d.slotsApprox} slots` : ''})`;
    })
    .join(', ');

  const pricingItems = exp.pricing.items
    .filter(i => i.publiclyShow)
    .map(i =>
      i.couplePrice ? `${i.label}: ${i.couplePrice.toLocaleString('en-US')} COP total` : i.pricePerPerson ? `${i.label}: ${i.pricePerPerson.toLocaleString('en-US')} COP` : `${i.label}: consultar`
    ).join(' | ');

  const pricingRules = exp.pricing.botRules.join('; ');
  const included = exp.included.join(', ');
  const notIncluded = exp.notIncludedUnlessConfirmed.join(', ');
  const reservationFlow = exp.reservationFlow.join('; ');

  const availabilityLastUpdated = exp.availability.lastUpdated;
  const availabilityRule = exp.availability.botRule;

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
    `Availability (last updated: ${availabilityLastUpdated}): ${dateList}`,
    `Availability rule: ${availabilityRule}`,
    '---',
    `Pricing: ${pricingItems}`,
    `Pricing rules: ${pricingRules}`,
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

  if (tactics) {
    facts.push(
      `Sales attitude: ${tactics.tonePersonality || ''}`,
      `Power confidence: ${tactics.powerConfidence?.attitude || ''}`,
      `Closing: ${tactics.closing?.assumptive || ''} | ${tactics.closing?.softTakeaway || ''}`,
      `Service rule: ${tactics.serviceOverSales || ''}`,
      `Meta: ${tactics.metaRule || ''}`,
      `First contact: ${tactics.firstContact || ''}`,
      `Typo handling: ${tactics.typoHandling || ''}`,
      `Human sell formula: ${tactics.humanSellFormula || ''}`
    );
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
