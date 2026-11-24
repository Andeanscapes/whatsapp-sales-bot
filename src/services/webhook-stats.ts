/**
 * In-memory counters for webhook intake.
 *
 * The bot used to have no way to tell "Meta sent nothing" apart from "we threw
 * it away": both produced silence. These counters make the split visible from
 * `/status` without adding a table or a query to the reply path.
 *
 * Deliberately NOT persisted — they reset on restart, which `/status` states.
 * Persisting them would put a write on the hot inbound path to answer a
 * question the operator asks a few times a week.
 */
/**
 * The one skip reason that is expected traffic rather than a possible lost
 * message: counted apart, never written to `system_errors`, never pages the
 * owner. Lives here, the leaf module, so the route and the counters cannot
 * drift and no import cycle is created.
 */
export const REACTION_SKIP_REASON = 'reaction_ignored';

export interface WebhookStatsSnapshot {
  /** Signature-verified POSTs that reached the handler. */
  posts: number;
  /** Items turned into a message the bot could act on or store. */
  messages: number;
  /** Items that produced no message (excluding reactions). */
  skipped: number;
  /** Reactions seen. Expected and never stored, counted so they are not "losses". */
  reactions: number;
  /** ISO timestamp of the last counter reset (process start). */
  since: string;
}

const stats = {
  posts: 0,
  messages: 0,
  skipped: 0,
  reactions: 0,
  since: new Date().toISOString(),
};

export function recordWebhookPost(): void {
  stats.posts += 1;
}

export function recordWebhookMessages(count: number): void {
  stats.messages += count;
}

export function recordWebhookSkipped(reason: string): void {
  if (reason === REACTION_SKIP_REASON) stats.reactions += 1;
  else stats.skipped += 1;
}

export function getWebhookStats(): WebhookStatsSnapshot {
  return { ...stats };
}

/** Test-only: counters are process-global, so each test must start from zero. */
export function resetWebhookStats(): void {
  stats.posts = 0;
  stats.messages = 0;
  stats.skipped = 0;
  stats.reactions = 0;
  stats.since = new Date().toISOString();
}
