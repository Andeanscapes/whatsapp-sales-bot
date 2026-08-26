/**
 * Measures how reliably the model emits `[[FOLLOWUP_CONSENT]]` on a proactive
 * consent-ask turn.
 *
 * Calls the real LLM and NEVER touches Meta, the database or the customer: it builds
 * the same prompt `followup-service.ts` builds, sends the same internal turn signal,
 * and runs the drafts through the same `validateConsentAsk`. Costs tokens.
 *
 *   npx tsx src/scripts/measure-consent-compliance.ts [--runs 10] [--context <id>]
 *
 * Exit code is 1 when marker compliance is below `--min-compliance` (default 100),
 * so it can gate a prompt change instead of being read by eye.
 */
import { env } from '../config/env.js';
import { getSkills, loadSkills, refreshSkills, setDynamicService } from '../services/skill-loader.js';
import { DynamicDataService } from '../services/dynamic-data-service.js';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import { DeepSeekLlmClient } from '../services/llm/deepseek-llm-client.js';
import {
  CONSENT_ASK_MARKER,
  CONSENT_ASK_TURN_EVENT,
  validateConsentAsk,
} from '../services/followup-consent.js';
import { getActiveExperience, getPlans } from '../services/product-registry.js';

type HistoryEntry = { role: 'user' | 'assistant'; content: string };

interface ConsentContext {
  id: string;
  description: string;
  collectedFields: Record<string, string | number>;
  history: HistoryEntry[];
  reaskAfterOptOut?: boolean;
}

function parseArg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const runsPerContext = Number.parseInt(parseArg('--runs', '10'), 10);
const contextFilter = parseArg('--context', '');
const minCompliance = Number.parseFloat(parseArg('--min-compliance', '100'));
/**
 * Measure the SECOND attempt instead of the first: adds the same corrective
 * instruction the scheduler adds after a rejected draft. The gap between the two
 * runs is what says whether the bounded retry actually recovers a miss.
 */
const measureRetry = process.argv.includes('--retry');

if (!env.AI_ENABLED) throw new Error('Set AI_ENABLED=true: this script measures real model output.');
if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required.');

// The dev payload mirrors the real feed; the prompt must be built from real catalog
// data or the measurement does not represent production.
const dynamicService = new DynamicDataService(env.DYNAMIC_SKILL_URL, env.DYNAMIC_SKILL_REFRESH_MS);
setDynamicService(dynamicService);
loadSkills();
await refreshSkills(true);
if (!dynamicService.isAvailable) throw new Error('Dynamic catalog unavailable; cannot build a production-like prompt.');

const planId = getPlans(getActiveExperience(getSkills()))[0]?.id;
if (!planId) throw new Error('No plan in the registry; cannot build the qualified contexts.');

/**
 * The four shapes that actually occur in production. `pricing-then-silence` is the
 * exact conversation that produced the live exhaustion alert.
 */
const allContexts: ConsentContext[] = [
  {
    id: 'pricing-then-silence',
    description: 'Price given, group-size question never answered (the live failure)',
    collectedFields: { plan: planId },
    history: [
      { role: 'user', content: 'C01 - Hola, quiero informacion y fechas para la aventura minera en Chivor' },
      { role: 'assistant', content: 'Es una inmersion real en la zona esmeraldera: mina con guias locales y noche en hacienda. ¿Para cuantas personas seria?' },
      { role: 'user', content: 'Q valor y actividades hay par hacer?' },
      { role: 'assistant', content: 'Te paso el detalle del plan de 2 dias con lo que incluye. ¿Van a ser dos personas o mas?' },
    ],
  },
  {
    id: 'cold-minimal-context',
    description: 'One inbound, nothing collected beyond the entry marker',
    collectedFields: {},
    history: [
      { role: 'user', content: 'C01 - Hola, informacion y fechas para la aventura minera' },
      { role: 'assistant', content: 'Con gusto te cuento como es la experiencia. ¿Para cuantas personas seria?' },
    ],
  },
  {
    id: 'qualified-date-and-group',
    description: 'Plan, group and date all collected, then silence',
    collectedFields: { plan: planId, personas: 4, fecha: '10 de octubre' },
    history: [
      { role: 'user', content: 'Somos 4 y nos interesa el 10 de octubre' },
      { role: 'assistant', content: 'Perfecto, quedamos con esa fecha para el grupo. ¿Confirmamos el cupo?' },
    ],
  },
  {
    id: 'post-stop-reask',
    description: 'Customer once asked us to stop, came back, went quiet again',
    collectedFields: { plan: planId },
    reaskAfterOptOut: true,
    history: [
      { role: 'user', content: 'no me escribas mas por ahora' },
      { role: 'assistant', content: 'Entendido, no te escribo mas.' },
      { role: 'user', content: 'hola, volvi a mirar el plan de la mina' },
      { role: 'assistant', content: 'Que bueno tenerte de vuelta. ¿Que parte te gustaria retomar?' },
    ],
  },
];

const contexts = allContexts.filter(context => contextFilter === '' || context.id === contextFilter);
if (contexts.length === 0) throw new Error(`No context matched --context ${contextFilter}`);

const client = new DeepSeekLlmClient(false);

interface ContextResult {
  id: string;
  runs: number;
  withMarker: number;
  valid: number;
  markerlessAccepted: number;
  rejected: number;
  reasons: Record<string, number>;
  samples: string[];
}

const results: ContextResult[] = [];

for (const context of contexts) {
  const result: ContextResult = {
    id: context.id, runs: 0, withMarker: 0, valid: 0,
    markerlessAccepted: 0, rejected: 0, reasons: {}, samples: [],
  };

  for (let run = 0; run < runsPerContext; run += 1) {
    // Retry guidance defaults OFF: first-attempt compliance is what determines
    // whether a cycle burns attempts at all.
    const systemPrompt = assembleSystemPrompt({
      skills: getSkills(),
      lang: 'es',
      collectedFields: context.collectedFields,
      proactiveMode: 'consent_ask',
      reaskAfterOptOut: context.reaskAfterOptOut,
      consentAskRetryInstruction: measureRetry,
    });

    const completion = await client.complete({
      systemPrompt,
      message: CONSENT_ASK_TURN_EVENT,
      history: context.history,
      lang: 'es',
    });

    result.runs += 1;
    const draft = completion?.turn.reply ?? null;
    if (draft === null) {
      result.rejected += 1;
      result.reasons.llm_no_draft = (result.reasons.llm_no_draft ?? 0) + 1;
      continue;
    }

    if (draft.includes(CONSENT_ASK_MARKER)) result.withMarker += 1;

    const validation = validateConsentAsk(draft);
    if (validation.ok) {
      result.valid += 1;
      if (validation.markerlessAccepted) result.markerlessAccepted += 1;
    } else {
      result.rejected += 1;
      const reason = validation.reason ?? 'invalid';
      result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
      // Keep the failing copy: production stores only the reason code, which is
      // exactly why the original incident could not be diagnosed.
      if (result.samples.length < 3) result.samples.push(draft.replace(/\s+/g, ' ').slice(0, 220));
    }
  }

  results.push(result);
}

const pct = (part: number, total: number) => total === 0 ? '—' : `${((part / total) * 100).toFixed(0)}%`;

console.log(`\n=== Consent-ask marker compliance (${measureRetry ? 'RETRY attempt, corrective guidance ON' : 'first attempt, no retry guidance'}) ===`);
console.log(`model=${env.DEEPSEEK_MODEL} temperature=${env.DEEPSEEK_TEMPERATURE} runs_per_context=${runsPerContext}\n`);
console.log('context                     runs  marker  valid  markerless  rejected');
for (const r of results) {
  console.log(
    `${r.id.padEnd(27)} ${String(r.runs).padStart(4)}  ${pct(r.withMarker, r.runs).padStart(6)}`
    + `  ${pct(r.valid, r.runs).padStart(5)}  ${String(r.markerlessAccepted).padStart(10)}  ${String(r.rejected).padStart(8)}`,
  );
}

const totalRuns = results.reduce((sum, r) => sum + r.runs, 0);
const totalMarker = results.reduce((sum, r) => sum + r.withMarker, 0);
const totalValid = results.reduce((sum, r) => sum + r.valid, 0);
const totalMarkerless = results.reduce((sum, r) => sum + r.markerlessAccepted, 0);

console.log(`\nTOTAL  marker=${pct(totalMarker, totalRuns)}  deliverable=${pct(totalValid, totalRuns)}`
  + `  (of which markerless-fallback=${totalMarkerless})`);

const failures = results.filter(r => Object.keys(r.reasons).length > 0);
if (failures.length > 0) {
  console.log('\n--- rejections ---');
  for (const r of failures) {
    console.log(`${r.id}: ${Object.entries(r.reasons).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const sample of r.samples) console.log(`   draft: ${sample}`);
  }
}

const compliance = totalRuns === 0 ? 0 : (totalMarker / totalRuns) * 100;
if (compliance < minCompliance) {
  console.error(`\nFAIL: marker compliance ${compliance.toFixed(0)}% < required ${minCompliance}%`);
  process.exit(1);
}
console.log(`\nPASS: marker compliance ${compliance.toFixed(0)}% >= ${minCompliance}%`);
