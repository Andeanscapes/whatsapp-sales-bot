import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { loadSkills } from '../services/skill-loader.js';
import { createRunContext, runTurn } from '../tests/conversation-eval/runner.js';
import { scoreScenario } from '../tests/conversation-eval/score-deterministic.js';
import { buildReport, printReport, writeReport } from '../tests/conversation-eval/report.js';
import { scenarioSchema, type Scenario, type ScenarioResult } from '../tests/conversation-eval/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(__dirname, '..', 'tests', 'conversation-eval', 'scenarios');

function progressLabel(current: number, total: number): string {
  const percent = Math.round((current / Math.max(1, total)) * 100);
  return `[LLM_BOT_EVAL] ${current}/${total} (${percent}%)`;
}

function requireLiveLlmConfig(): void {
  if (!env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY === 'test') {
    throw new Error('A real DEEPSEEK_API_KEY is required for npm run eval:conversations:llm-bot');
  }
  if (!env.AI_ENABLED) {
    throw new Error('AI_ENABLED=true is required for npm run eval:conversations:llm-bot');
  }
}

function loadScenarios(): Scenario[] {
  return readdirSync(scenariosDir)
    .filter(f => f.endsWith('.json'))
    .map(f => scenarioSchema.parse(JSON.parse(readFileSync(join(scenariosDir, f), 'utf8'))));
}

async function main(): Promise<void> {
  requireLiveLlmConfig();
  loadSkills();

  const scenarios = loadScenarios();
  const results: ScenarioResult[] = [];
  let totalCostUsd = 0;
  const todayStart = new Date().toISOString().split('T')[0];

  for (let si = 0; si < scenarios.length; si++) {
    const scenario = scenarios[si];
    const ctx = createRunContext({ phoneSuffix: si });

    console.log(`${progressLabel(si + 1, scenarios.length)} starting ${scenario.id}`);

    try {
      for (let ti = 0; ti < scenario.turns.length; ti++) {
        const record = await runTurn(ctx, scenario.turns[ti], ti + 1);
        ctx.turns.push(record);
        console.log(`${progressLabel(si + 1, scenarios.length)} ${scenario.id} turn ${ti + 1}/${scenario.turns.length}`);
      }

      const collectedFields = ctx.repos.conversation.getCollectedFields(ctx.customerPhone);
      const scoreResult = scoreScenario(scenario, ctx.turns, collectedFields);
      const turnResults: ScenarioResult['turnResults'] = ctx.turns.map(t => ({
        user: t.user,
        reply: t.reply,
        leadScore: t.processOutput.leadScore,
        shouldAlertOwner: t.processOutput.shouldAlertOwner,
        shouldSendImage: t.processOutput.shouldSendImage,
      }));

      results.push({
        id: scenario.id,
        scores: scoreResult.scores,
        total: scoreResult.total,
        hardFail: scoreResult.hardFail,
        notes: scoreResult.notes,
        turnResults,
      });

      totalCostUsd += ctx.repos.aiUsage.getDailyCost(todayStart);
      console.log(`${progressLabel(si + 1, scenarios.length)} finished ${scenario.id} score=${scoreResult.total}`);
    } finally {
      ctx.destroy();
    }
  }

  const report = buildReport('live', results, totalCostUsd);
  printReport(report);
  const path = writeReport(report, 'conversation-eval-llm-bot.json');
  const minScore = Number(process.env.MIN_CONVERSATION_SCORE ?? 70);

  if (report.suite.hardFails > 0) {
    throw new Error(`Conversation eval hard failures: ${report.suite.hardFails}`);
  }
  if (report.suite.average < minScore) {
    throw new Error(`Conversation eval average ${report.suite.average} below ${minScore}`);
  }

  console.log(`Report written to: ${path}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
