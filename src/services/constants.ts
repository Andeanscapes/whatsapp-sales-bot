export const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
] as const;

export const MS_72H = 72 * 60 * 60 * 1000;

export const COLOMBIA_MIDNIGHT_HOUR = 20;
export const COLOMBIA_MORNING_HOUR = 9;

export const SCORE_DECAY_PER_IDLE_TURN = -2;
export const SCORE_REENGAGE_BUMP = 15;
export const SCORE_REGEX_BACKUP_WEIGHT = 0.2;
export const SCORE_REGEX_BACKUP_THRESHOLD_MULTIPLIER = 2;
export const SCORE_CONFIDENCE_FLOOR = 0.3;
export const SCORE_HOT_THRESHOLD_MARGIN = 10;
export const SCORE_BLOCKER_PENALTY_FLOOR = -5;

export const SCORE_GALLERY_TRIGGER_THRESHOLD = 60;

/** Min gap between repeatable reservation_* owner alerts for the same phone. */
export const RESERVATION_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

export const INPUT_COST_PER_TOKEN = 0.15 / 1_000_000;
export const OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000;
