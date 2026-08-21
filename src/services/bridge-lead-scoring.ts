import type { Repositories } from '../db/repositories/index.js';
import { logger } from '../config/logger.js';
import { getCollectedFields } from './qualification-engine.js';
import { runLeadAnalysis } from './lead-analysis-runner.js';
import { scoreMessage, computeAnalyzerFallbackScore, computeHybridScore } from './lead-scoring.js';
import { getSkills } from './skill-loader.js';

/** Scores bridge traffic without entering the customer reply path. */
export async function scoreBridgeInbound(
  repos: Repositories,
  customerPhone: string,
  message: string,
): Promise<void> {
  if (!message.trim()) return;

  const skills = getSkills();
  const currentScore = repos.conversation.getLeadScore(customerPhone);
  const regexScore = scoreMessage(message, skills);
  const history = repos.message.getRecentMessages(customerPhone, 21);
  const analyzerHistory = history.slice(0, -1).map(item => ({ role: item.role, content: item.content }));

  const analysis = await runLeadAnalysis(repos, {
    customerPhone,
    latestMessage: message,
    history: analyzerHistory,
    currentScore,
    salesPhase: repos.conversation.getSalesPhase(customerPhone),
    collectedFields: getCollectedFields(repos, customerPhone),
    priceGiven: repos.conversation.getPriceGivenAt(customerPhone) !== null,
    isFollowUpReply: false,
    isPainQuestionReply: false,
    lastAssistantQuestion: null,
    lang: repos.conversation.getLanguage(customerPhone) ?? 'es',
  });

  if (analysis) {
    const hybrid = computeHybridScore(
      currentScore,
      {
        intent: analysis.intent,
        scoreDelta: analysis.scoreDelta,
        confidence: analysis.confidence,
        buyingSignals: analysis.buyingSignals,
        blockers: analysis.blockers,
      },
      regexScore.score,
      // No reply turn happens in the bridge path, so there is no pain-question/
      // soft-close signal to derive re-engagement from — always false here.
      false,
      skills.salesStrategy.hotLeadThreshold,
    );
    repos.conversation.upsert(customerPhone, { lead_score: hybrid.score });
    repos.conversation.setLeadIntent(customerPhone, analysis.intent);
    logger.info({ phone: customerPhone, score: hybrid.score }, '[BRIDGE] lead scored silently');
    return;
  }

  const score = computeAnalyzerFallbackScore(
    currentScore,
    regexScore.score,
    // Same rationale as above: bridge path has no re-engagement signal to pass.
    false,
    skills.salesStrategy.hotLeadThreshold,
  );
  repos.conversation.upsert(customerPhone, { lead_score: score });
  logger.info({ phone: customerPhone, score }, '[BRIDGE] lead scored silently');
}
