import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { getSkills, loadSkills, refreshSkills } from '../services/skill-loader.js';
import { getActiveExperience } from '../services/product-registry.js';
import { PRICING_NOT_AVAILABLE } from '../services/dynamic-data-service.js';
import { applyScenarioSeeds, createRunContext, runTurn } from '../tests/conversation-eval/runner.js';
import { runFollowUpScenario } from '../tests/conversation-eval/follow-up-runner.js';
import { evaluateScenario } from '../tests/conversation-eval/evaluate-scenario.js';
import { buildReport, printReport, writeReport } from '../tests/conversation-eval/report.js';
import { scenarioSchema, type Scenario, type ScenarioResult } from '../tests/conversation-eval/schema.js';
import { aggregateRuns } from '../tests/conversation-eval/aggregate-runs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(__dirname, '..', 'tests', 'conversation-eval', 'scenarios');

function progressLabel(current: number, total: number): string {
  const percent = Math.round((current / Math.max(1, total)) * 100);
  return `[LLM_BOT_EVAL] ${current}/${total} (${percent}%)`;
}

function loadScenarios(): Scenario[] {
  return readdirSync(scenariosDir)
    .filter(file => file.endsWith('.json'))
    .map(file => scenarioSchema.parse(JSON.parse(readFileSync(join(scenariosDir, file), 'utf8'))));
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requireLiveLlmConfig(): void {
  if (!env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY === 'test') throw new Error('A real DEEPSEEK_API_KEY is required');
  if (!env.AI_ENABLED) throw new Error('AI_ENABLED=true is required');
}

function buildResult(scenario: Scenario, evaluation: ReturnType<typeof evaluateScenario>, turns: ScenarioResult['turnResults'], runs: { total: number; passed: number }): ScenarioResult {
  const minimumFailure = scenario.minLiveScore !== undefined && evaluation.score < scenario.minLiveScore;
  return {
    id: scenario.id,
    score: evaluation.score,
    hardFail: evaluation.hardFail || minimumFailure,
    notes: minimumFailure ? [...evaluation.notes, `[minimum] score ${evaluation.score} < ${scenario.minLiveScore}`] : evaluation.notes,
    criteria: evaluation.criteria,
    turnResults: turns,
    ...(runs.total > 1 ? { runs } : {}),
  };
}

async function main(): Promise<void> {
  requireLiveLlmConfig();
  loadSkills();
  await refreshSkills(true);

  const selectedId = option('--scenario');
  const requestedRuns = Number(option('--runs') ?? 1);
  if (!Number.isInteger(requestedRuns) || requestedRuns < 1 || requestedRuns > 5) throw new Error('--runs must be an integer from 1 to 5');

  const scenarios = loadScenarios().filter(scenario => !selectedId || scenario.id === selectedId);
  if (scenarios.length === 0) throw new Error(`No scenario found for ${selectedId}`);

  const results: ScenarioResult[] = [];
  let totalCostUsd = 0;
  const todayStart = new Date().toISOString().slice(0, 10);

  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
    const scenario = scenarios[scenarioIndex];
    const runCount = Math.max(requestedRuns, scenario.liveRuns);
    const runResults: ScenarioResult[] = [];

    for (let run = 0; run < runCount; run++) {
      const progress = progressLabel(scenarioIndex + 1, scenarios.length);
      console.log(`${progress} starting ${scenario.id} run ${run + 1}/${runCount}`);
      const ctx = createRunContext({ phoneSuffix: scenarioIndex * 10 + run });
      const restoreSeeds = applyScenarioSeeds(ctx, scenario);
      const experience = getActiveExperience(getSkills());
      const originalPricingItems = experience.pricing.items;
      const originalPricingRules = experience.pricing.botRules;
      if (scenario.mockPricing) {
        experience.pricing.items = [
          { id: `${scenario.mockPricing.planId}_individual`, planId: scenario.mockPricing.planId, label: 'Individual', pricePerPerson: scenario.mockPricing.individual, publiclyShow: true },
          { id: `${scenario.mockPricing.planId}_couple`, planId: scenario.mockPricing.planId, label: 'Pareja', couplePrice: scenario.mockPricing.couple, publiclyShow: true },
        ];
        experience.pricing.botRules = experience.pricing.botRules.filter(rule => rule !== PRICING_NOT_AVAILABLE);
      }
      try {
        if (scenario.runner === 'follow_up') {
          ctx.turns.push(...await runFollowUpScenario(ctx, scenario));
          console.log(`${progress} ${scenario.id} run ${run + 1}/${runCount} follow-up complete`);
        } else {
          for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex++) {
            ctx.turns.push(await runTurn(ctx, scenario.turns[turnIndex], turnIndex + 1));
            console.log(`${progress} ${scenario.id} run ${run + 1}/${runCount} turn ${turnIndex + 1}/${scenario.turns.length}`);
          }
        }
        const evaluation = evaluateScenario(scenario, ctx.turns);
        const turns = ctx.turns.map(turn => ({
          user: turn.user,
          reply: turn.reply,
          leadScore: turn.processOutput.leadScore,
          shouldAlertOwner: turn.processOutput.shouldAlertOwner,
          shouldSendImage: turn.processOutput.shouldSendImage,
        }));
        runResults.push(buildResult(scenario, evaluation, turns, { total: 1, passed: evaluation.hardFail ? 0 : 1 }));
        totalCostUsd += ctx.repos.aiUsage.getDailyCost(todayStart);
      } finally {
        experience.pricing.items = originalPricingItems;
        experience.pricing.botRules = originalPricingRules;
        restoreSeeds();
        ctx.destroy();
      }
    }

    const aggregated = aggregateRuns(runResults);
    results.push(runCount > 1 ? aggregated : { ...aggregated, runs: undefined });
    console.log(`${progressLabel(scenarioIndex + 1, scenarios.length)} finished ${scenario.id} score=${aggregated.score}`);
  }

  const report = buildReport('live', results, totalCostUsd);
  printReport(report);
  const path = writeReport(report, 'conversation-eval-llm-bot.json');
  if (report.suite.hardFails > 0) throw new Error(`Conversation eval hard failures: ${report.suite.hardFails}`);
  const minScore = Number(process.env.MIN_CONVERSATION_SCORE ?? 70);
  if (report.suite.average < minScore) throw new Error(`Conversation eval average ${report.suite.average} below ${minScore}`);
  console.log(`Report written to: ${path}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
