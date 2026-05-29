export const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
] as const;

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export const MS_72H = 72 * 60 * 60 * 1000;

export const COLOMBIA_MIDNIGHT_HOUR = 20;
export const COLOMBIA_MORNING_HOUR = 9;
