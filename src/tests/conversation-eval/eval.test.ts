import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadSkills } from '../../services/skill-loader.js';
import { runTurn, createRunContext, defaultMockResult, type RunContext, type MockLlmFunction } from './runner.js';
import { scoreScenario } from './score-deterministic.js';
import { mergeScores, runLlmJudge, llmCostUsd } from './score-llm-judge.js';
import { printReport, writeReport, buildReport } from './report.js';
import { scenarioSchema, type Scenario, type ScenarioResult } from './schema.js';


const { mockLlmComplete } = vi.hoisted(() => ({
  mockLlmComplete: vi.fn<MockLlmFunction>(() => Promise.resolve(null)),
}));

vi.mock('../../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({
    complete: mockLlmComplete,
  })),
}));

vi.mock('../../services/budget-guard.js', () => ({
  checkBudget: vi.fn(() => ({ aiAllowed: true })),
}));

vi.mock('../../services/time-window-policy.js', () => ({
  checkTimeWindow: vi.fn(() => ({ isLimited: false })),
}));

const { mockAnalyzeLead } = vi.hoisted(() => ({
  mockAnalyzeLead: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../services/lead-analyzer.js', () => ({
  analyzeLead: mockAnalyzeLead,
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(__dirname, 'scenarios');

function progressLabel(current: number, total: number): string {
  const percent = Math.round((current / Math.max(1, total)) * 100);
  return `[LLM_JUDGE_EVAL] ${current}/${total} (${percent}%)`;
}

function loadScenarios(): Scenario[] {
  const files = readdirSync(SCENARIOS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const raw = readFileSync(join(SCENARIOS_DIR, f), 'utf8');
    return scenarioSchema.parse(JSON.parse(raw));
  });
}

beforeAll(() => {
  loadSkills();
});

describe('Conversation Quality Eval', () => {
  const scenarios = loadScenarios();
  const allResults: ScenarioResult[] = [];
  const liveMode = process.env.CONV_LIVE === '1';
  let totalJudgePromptTokens = 0;
  let totalJudgeCompletionTokens = 0;

  for (let si = 0; si < scenarios.length; si++) {
    const scenario = scenarios[si];

    it(`${scenario.id} (${scenario.turns.length} turns)`, async () => {
      mockLlmComplete.mockReset();
      mockAnalyzeLead.mockReset();

      const ctx: RunContext = createRunContext({ phoneSuffix: si });

      try {
        if (liveMode) {
          console.log(`${progressLabel(si + 1, scenarios.length)} starting ${scenario.id}`);
        }

        for (const turnDef of scenario.turns) {
          const mockVal = defaultMockResult(turnDef.mockReply);
          mockLlmComplete.mockResolvedValueOnce(mockVal);
        }

        for (let ti = 0; ti < scenario.turns.length; ti++) {
          const record = await runTurn(ctx, scenario.turns[ti], ti + 1);
          ctx.turns.push(record);

          const ex = scenario.turns[ti].expect;
          if (ex) {
            if (ex.shouldSendReply !== undefined) expect(record.processOutput.shouldSendReply).toBe(ex.shouldSendReply);
            if (ex.shouldAlertOwner !== undefined) expect(record.processOutput.shouldAlertOwner).toBe(ex.shouldAlertOwner);
            if (ex.shouldSendImage !== undefined) expect(record.processOutput.shouldSendImage).toBe(ex.shouldSendImage);
            if (ex.shouldSendOwnerImage !== undefined) expect(record.processOutput.shouldSendOwnerImage).toBe(ex.shouldSendOwnerImage);
            if (ex.shouldSendGalleryImages !== undefined) expect(record.processOutput.shouldSendGalleryImages).toBe(ex.shouldSendGalleryImages);
            if (ex.usedAi !== undefined) expect(record.processOutput.usedAi).toBe(ex.usedAi);
            if (ex.priceJustGiven !== undefined) expect(record.processOutput.priceJustGiven).toBe(ex.priceJustGiven);
            if (ex.replyMustNotMatch) {
              for (const pattern of ex.replyMustNotMatch) {
                expect(record.reply, `must not contain "${pattern}"`).not.toMatch(new RegExp(pattern, 'i'));
              }
            }
            if (ex.replyMustContain) {
              for (const pattern of ex.replyMustContain) {
                expect(record.reply, `must contain "${pattern}"`).toMatch(new RegExp(pattern, 'i'));
              }
            }
            if (ex.reply !== undefined) {
              expect(record.reply).toBe(ex.reply);
            }
          }
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

        const llmJudge = liveMode
          ? await runLlmJudge({
            scenarioId: scenario.id,
            turns: ctx.turns,
            deterministic: scoreResult.scores,
            deterministicTotal: scoreResult.total,
          })
          : null;

        if (liveMode) {
          console.log(`${progressLabel(si + 1, scenarios.length)} finished ${scenario.id}`);
        }

        if (llmJudge) {
          totalJudgePromptTokens += llmJudge.promptTokens;
          totalJudgeCompletionTokens += llmJudge.completionTokens;
        }

        const merged = llmJudge
          ? mergeScores(scoreResult.scores, scoreResult.total, llmJudge)
          : null;

        allResults.push({
          id: scenario.id,
          scores: merged?.scores ?? scoreResult.scores,
          total: merged?.total ?? scoreResult.total,
          hardFail: scoreResult.hardFail,
          notes: merged ? [...scoreResult.notes, ...merged.notes] : scoreResult.notes,
          turnResults,
          llmJudge: llmJudge ?? undefined,
        });

        expect(scoreResult.hardFail, `Hard safety fail: ${scenario.id}`).toBe(false);
      } finally {
        ctx.destroy();
      }
    });
  }

  afterAll(() => {
    const totalTokens = totalJudgePromptTokens + totalJudgeCompletionTokens;
    const costUsd = totalTokens > 0 ? llmCostUsd(totalJudgePromptTokens, totalJudgeCompletionTokens) : undefined;
    const report = buildReport(liveMode ? 'live' : 'deterministic', allResults, costUsd, totalTokens > 0 ? totalTokens : undefined);
    printReport(report);
    const filename = liveMode ? 'conversation-eval-llm-judge.json' : 'conversation-eval.json';
    const filePath = writeReport(report, filename);

    const minScore = Number(process.env.MIN_CONVERSATION_SCORE ?? 70);
    expect(report.suite.hardFails, `Hard fails: ${report.suite.hardFails}`).toBe(0);
    if (liveMode) {
      const missingJudgeCount = report.scenarios.filter(s => !s.llmJudge).length;
      expect(missingJudgeCount, 'Live mode requires llmJudge on every scenario. Check EVAL_LLM_API_KEY/EVAL_LLM_MODEL/EVAL_LLM_URL.').toBe(0);
    }
    expect(report.suite.average, `Average ${report.suite.average} < ${minScore}`).toBeGreaterThanOrEqual(minScore);

    console.log(`Report written to: ${filePath}`);
  });
});
