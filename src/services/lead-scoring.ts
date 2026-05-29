import type Database from 'better-sqlite3';
import type { Skills } from './skill-loader.js';

export interface ScoreResult {
  score: number;
  signals: string[];
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

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
    const matched = neg.keywords.some(k => normalized.includes(k));
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

export function getRunningScore(db: Database.Database, phone: string): number {
  const row = db.prepare('SELECT lead_score FROM conversations WHERE customer_phone = ?').get(phone) as { lead_score: number } | undefined;
  return row?.lead_score ?? 0;
}

export function updateRunningScore(db: Database.Database, phone: string, delta: number): number {
  const current = getRunningScore(db, phone);
  const capped = Math.max(0, Math.min(100, current + delta));
  db.prepare('UPDATE conversations SET lead_score = ? WHERE customer_phone = ?').run(capped, phone);
  return capped;
}
