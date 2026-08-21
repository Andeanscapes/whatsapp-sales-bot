/**
 * Colombia (America/Bogota) has a fixed UTC-5 offset year-round (no DST since
 * 1993), so local-time math can be done with plain UTC arithmetic instead of
 * timezone-aware Date/Intl calls on every operation. This module is the single
 * source of that conversion so date canonicalization and follow-up scheduling
 * agree on "today" in Colombia.
 */

const BOGOTA_UTC_OFFSET_HOURS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** Returns the Colombia-local calendar date (and hour/minute) for a given instant. */
export function getBogotaCalendarDate(date: Date): CalendarDate & { hour: number; minute: number } {
  const shifted = new Date(date.getTime() - BOGOTA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** Converts a Colombia-local calendar date + time-of-day into the equivalent UTC ISO instant. */
export function bogotaLocalToUtcIso(calendar: CalendarDate, hour: number, minute: number): string {
  return new Date(Date.UTC(calendar.year, calendar.month - 1, calendar.day, hour + BOGOTA_UTC_OFFSET_HOURS, minute)).toISOString();
}

/** Neutral UTC-noon instant representing only a calendar date (safe for day-of-week/diff math). */
export function calendarToUtcNoon(calendar: CalendarDate): Date {
  return new Date(Date.UTC(calendar.year, calendar.month - 1, calendar.day, 12, 0, 0));
}

export function utcNoonToCalendar(date: Date): CalendarDate {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Subtracts one calendar month, clamping the day so it never overflows into the following month. */
export function subtractMonthClamped(calendar: CalendarDate): CalendarDate {
  const month = calendar.month === 1 ? 12 : calendar.month - 1;
  const year = calendar.month === 1 ? calendar.year - 1 : calendar.year;
  const day = Math.min(calendar.day, daysInMonth(year, month));
  return { year, month, day };
}

/** Prior calendar month (year rolls back from January to December). */
export function priorMonth(year: number, month: number): CalendarDate {
  return month === 1 ? { year: year - 1, month: 12, day: 1 } : { year, month: month - 1, day: 1 };
}

export function addDaysToNoon(noon: Date, days: number): Date {
  return new Date(noon.getTime() + days * MS_PER_DAY);
}

export function subtractDaysFromNoon(noon: Date, days: number): Date {
  return new Date(noon.getTime() - days * MS_PER_DAY);
}

export function diffDaysBetweenNoons(fromNoon: Date, toNoon: Date): number {
  return Math.round((toNoon.getTime() - fromNoon.getTime()) / MS_PER_DAY);
}

/** Moves a UTC-noon calendar instant to the nearest Sunday (0 = Sunday). Ties are impossible with integer days. */
export function nearestSundayNoon(noon: Date): Date {
  const dow = noon.getUTCDay();
  if (dow === 0) return noon;
  if (dow <= 3) return addDaysToNoon(noon, -dow);
  return addDaysToNoon(noon, 7 - dow);
}

/** First Sunday of the given calendar month, as a UTC-noon instant. */
export function firstSundayOfMonthNoon(year: number, month: number): Date {
  const start = calendarToUtcNoon({ year, month, day: 1 });
  const dow = start.getUTCDay();
  const offset = dow === 0 ? 0 : 7 - dow;
  return addDaysToNoon(start, offset);
}
