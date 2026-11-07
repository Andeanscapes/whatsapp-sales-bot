/**
 * Message pacing for one turn. There is no response delay: the first message goes out
 * as soon as it is ready. Later messages of the same turn (photos, then the text) keep
 * a 1-4s gap so WhatsApp delivers them in order.
 * Burst merging needs no wait: a newer inbound queued while the reply was being
 * generated makes pace() return false, and the older turn stops sending.
 * Export 2026-11-07: reply rate was flat across first-reply delays (0-60s).
 */

const GAP_MIN_MS = 1_000;
const GAP_MAX_MS = 4_000;

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
 * @param shouldSkip - true when a newer inbound for the same phone is already queued
 */
export function createTurnPacer(shouldSkip: () => boolean): TurnPacer {
  let isFirst = true;

  return {
    async pace(): Promise<boolean> {
      if (shouldSkip()) return false;
      if (isFirst) {
        isFirst = false;
        return true;
      }
      await sleep(randomInt(GAP_MIN_MS, GAP_MAX_MS));
      return !shouldSkip();
    },
  };
}
