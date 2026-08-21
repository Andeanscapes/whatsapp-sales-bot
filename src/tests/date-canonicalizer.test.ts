import { describe, expect, it } from 'vitest';
import { canonicalizeDateText } from '../services/date-canonicalizer.js';

// Fixed "now" so year-inference is deterministic: 2026-08-03 (Colombia).
const NOW = new Date('2026-08-03T15:00:00.000Z');

describe('canonicalizeDateText', () => {
  it('parses day + month (day before month, Spanish)', () => {
    expect(canonicalizeDateText('26 de septiembre', NOW)).toEqual({ year: 2026, month: 9, day: 26 });
  });

  it('parses month-only text', () => {
    expect(canonicalizeDateText('noviembre', NOW)).toEqual({ year: 2026, month: 11, day: null });
  });

  it('strips a weekday prefix', () => {
    expect(canonicalizeDateText('sábado 15 de agosto', NOW)).toEqual({ year: 2026, month: 8, day: 15 });
    expect(canonicalizeDateText('sábado, 15 de agosto', NOW)).toEqual({ year: 2026, month: 8, day: 15 });
  });

  it('parses English month-day order', () => {
    expect(canonicalizeDateText('November 17', NOW)).toEqual({ year: 2026, month: 11, day: 17 });
  });

  it('rolls to next year when the month already passed this year with no explicit year', () => {
    expect(canonicalizeDateText('febrero', NOW)).toEqual({ year: 2027, month: 2, day: null });
  });

  it('keeps current year when month is still ahead this year', () => {
    expect(canonicalizeDateText('octubre', NOW)).toEqual({ year: 2026, month: 10, day: null });
  });

  it('respects an explicit year', () => {
    expect(canonicalizeDateText('15 de agosto de 2027', NOW)).toEqual({ year: 2027, month: 8, day: 15 });
  });

  it('returns null for deferred/relative sentinel values', () => {
    expect(canonicalizeDateText('tentative_unknown', NOW)).toBeNull();
    expect(canonicalizeDateText('_relative_ordinal_1', NOW)).toBeNull();
  });

  it('returns null when no month token is present', () => {
    expect(canonicalizeDateText('15', NOW)).toBeNull();
    expect(canonicalizeDateText('', NOW)).toBeNull();
  });

  it('rejects impossible calendar dates', () => {
    expect(canonicalizeDateText('31 de febrero de 2027', NOW)).toBeNull();
    expect(canonicalizeDateText('April 31 2027', NOW)).toBeNull();
  });
});
