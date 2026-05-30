import type { Skills } from './skill-loader.js';
import { MONTH_NAMES, SCORE_DECAY_PER_IDLE_TURN, SCORE_REENGAGE_BUMP, SCORE_REGEX_BACKUP_WEIGHT, SCORE_REGEX_BACKUP_THRESHOLD_MULTIPLIER, SCORE_CONFIDENCE_FLOOR, SCORE_HOT_THRESHOLD_MARGIN, SCORE_BLOCKER_PENALTY_FLOOR } from './constants.js';

export interface ScoreResult {
  score: number;
  signals: string[];
}

function matchesPattern(text: string, pattern: string): boolean {
  if (pattern === 'month-name') return MONTH_NAMES.some(m => text.includes(m));
  if (pattern === 'date-like-text') return /\b\d{1,2}\s*(?:de)?\s*(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.test(text);
  if (pattern === 'tomorrow') return /\b(tomorrow|mañana|manana)\b/i.test(text);
  if (pattern === 'next weekend') return /\b(next weekend|proximo fin|pr[oó]ximo fin|siguiente fin)\b/i.test(text);
  if (pattern === 'this weekend') return /\b(this weekend|este fin)\b/i.test(text);
  return false;
}

export function scoreMessage(text: string, skills: Skills): ScoreResult {
  const normalized = text.toLowerCase().trim();
  let score = 0;
  const matchedSignals: string[] = [];

  for (const signal of skills.salesStrategy.signals) {
    const keywords = signal.keywords ?? [];
    const patterns = signal.patterns ?? [];
    const matched = keywords.some(k => normalized.includes(k)) || patterns.some(p => matchesPattern(normalized, p));
    if (matched) {
      score += signal.score;
      matchedSignals.push(signal.id);
    }
  }

  for (const neg of skills.salesStrategy.negativeSignals) {
    const matched = (neg.keywords ?? []).some(k => normalized.includes(k));
    if (matched) {
      score += neg.score;
      matchedSignals.push(neg.id);
    }
  }

  return {
    score: Math.max(-skills.salesStrategy.maxScore, Math.min(skills.salesStrategy.maxScore, score)),
    signals: matchedSignals,
  };
}

export interface LlmLeadInput {
  intent: string;
  scoreDelta: number;
  confidence: number;
  buyingSignals: string[];
  blockers: string[];
}

export interface HybridScoreResult {
  score: number;
  intent: string;
  isHot: boolean;
}

export function computeHybridScore(
  currentScore: number,
  llmInput: LlmLeadInput,
  regexScoreDelta: number,
  isReEngagement: boolean,
  hotLeadThreshold: number,
): HybridScoreResult {
  const confidenceWeight = Math.max(SCORE_CONFIDENCE_FLOOR, Math.min(1, llmInput.confidence));
  const weightedLlmDelta = Math.round(llmInput.scoreDelta * confidenceWeight);

  const regexInfluence = Math.abs(regexScoreDelta) > Math.abs(weightedLlmDelta) * SCORE_REGEX_BACKUP_THRESHOLD_MULTIPLIER
    ? Math.round(regexScoreDelta * SCORE_REGEX_BACKUP_WEIGHT)
    : 0;

  let delta = weightedLlmDelta + regexInfluence;

  if (delta < 0 && llmInput.blockers.length > 0 && llmInput.buyingSignals.length === 0) {
    delta = Math.min(delta, SCORE_BLOCKER_PENALTY_FLOOR);
  }

  if (isReEngagement) {
    delta = Math.max(delta, SCORE_REENGAGE_BUMP);
  }

  const rawScore = currentScore + delta;

  const intentIsBooking = llmInput.intent === 'ready_to_book';
  const softCap = intentIsBooking ? hotLeadThreshold + SCORE_HOT_THRESHOLD_MARGIN : hotLeadThreshold - 1;

  const cappedScore = Math.min(rawScore, softCap);
  const clampedScore = Math.max(0, Math.min(100, cappedScore));

  if (delta <= 0 && llmInput.buyingSignals.length === 0 && !intentIsBooking) {
    const decayedScore = Math.max(0, clampedScore + SCORE_DECAY_PER_IDLE_TURN);
    return {
      score: decayedScore,
      intent: llmInput.intent,
      isHot: false,
    };
  }

  return {
    score: clampedScore,
    intent: llmInput.intent,
    isHot: clampedScore >= hotLeadThreshold && intentIsBooking,
  };
}
