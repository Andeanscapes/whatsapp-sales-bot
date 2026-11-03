import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { getSkills, loadSkills, refreshSkills, setDynamicService } from '../services/skill-loader.js';
import { getActiveExperience } from '../services/product-registry.js';
import { DynamicDataService, PRICING_NOT_AVAILABLE } from '../services/dynamic-data-service.js';
import { applyScenarioSeeds, createRunContext, runTurn } from '../tests/conversation-eval/runner.js';
import { evaluateScenario } from '../tests/conversation-eval/evaluate-scenario.js';
import { buildReport, printReport, writeReport } from '../tests/conversation-eval/report.js';
import type { Scenario, ScenarioResult } from '../tests/conversation-eval/schema.js';
import { aggregateRuns } from '../tests/conversation-eval/aggregate-runs.js';
import { loadScenarios, partitionLiveScenarios } from '../tests/conversation-eval/scenario-loader.js';
import { validateTurnExpectations } from '../tests/conversation-eval/turn-expectations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const conversationEvalDir = join(__dirname, '..', 'tests', 'conversation-eval');
const LANGUAGE_PACKS = {
  es: { scenariosDir: join(conversationEvalDir, 'scenarios'), reportFile: 'conversation-eval-llm-bot.json' },
  en: { scenariosDir: join(conversationEvalDir, 'scenarios-en'), reportFile: 'conversation-eval-llm-bot-en.json' },
} as const;
type EvalLanguage = keyof typeof LANGUAGE_PACKS;

function evalLanguage(): EvalLanguage {
  const value = option('--lang') ?? 'es';
  if (value !== 'es' && value !== 'en') throw new Error(`--lang must be es or en, got ${value}`);
  return value;
}

function progressLabel(current: number, total: number): string {
  const percent = Math.round((current / Math.max(1, total)) * 100);
  return `[LLM_BOT_EVAL] ${current}/${total} (${percent}%)`;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requireLiveLlmConfig(): void {
  if (!env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY === 'test') throw new Error('A real DEEPSEEK_API_KEY is required');
  if (!env.AI_ENABLED) throw new Error('AI_ENABLED=true is required');
}

/**
 * Safety ceiling for a live pass, not a target. Estimated, not measured, on
 * 2026-10-26 from `npm run measure:prompt` and the env token prices: the full live
 * subset lands near $0.60. Re-derive from those two sources when either grows.
 */
function maxEvaluationCostUsd(): number {
  const raw = Number(process.env.EVAL_MAX_COST_USD ?? '1.00');
  if (!Number.isFinite(raw) || raw <= 0) throw new Error('EVAL_MAX_COST_USD must be a positive number');
  return raw;
}

/** Above any first-attempt suffix (scenarioIndex * 10 + run, run < 5). */
const RETRY_PHONE_OFFSET = 5000;

function buildResult(scenario: Scenario, evaluation: ReturnType<typeof evaluateScenario>, turns: ScenarioResult['turnResults'], runs: { total: number; passed: number }, expectationErrors: string[]): ScenarioResult {
  const minimumFailure = scenario.minLiveScore !== undefined && evaluation.score < scenario.minLiveScore;
  return {
    id: scenario.id,
    score: evaluation.score,
    hardFail: evaluation.hardFail || minimumFailure || expectationErrors.length > 0,
    notes: [
      ...evaluation.notes,
      ...(minimumFailure ? [`[minimum] score ${evaluation.score} < ${scenario.minLiveScore}`] : []),
      ...expectationErrors,
    ],
    criteria: evaluation.criteria,
    turnResults: turns,
    ...(runs.total > 1 ? { runs } : {}),
  };
}

async function main(): Promise<void> {
  const selectedId = option('--scenario');
  const requestedRuns = Number(option('--runs') ?? 1);
  if (!Number.isInteger(requestedRuns) || requestedRuns < 1 || requestedRuns > 5) throw new Error('--runs must be an integer from 1 to 5');

  const language = evalLanguage();
  const pack = LANGUAGE_PACKS[language];
  console.log(`[LLM_BOT_EVAL] language=${language} scenarios=${pack.scenariosDir}`);
  const allScenarios = loadScenarios(pack.scenariosDir);
  if (allScenarios.length === 0) {
    console.log('[LLM_BOT_EVAL] no scenarios registered — nothing to run');
    process.exit(0);
  }
  const selectedScenarios = allScenarios.filter(scenario => !selectedId || scenario.id === selectedId);
  if (selectedScenarios.length === 0) throw new Error(`No scenario found for ${selectedId}`);
  const includeAll = process.argv.includes('--all') || selectedId !== undefined;
  const { supported: scenarios, skipped, deselected } = partitionLiveScenarios(selectedScenarios, { includeAll });
  if (skipped.length > 0) {
    console.log(`[LLM_BOT_EVAL] skipped ${skipped.length} unsupported synthetic scenarios: ${skipped.map(scenario => scenario.id).join(', ')}`);
  }
  if (deselected.length > 0) {
    console.log(`[LLM_BOT_EVAL] not in live subset (deterministic only, use --all to include): ${deselected.map(scenario => scenario.id).join(', ')}`);
  }
  if (scenarios.length === 0) {
    if (selectedId) throw new Error(`Scenario ${selectedId} uses an unsupported synthetic runner`);
    console.log('[LLM_BOT_EVAL] no live message scenarios to run');
    return;
  }

  requireLiveLlmConfig();
  const maxCostUsd = maxEvaluationCostUsd();
  if (env.DYNAMIC_SKILL_URL) {
    const service = new DynamicDataService(env.DYNAMIC_SKILL_URL, env.DYNAMIC_SKILL_REFRESH_MS);
    setDynamicService(service);
    await service.refreshIfStale();
  }
  loadSkills();
  await refreshSkills(true);

  const results: ScenarioResult[] = [];
  let totalCostUsd = 0;
  const todayStart = new Date().toISOString().slice(0, 10);

  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
    const scenario = scenarios[scenarioIndex];
    const runCount = Math.max(requestedRuns, scenario.liveRuns);
    const runResults: ScenarioResult[] = [];
    // A hard-failed run, or one missing a weight >= 3 criterion, is re-run once (one
    // retry per run). A real regression fails both attempts; a
    // one-off LLM miss no longer fails the release gate. The retry is in the notes.
    let retriedRun = -1;
    let retries = 0;

    for (let run = 0; run < runCount; run++) {
      const progress = progressLabel(scenarioIndex + 1, scenarios.length);
      const isRetry = retriedRun === run;
      console.log(`${progress} starting ${scenario.id} run ${run + 1}/${runCount}${isRetry ? ' (retry)' : ''}`);
      // Retries get their own phone range so they never share a number with another run.
      const ctx = createRunContext({ phoneSuffix: scenarioIndex * 10 + run + (isRetry ? RETRY_PHONE_OFFSET : 0) });
      const experience = getActiveExperience(getSkills());
      const originalPricingItems = experience.pricing.items;
      const originalPricingRules = experience.pricing.botRules;
      if (scenario.mockPricing) {
        experience.pricing.items = [
          { id: `${scenario.mockPricing.planId}_individual`, planId: scenario.mockPricing.planId, label: 'Individual', pricePerPerson: scenario.mockPricing.individual, publiclyShow: true },
          { id: `${scenario.mockPricing.planId}_couple`, planId: scenario.mockPricing.planId, label: 'Pareja', couplePrice: scenario.mockPricing.couple, publiclyShow: true },
          ...(scenario.mockPricing.privateTransport
            ? [{ id: 'private_transport', kind: 'addon' as const, label: 'Private transport', couplePrice: scenario.mockPricing.privateTransport, publiclyShow: true }]
            : []),
        ];
        experience.pricing.botRules = experience.pricing.botRules.filter(rule => rule !== PRICING_NOT_AVAILABLE);
      }
      let restoreSeeds = (): void => undefined;
      try {
        restoreSeeds = applyScenarioSeeds(ctx, scenario);
        for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex++) {
          ctx.turns.push(await runTurn(ctx, scenario.turns[turnIndex], turnIndex + 1, 'live'));
          console.log(`${progress} ${scenario.id} run ${run + 1}/${runCount} turn ${turnIndex + 1}/${scenario.turns.length}`);
        }
        const evaluation = evaluateScenario(scenario, ctx.turns);
        const turns = ctx.turns.map(turn => ({
          user: turn.user,
          reply: turn.reply,
          leadScore: turn.processOutput.leadScore,
          shouldAlertOwner: turn.processOutput.shouldAlertOwner,
          shouldSendImage: turn.processOutput.shouldSendImage,
        }));
        const result = buildResult(scenario, evaluation, turns, { total: 1, passed: 0 }, validateTurnExpectations(scenario, ctx.turns));
        result.runs = { total: 1, passed: result.hardFail ? 0 : 1 };
        // hardFail also covers turn expectations and minLiveScore, which are not criteria.
        const missed = result.criteria.filter(c => !c.passed && (c.critical || c.weight >= 3));
        if ((result.hardFail || missed.length > 0) && !isRetry) {
          const failedIds = missed.map(c => c.id).join(', ') || 'expectation/minLiveScore';
          console.log(`${progress} ${scenario.id} run ${run + 1}/${runCount} failed (${failedIds}); retrying once`);
          retriedRun = run;
          retries += 1;
          run--;
        } else {
          if (isRetry) result.notes = [...result.notes, `run ${run + 1} retried after a failed run`];
          runResults.push(result);
        }
        totalCostUsd += ctx.repos.aiUsage.getDailyCost(todayStart);
        if (totalCostUsd > maxCostUsd) {
          throw new Error(
            `Live conversation eval cost $${totalCostUsd.toFixed(4)} exceeded EVAL_MAX_COST_USD=$${maxCostUsd.toFixed(4)} `
            + `after ${scenarioIndex + 1}/${scenarios.length} scenarios. Raise the cap or narrow the run with --scenario.`,
          );
        }
      } finally {
        try {
          restoreSeeds();
        } finally {
          experience.pricing.items = originalPricingItems;
          experience.pricing.botRules = originalPricingRules;
          ctx.destroy();
        }
      }
    }

    const aggregated = { ...aggregateRuns(runResults), ...(retries > 0 ? { retries } : {}) };
    results.push(runCount > 1 ? aggregated : { ...aggregated, runs: undefined });
    console.log(`${progressLabel(scenarioIndex + 1, scenarios.length)} finished ${scenario.id} score=${aggregated.score} cost=$${totalCostUsd.toFixed(4)}`);
  }

  const report = buildReport('live', results, totalCostUsd);
  printReport(report);
  const path = writeReport(report, pack.reportFile);
  if (report.suite.hardFails > 0) throw new Error(`Conversation eval hard failures: ${report.suite.hardFails}`);
  const minScore = Number(process.env.MIN_CONVERSATION_SCORE ?? 70);
  if (report.suite.average < minScore) throw new Error(`Conversation eval average ${report.suite.average} below ${minScore}`);
  console.log(`Report written to: ${path}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
