/**
 * One-off recovery of customer "yes" answers to a consent ask that production lost.
 *
 * Two bugs lost them:
 * - 2.0.0–2.0.3 reset an `active` subscription to `unasked` on the next ordinary
 *   inbound (`closeCycleOnCustomerInbound`, removed in 2.1.0).
 * - 2.3.0–2.5.1 let a greeting before the answer ("Buenas tardes" → "si claro")
 *   defer or supersede the ask, so the yes was never classified.
 *
 * The replay uses TODAY's rules (`classifyPendingConsentReply` + `isAskSupersededBy`),
 * so it only recovers what the current webhook would record. It never sends: it
 * re-activates the subscription and the normal scheduler then applies every send
 * guard (silence, opt-out, booking, handoff, paused plan, Bogota window).
 *
 * A replay stops at the first ambiguous inbound that is not a greeting: live, that
 * message would defer the ask or leave it pending, so a later "si" is not an answer
 * to it. Conservative on purpose: a missed recovery is cheaper than invented consent.
 */
import type { Repositories } from '../db/repositories/index.js';
import type { FollowupSubscriptionEventStatus, FollowupSubscriptionStatus } from '../db/repositories/types.js';
import {
  classifyPendingConsentReply,
  isAskSupersededBy,
  isGreetingOnly,
  parseStoredTimestamp,
  type ConsentDecision,
} from './followup-consent.js';

/** Ask statuses where Meta may hold the ask, so the customer may have answered it. */
const REACHED_STATUSES: readonly FollowupSubscriptionEventStatus[] = ['accepted', 'delivered', 'uncertain'];
const MAX_ASKS = 100_000;
const MAX_ROWS_AFTER_ASK = 50;
export const BACKFILL_ACTOR = 'backfill-2026-11';

export type BackfillAction =
  | 'reactivate'
  | 'skip_opted_out'
  | 'skip_stopped_after_yes'
  | 'skip_older_decline_on_record'
  | 'skip_booked'
  | 'skip_handed_off'
  | 'skip_not_interested'
  | 'skip_customer_declined'
  | 'skip_status_declined'
  | 'skip_status_revoked';

export interface MissedConsent {
  phone: string;
  askAt: string;
  replyAt: string;
  replyMessageId: string | null;
  language: 'es' | 'en' | null;
  currentStatus: FollowupSubscriptionStatus | 'missing';
  action: BackfillAction;
}

interface ReplayResult {
  decision: Exclude<ConsentDecision, 'ambiguous'>;
  replyAt: string;
  replyMessageId: string | null;
}

/** Decides one ask the way the webhook would today. `null` = no yes/no was given. */
function replayAsk(repos: Repositories, phone: string, askMessageId: string): ReplayResult | null {
  const later = repos.message.listMessagesAfterMessage(phone, askMessageId, MAX_ROWS_AFTER_ASK);
  for (let index = 0; index < later.length; index += 1) {
    const row = later[index];
    if (row.direction !== 'inbound') continue;
    // Media inbound never reaches the classifier.
    if (row.body === null) continue;
    const decision = classifyPendingConsentReply(row.body, isAskSupersededBy(later.slice(0, index)));
    if (decision !== 'ambiguous') {
      return { decision, replyAt: row.created_at, replyMessageId: row.whatsapp_message_id };
    }
    if (!isGreetingOnly(row.body)) return null;
  }
  return null;
}

function actionFor(
  repos: Repositories,
  phone: string,
  status: FollowupSubscriptionStatus | 'missing',
  replyAt: string,
): BackfillAction {
  const conversation = repos.conversation.getByPhone(phone);
  if (conversation?.opt_out_at) return 'skip_opted_out';
  // A stop request after the yes ends that consent even when the customer later
  // reopened the chat (which clears `opt_out_at` but never `last_opt_out_at`).
  const lastOptOutAt = repos.optOut.getLastOptOutAt(phone);
  if (lastOptOutAt && parseStoredTimestamp(lastOptOutAt) >= parseStoredTimestamp(replyAt)) {
    return 'skip_stopped_after_yes';
  }
  if (status === 'revoked') return 'skip_status_revoked';
  if (status === 'declined') return 'skip_status_declined';
  const customerDecision = repos.followupConsentGrant.latestCustomerDecision(phone);
  if (customerDecision?.decision === 'decline') {
    // An older decline still blocks every send (the send predicate reads the newest
    // `customer_reply` row, and a backfill row is not one), so reactivating would
    // report a recovery that never ships. Listed apart for the operator to review.
    return parseStoredTimestamp(customerDecision.decided_at) >= parseStoredTimestamp(replyAt)
      ? 'skip_customer_declined'
      : 'skip_older_decline_on_record';
  }
  if (conversation?.converted_at) return 'skip_booked';
  if (conversation?.handed_off_at) return 'skip_handed_off';
  if (conversation?.lead_intent === 'not_interested') return 'skip_not_interested';
  return 'reactivate';
}

/**
 * Every customer whose latest decisive answer to a consent ask is a yes, but whose
 * subscription is not `active`. Read-only.
 */
export function findMissedConsents(repos: Repositories): MissedConsent[] {
  const asks = REACHED_STATUSES
    .flatMap(status => repos.followupSubscriptionEvent.listByStatus(status, MAX_ASKS))
    .filter(event => event.event_kind === 'consent_ask' && event.whatsapp_message_id !== null);

  const latestByPhone = new Map<string, ReplayResult & { askAt: string }>();
  for (const ask of asks) {
    const result = replayAsk(repos, ask.customer_phone, ask.whatsapp_message_id ?? '');
    if (!result) continue;
    const previous = latestByPhone.get(ask.customer_phone);
    if (!previous || result.replyAt > previous.replyAt) {
      latestByPhone.set(ask.customer_phone, { ...result, askAt: ask.accepted_at ?? ask.scheduled_for });
    }
  }

  const missed: MissedConsent[] = [];
  for (const [phone, result] of latestByPhone) {
    if (result.decision !== 'affirm') continue;
    const status = repos.followupSubscription.getByPhone(phone)?.status ?? 'missing';
    if (status === 'active') continue;
    missed.push({
      phone,
      askAt: result.askAt,
      replyAt: result.replyAt,
      replyMessageId: result.replyMessageId,
      language: repos.conversation.getByPhone(phone)?.language ?? null,
      currentStatus: status,
      action: actionFor(repos, phone, status, result.replyAt),
    });
  }
  return missed.sort((a, b) => a.replyAt.localeCompare(b.replyAt));
}

/**
 * Re-activates the `reactivate` rows and appends one ledger row each, in one
 * transaction per customer. Idempotent: an active subscription is never listed again.
 */
export function applyMissedConsents(repos: Repositories, missed: readonly MissedConsent[], appVersion: string): number {
  let applied = 0;
  for (const row of missed) {
    if (row.action !== 'reactivate') continue;
    repos.runInTransaction(() => {
      repos.followupSubscription.ensureExists(row.phone);
      repos.followupSubscription.affirm(row.phone, row.replyMessageId ?? `${BACKFILL_ACTOR}:${row.replyAt}`, BACKFILL_ACTOR);
      repos.followupConsentGrant.record({
        customer_phone: row.phone,
        decision: 'affirm',
        decided_at: row.replyAt,
        inbound_message_id: row.replyMessageId,
        source: 'backfill_2026_09',
        actor_id: BACKFILL_ACTOR,
        app_version: appVersion,
      });
    });
    applied += 1;
  }
  return applied;
}
