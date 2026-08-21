/**
 * Human-like message delay simulation.
 * Emulates natural response timing: ~10-40s thinking time before first message,
 * then 1-4s between messages in a burst (gallery sends, follow-ups, etc).
 */

const FIRST_MIN_MS = 10_000;
const FIRST_MAX_MS = 40_000;
const BURST_MIN_MS = 1_000;
const BURST_MAX_MS = 4_000;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface TurnPacer {
  /** False means a newer inbound superseded this turn and its sends must stop. */
  pace(): Promise<boolean>;
}

/**
 * Create a pacer for a single inbound turn.
 * @param startedAtMs - timestamp when the turn processing began (e.g., Date.now() at task start)
 * @param shouldSkip - callback; if true, pace() returns immediately (newer inbound already queued)
 * @param enabled - if false, pace() is a no-op
 */
export function createTurnPacer(
  startedAtMs: number,
  shouldSkip: () => boolean,
  enabled: boolean
): TurnPacer {
  let isFirst = true;

  return {
    async pace(): Promise<boolean> {
      if (shouldSkip()) return false;
      if (!enabled) return true;

      if (isFirst) {
        isFirst = false;
        const elapsed = Date.now() - startedAtMs;
        const targetDelay = randomInt(FIRST_MIN_MS, FIRST_MAX_MS);
        const remaining = Math.max(0, targetDelay - elapsed);
        if (remaining > 0) await sleep(remaining);
      } else {
        const burstDelay = randomInt(BURST_MIN_MS, BURST_MAX_MS);
        await sleep(burstDelay);
      }
      return !shouldSkip();
    },
  };
}
