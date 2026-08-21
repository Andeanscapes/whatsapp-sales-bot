import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { analyzeLead, type LeadAnalysis } from './lead-analyzer.js';
import { checkBudget } from './budget-guard.js';
import { estimateDeepSeekCost } from './deepseek-cost.js';

export interface RunLeadAnalysisInput {
  customerPhone: string;
  latestMessage: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentScore: number;
  salesPhase: string | null;
  collectedFields: Record<string, unknown>;
  priceGiven: boolean;
  isFollowUpReply: boolean;
  isPainQuestionReply: boolean;
  lastAssistantQuestion: string | null;
  lang: 'es' | 'en';
}

/**
 * Budget-gated DeepSeek lead analysis call, shared by the reply flow
 * (`response-engine.ts`) and the silent bridge scoring path
 * (`bridge-lead-scoring.ts`). Always records an `ai_usage` row (success or
 * failure) so both call sites stay accountable against the same budget guard.
 */
export async function runLeadAnalysis(repos: Repositories, input: RunLeadAnalysisInput): Promise<LeadAnalysis | null> {
  const budget = checkBudget(repos, input.customerPhone);
  if (!budget.aiAllowed) {
    logger.warn({ phone: input.customerPhone, reason: budget.reason }, '[LEAD_ANALYZER] skipped — budget guard');
    return null;
  }

  let usageRecorded = false;
  const analysis = await analyzeLead({
    latestMessage: input.latestMessage,
    history: input.history,
    currentScore: input.currentScore,
    salesPhase: input.salesPhase,
    collectedFields: input.collectedFields,
    priceGiven: input.priceGiven,
    isFollowUpReply: input.isFollowUpReply,
    isPainQuestionReply: input.isPainQuestionReply,
    lastAssistantQuestion: input.lastAssistantQuestion,
    lang: input.lang,
    onAttempt: attempt => {
      usageRecorded = true;
      const cost = estimateDeepSeekCost(attempt.tokens.prompt, attempt.tokens.completion);
      repos.aiUsage.recordUsage({
        phone: input.customerPhone,
        model: env.DEEPSEEK_MODEL,
        promptTokens: attempt.tokens.prompt,
        completionTokens: attempt.tokens.completion,
        cachedTokens: 0,
        estimatedCost: cost,
        purpose: 'lead_analysis',
        success: attempt.success,
        errorType: attempt.success ? null : 'analysis_failed',
      });
    },
  });

  if (!usageRecorded) {
    const tokens = analysis
      ? { prompt: analysis.promptTokens, completion: analysis.completionTokens }
      : { prompt: 0, completion: 0 };
    const cost = estimateDeepSeekCost(tokens.prompt, tokens.completion);
    repos.aiUsage.recordUsage({
      phone: input.customerPhone,
      model: env.DEEPSEEK_MODEL,
      promptTokens: tokens.prompt,
      completionTokens: tokens.completion,
      cachedTokens: 0,
      estimatedCost: cost,
      purpose: 'lead_analysis',
      success: analysis !== null,
      errorType: analysis ? null : 'analysis_failed',
    });
  }

  return analysis;
}
