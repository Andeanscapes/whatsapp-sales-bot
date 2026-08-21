import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import { getSkills, loadSkills, refreshSkills, setDynamicService } from '../services/skill-loader.js';
import { getSalesPromptBudget } from '../services/sales-composition.js';
import { env } from '../config/env.js';
import { DynamicDataService } from '../services/dynamic-data-service.js';
import { existsSync, readFileSync } from 'fs';
import { getActiveExperience, getFutureAvailableDates, getPlans } from '../services/product-registry.js';
import type { EntryMarker } from '../services/entry-marker.js';

/**
 * Chars per token for this prompt, calibrated against real DeepSeek usage:
 * on 2026-08-02 a single-turn live eval reported 16,888 prompt tokens for the
 * assembled Spanish prompt (~50k chars) => ~2.97 chars/token. A naive /4 divisor
 * under-reported by ~35% and made the budget gate meaningless, so keep this
 * conservative and re-calibrate if the provider or language mix changes.
 */
const CHARS_PER_TOKEN = 3;
const CURRENT_MESSAGE_TOKEN_RESERVE = 1_500;

/**
 * Payloads to measure. `bot-dynamic.ci.json` is committed and mirrors the real CDN
 * payload's text volume, so CI measures reality and the gate is reproducible from a
 * clean clone. `bot-dynamic-dev.json` is the gitignored local working copy: measured
 * additionally when present, so a dev who grows the real payload sees the cost before
 * uploading. Never make the committed fixture the only input AND smaller than reality
 * — that is what made this gate report green while the prompt was over budget.
 */
const payloads = [
  { label: 'ci-fixture', path: new URL('../../scripts/bot-dynamic.ci.json', import.meta.url) },
  { label: 'dev-payload', path: new URL('../../scripts/bot-dynamic-dev.json', import.meta.url) },
].filter(payload => existsSync(payload.path));

if (payloads.length === 0) throw new Error('No dynamic payload found to measure');

const profiles: Array<{ label: string; marker: EntryMarker | null; priorContext?: string }> = [
  { label: 'default', marker: null },
  { label: 'cold-C01', marker: { code: 'C01', temperature: 'cold' } },
  { label: 'cold-C03-worst-case', marker: { code: 'C03', temperature: 'cold' } },
  { label: 'funnel-H01', marker: { code: 'H01', temperature: 'funnel' } },
  {
    label: 'retargeting-R01',
    marker: { code: 'R01', temperature: 'retargeting' },
    priorContext: 'historial local disponible; plan conocido · personas conocidas · precio ya entregado · fase=pricing',
  },
];

type Measurement = { payload: string; label: string; chars: number; tokens: number };
const measurements: Measurement[] = [];

for (const payload of payloads) {
  const raw = readFileSync(payload.path, 'utf8');
  const dynamicUrl = `data:application/json;base64,${Buffer.from(raw).toString('base64')}`;
  const dynamicService = new DynamicDataService(dynamicUrl, env.DYNAMIC_SKILL_REFRESH_MS);
  setDynamicService(dynamicService);
  loadSkills();
  await refreshSkills(true);
  if (!dynamicService.isAvailable) {
    throw new Error(`Prompt measurement requires valid dynamic data (${payload.label})`);
  }

  const skills = getSkills();
  const experience = getActiveExperience(skills);
  const plan = getPlans(experience)[0]?.id;
  const date = getFutureAvailableDates(experience)[0]?.date;
  const collectedFields: Record<string, unknown> = {
    nombre: 'Prompt budget customer',
    personas: 5,
    transporte: 'private',
    ...(plan ? { plan } : {}),
    ...(date ? { fecha: date } : {}),
  };

  for (const profile of profiles) {
    const prompt = assembleSystemPrompt({
      skills,
      lang: 'es',
      collectedFields,
      salesPhase: 'pricing',
      entryMarker: profile.marker,
      priorContext: profile.priorContext,
    });
    measurements.push({
      payload: payload.label,
      label: profile.label,
      chars: prompt.length,
      tokens: Math.ceil(prompt.length / CHARS_PER_TOKEN),
    });
  }
}

const worst = measurements.reduce((largest, current) => current.tokens > largest.tokens ? current : largest);
const budget = getSalesPromptBudget();
const historyTokenReserve = Math.ceil(env.DEEPSEEK_HISTORY_MAX_CHARS / CHARS_PER_TOKEN);
const projectedContextTokens = worst.tokens
  + historyTokenReserve
  + CURRENT_MESSAGE_TOKEN_RESERVE
  + env.DEEPSEEK_MAX_OUTPUT_TOKENS;

for (const measurement of measurements) {
  console.log(
    `payload=${measurement.payload} profile=${measurement.label} prompt_chars=${measurement.chars} estimated_tokens=${measurement.tokens}`,
  );
}
console.log(`worst_payload=${worst.payload}`);
console.log(`worst_profile=${worst.label}`);
console.log(`prompt_chars=${worst.chars}`);
console.log(`estimated_tokens=${worst.tokens}`);
console.log(`max_tokens=${budget}`);
console.log(`history_token_reserve=${historyTokenReserve}`);
console.log(`current_message_token_reserve=${CURRENT_MESSAGE_TOKEN_RESERVE}`);
console.log(`output_token_reserve=${env.DEEPSEEK_MAX_OUTPUT_TOKENS}`);
console.log(`projected_context_tokens=${projectedContextTokens}`);
console.log(`context_window_tokens=${env.DEEPSEEK_CONTEXT_WINDOW_TOKENS}`);

if (worst.tokens > budget) {
  console.error(`Prompt budget exceeded by ${worst.tokens - budget} estimated tokens (${worst.payload}/${worst.label}).`);
  process.exit(1);
}

if (projectedContextTokens > env.DEEPSEEK_CONTEXT_WINDOW_TOKENS) {
  console.error(
    `Projected request exceeds model context by ${projectedContextTokens - env.DEEPSEEK_CONTEXT_WINDOW_TOKENS} tokens.`,
  );
  process.exit(1);
}

console.log('Prompt budget OK.');
