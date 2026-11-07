/**
 * Message pacing for one turn.
 * The first message goes out as soon as it is ready (no artificial wait); later
 * messages of the same turn keep a 1-4s gap so they arrive in order.
 * Burst merging does not depend on a wait: a newer inbound queued while the reply was
 * being generated still makes pace() return false and the older turn stops sending.
 * Export 2026-11-07: reply rate was flat across first-reply delays (0-60s).
 */

const FIRST_MIN_MS = 0;
const FIRST_MAX_MS = 0;
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
