import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSkills, loadSkills } from '../../services/skill-loader.js';
import { getActiveExperience } from '../../services/product-registry.js';
import { PRICING_NOT_AVAILABLE } from '../../services/dynamic-data-service.js';
import type { AnalyzerInput, LeadAnalysis } from '../../services/lead-analyzer.js';
import { applyScenarioSeeds, createRunContext, defaultMockResult, runTurn, type MockLlmFunction } from './runner.js';
import { runFollowUpScenario } from './follow-up-runner.js';
import { runLifecycleScenario } from './lifecycle-runner.js';
import { evaluateScenario } from './evaluate-scenario.js';
import { buildReport, printReport, writeReport } from './report.js';
import type { ScenarioResult } from './schema.js';
import { loadScenarios } from './scenario-loader.js';
import { validateTurnExpectations } from './turn-expectations.js';

const { mockLlmComplete } = vi.hoisted(() => ({
  mockLlmComplete: vi.fn<MockLlmFunction>(() => Promise.resolve(null)),
}));
const { mockAnalyzeLead } = vi.hoisted(() => ({
  mockAnalyzeLead: vi.fn<(input: AnalyzerInput) => Promise<LeadAnalysis | null>>(() => Promise.resolve(null)),
}));

vi.mock('../../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({ complete: mockLlmComplete })),
}));
vi.mock('../../services/budget-guard.js', () => ({ checkBudget: vi.fn(() => ({ aiAllowed: true })) }));
vi.mock('../../services/time-window-policy.js', () => ({
  checkTimeWindow: vi.fn(() => ({ isLimited: false })),
  isWithinServiceWindow: vi.fn(() => true),
}));
vi.mock('../../services/lead-analyzer.js', () => ({ analyzeLead: mockAnalyzeLead }));
vi.mock('../../services/whatsapp-client.js', () => ({ sendText: vi.fn(() => Promise.resolve()) }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(__dirname, 'scenarios');

beforeAll(() => loadSkills());

describe('Conversation Quality Eval V2', () => {
  const scenarios = loadScenarios(scenariosDir);
  const results: ScenarioResult[] = [];

  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index];
    it(`${scenario.id} (${scenario.turns.length} turns)`, async () => {
      mockLlmComplete.mockReset();
      mockAnalyzeLead.mockReset();
      mockAnalyzeLead.mockImplementation(async input => {
        const analysis = scenario.turns.find(turn => turn.user === input.latestMessage)?.mockAnalysis;
        return analysis ? {
          ...analysis,
          buyingSignals: [],
          blockers: [],
          rationale: 'conversation eval fixture',
          promptTokens: 10,
          completionTokens: 10,
        } : null;
      });
      if (scenario.runner === 'follow_up') {
        mockLlmComplete.mockResolvedValueOnce(defaultMockResult(scenario.followUpMockReply ?? ''));
      } else {
        mockLlmComplete.mockImplementation(async input => {
          const turn = scenario.turns.find(candidate => candidate.user === input.message);
          return turn ? defaultMockResult(turn.mockReply) : null;
        });
      }

      const ctx = createRunContext({ phoneSuffix: index });
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
        if (scenario.runner === 'lifecycle') {
          ctx.turns.push(...runLifecycleScenario(ctx, scenario));
        } else if (scenario.runner === 'follow_up') {
          ctx.turns.push(...await runFollowUpScenario(ctx, scenario));
        } else {
          for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex++) {
            ctx.turns.push(await runTurn(ctx, scenario.turns[turnIndex], turnIndex + 1));
          }
        }

        expect(validateTurnExpectations(scenario, ctx.turns)).toEqual([]);

        const evaluation = evaluateScenario(scenario, ctx.turns);
        results.push({
          id: scenario.id,
          score: evaluation.score,
          hardFail: evaluation.hardFail,
          notes: evaluation.notes,
          criteria: evaluation.criteria,
          turnResults: ctx.turns.map(turn => ({
            user: turn.user,
            reply: turn.reply,
            leadScore: turn.processOutput.leadScore,
            shouldAlertOwner: turn.processOutput.shouldAlertOwner,
            shouldSendImage: turn.processOutput.shouldSendImage,
          })),
        });

        expect(evaluation.hardFail, evaluation.notes.join('; ')).toBe(false);
        expect(evaluation.score, scenario.id).toBe(100);
      } finally {
        try {
          restoreSeeds();
        } finally {
          experience.pricing.items = originalPricingItems;
          experience.pricing.botRules = originalPricingRules;
          ctx.destroy();
        }
      }
    });
  }

  afterAll(() => {
    const report = buildReport('deterministic', results);
    printReport(report);
    writeReport(report, 'conversation-eval.json');
    const effectiveHardFails = report.suite.hardFails;
    const effectiveScores = report.scenarios.map(s => s.score);
    const effectiveAvg = effectiveScores.length === 0 ? 100 : Math.round(effectiveScores.reduce((a, b) => a + b, 0) / effectiveScores.length);
    expect(effectiveHardFails, `Hard fails (excluding pre-existing): ${effectiveHardFails}`).toBe(0);
    expect(effectiveAvg, `Average (excluding pre-existing) ${effectiveAvg} < 100`).toBe(100);
  });
});
