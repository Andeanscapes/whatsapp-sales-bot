import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import type { Repositories } from '../db/repositories/index.js';
import { consentCycleKey } from '../services/followup-consent.js';

const PHONE = '573000000042';

function isoAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

function seedUnansweredLead(db: Database.Database, inboundMinutesAgo: number, phone = PHONE): void {
  db.prepare(`
    INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, collected_plan, collected_people)
    VALUES (?, ?, ?, '2d1n_mining', 2)
  `).run(phone, isoAgo(inboundMinutesAgo + 10), isoAgo(inboundMinutesAgo));
  db.prepare(`INSERT INTO messages (customer_phone, direction, message_type, body, created_at) VALUES (?, 'inbound', 'text', 'hola', ?)`)
    .run(phone, isoAgo(inboundMinutesAgo));
  db.prepare(`INSERT INTO messages (customer_phone, direction, message_type, body, created_at) VALUES (?, 'outbound', 'text', 'reply', ?)`)
    .run(phone, isoAgo(inboundMinutesAgo - 1));
}

// `consentCycleKey` itself is unit-tested in followup-consent.test.ts. This suite
// covers the DB-backed session it reads: who increments it, who must not, and how
// it lets an exhausted cycle be retried under a fresh key.
describe('consent_session lifecycle', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
  });

  const sessionOf = (): number => repos.followupSubscription.getByPhone(PHONE)!.consent_session;

  it('starts a fresh subscription at session 1', () => {
    repos.followupSubscription.ensureExists(PHONE);
    expect(sessionOf()).toBe(1);
    expect(consentCycleKey(sessionOf())).toBe('c1');
  });

  it('opens a new session when a customer opt-out is reopened', () => {
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask1');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');
    repos.followupSubscription.revoke(PHONE, 'customer_opt_out');

    expect(repos.followupSubscription.reopenAfterCustomerInbound(PHONE)).toBe(true);
    expect(sessionOf()).toBe(2);
    expect(consentCycleKey(sessionOf())).toBe('c2');
  });

  it('opens a new session when an active cycle is closed by a customer inbound', () => {
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask1');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');

    expect(repos.followupSubscription.closeCycleOnCustomerInbound(PHONE)).toBe(true);
    expect(sessionOf()).toBe(2);
  });

  it('opens a new session for the bounded pending deferral', () => {
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask1');

    expect(repos.followupSubscription.deferPendingAskAfterCustomerInbound(PHONE)).toBe(true);
    expect(sessionOf()).toBe(2);
    // Still capped at one deferral per session.
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask2');
    expect(repos.followupSubscription.deferPendingAskAfterCustomerInbound(PHONE)).toBe(false);
    expect(sessionOf()).toBe(2);
  });

  it('does NOT open a new session when a failed send rolls back to unasked', () => {
    // A send failure must keep the same cycle key, or bounded retries become
    // unbounded: every attempt would mint a brand new event row.
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask1');
    repos.followupSubscription.resetUnaskedIfPending(PHONE);
    expect(sessionOf()).toBe(1);
  });

  it('surfaces the session on the consent-ask candidate row', () => {
    seedUnansweredLead(db, 5);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask1');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');
    repos.followupSubscription.revoke(PHONE, 'customer_opt_out');
    repos.followupSubscription.reopenAfterCustomerInbound(PHONE);

    const rows = repos.conversation.listConsentAskCandidates({
      silentSinceIso: isoAgo(2),
      windowExpiryIso: isoAgo(24 * 60),
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].consent_session).toBe(2);
  });

  it('defaults the candidate session to 1 when no subscription row exists yet', () => {
    seedUnansweredLead(db, 5);
    const rows = repos.conversation.listConsentAskCandidates({
      silentSinceIso: isoAgo(2),
      windowExpiryIso: isoAgo(24 * 60),
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].consent_session).toBe(1);
    expect(consentCycleKey(rows[0].consent_session)).toBe('c1');
  });

  it('lets an exhausted cycle be asked again under the next session key', () => {
    // The exact reported regression: c1 burns every attempt, so claim() refuses it
    // forever. A reopen must mint c2, which is claimable.
    seedUnansweredLead(db, 5);
    repos.followupSubscription.ensureExists(PHONE);

    const first = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10);
    expect(first).not.toBeNull();
    repos.followupSubscriptionEvent.markFailed(first!, 'draft_marker_missing');
    repos.followupSubscriptionEvent.markFailed(
      repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10)!,
      'draft_marker_missing',
    );
    repos.followupSubscriptionEvent.markFailed(
      repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10)!,
      'draft_marker_missing',
    );
    // c1 is now permanently dead.
    expect(repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10)).toBeNull();

    repos.followupSubscription.revoke(PHONE, 'customer_opt_out');
    expect(repos.followupSubscription.reopenAfterCustomerInbound(PHONE)).toBe(true);
    const nextKey = consentCycleKey(sessionOf());
    expect(nextKey).toBe('c2');
    expect(repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', nextKey, 3, 10)).not.toBeNull();
  });
});

describe('hasAskedSince', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
  });

  it('is false when no ask ever reached Meta', () => {
    repos.followupSubscription.ensureExists(PHONE);
    expect(repos.followupSubscriptionEvent.hasAskedSince(PHONE, isoAgo(60))).toBe(false);
  });

  it('is false for a failed ask (it never reached the customer)', () => {
    const id = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10);
    repos.followupSubscriptionEvent.markFailed(id!, 'llm_no_draft');
    expect(repos.followupSubscriptionEvent.hasAskedSince(PHONE, isoAgo(60))).toBe(false);
  });

  it('is true once an ask was accepted after the cutoff', () => {
    const id = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10);
    repos.followupSubscriptionEvent.markAccepted(id!, 'wamid.ask1');
    expect(repos.followupSubscriptionEvent.hasAskedSince(PHONE, isoAgo(60))).toBe(true);
  });

  it('ignores asks that predate the cutoff', () => {
    const id = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10);
    repos.followupSubscriptionEvent.markAccepted(id!, 'wamid.ask1');
    // Cutoff in the future relative to the accepted row.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(repos.followupSubscriptionEvent.hasAskedSince(PHONE, future)).toBe(false);
  });

  it('ignores recurring events — only consent asks count', () => {
    const id = repos.followupSubscriptionEvent.claim(PHONE, 'recurring', 'c1-r1', 3, 10);
    repos.followupSubscriptionEvent.markAccepted(id!, 'wamid.tpl1');
    expect(repos.followupSubscriptionEvent.hasAskedSince(PHONE, isoAgo(60))).toBe(false);
  });
});
