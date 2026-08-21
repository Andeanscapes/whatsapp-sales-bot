import { daysInMonth, getBogotaCalendarDate } from './colombia-calendar.js';

/**
 * Best-effort parse of the free-text `collected_date` field into a canonical
 * {year, month, day} structure. `day` is null when only a month was mentioned
 * ("agosto", "septiembre"). Returns null when no month token is found — the
 * date stays free-text-only and is not eligible for the deterministic
  * date qualification storage (source of truth stays `collected_date`).
 */

const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const MONTHS_EN = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_TOKENS = [...MONTHS_ES, ...MONTHS_EN];
const MONTH_PATTERN = MONTH_TOKENS.join('|');

export interface CanonicalDate {
  year: number;
  month: number; // 1-12
  day: number | null;
}

function monthNumber(token: string): number {
  const norm = token.toLowerCase();
  const esIndex = MONTHS_ES.indexOf(norm);
  if (esIndex !== -1) return esIndex + 1;
  return MONTHS_EN.indexOf(norm) + 1;
}

export function canonicalizeDateText(text: string, now: Date = new Date()): CanonicalDate | null {
  if (!text || typeof text !== 'string') return null;
  const norm = text.toLowerCase().trim();
  if (!norm || norm.startsWith('_') || norm === 'tentative_unknown') return null;

  const monthMatch = new RegExp(`\\b(${MONTH_PATTERN})\\b`, 'i').exec(norm);
  if (!monthMatch) return null;
  const monthToken = monthMatch[1];
  const month = monthNumber(monthToken);
  if (month < 1 || month > 12) return null;

  const dayBefore = new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?${monthToken}\\b`, 'i').exec(norm);
  const dayAfter = new RegExp(`\\b${monthToken}\\s+(\\d{1,2})\\b`, 'i').exec(norm);
  const dayRaw = dayBefore?.[1] ?? dayAfter?.[1] ?? null;
  let day: number | null = null;
  if (dayRaw) {
    const parsed = parseInt(dayRaw, 10);
    if (parsed < 1 || parsed > 31) return null;
    day = parsed;
  }

  const yearMatch = /\b(20\d{2})\b/.exec(norm);
  const bogotaNow = getBogotaCalendarDate(now);

  let year: number;
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  } else if (month < bogotaNow.month || (month === bogotaNow.month && day != null && day < bogotaNow.day)) {
    // Mentioned month/day already passed this year — assume next occurrence.
    year = bogotaNow.year + 1;
  } else {
    year = bogotaNow.year;
  }

  if (day != null && day > daysInMonth(year, month)) return null;

  return { year, month, day };
}
