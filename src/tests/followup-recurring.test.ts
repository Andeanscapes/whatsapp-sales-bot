import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import type { Repositories } from '../db/repositories/index.js';
import { consentCycleKey, recurringCycleKey } from '../services/followup-consent.js';

const PHONE = '573000000001';

function isoAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

/** Seeds a qualified lead whose last message is ours (i.e. they never replied). */
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

describe('listConsentAskCandidates', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
  });

  const query = (silentMin: number, windowMin = 24 * 60) => repos.conversation.listConsentAskCandidates({
    silentSinceIso: isoAgo(silentMin),
    windowExpiryIso: isoAgo(windowMin),
    limit: 10,
  });

  it('returns a qualified unanswered lead past the threshold', () => {
    seedUnansweredLead(db, 5);
    expect(query(2).map(r => r.customer_phone)).toEqual([PHONE]);
  });

  it('compares real JavaScript ISO timestamps inside the consent window', () => {
    const inbound = new Date(Date.now() - 5 * 60_000).toISOString();
    const outbound = new Date(Date.now() - 4 * 60_000).toISOString();
    repos.conversation.upsert(PHONE, { collected_plan: '2d1n_mining', collected_people: 2 });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'hola', created_at: inbound });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'reply', created_at: outbound });
    expect(repos.conversation.listConsentAskCandidates({
      silentSinceIso: new Date(Date.now() - 2 * 60_000).toISOString(),
      windowExpiryIso: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
      limit: 10,
    })).toHaveLength(1);
  });

  it('does not return a lead that is still inside the wait window', () => {
    seedUnansweredLead(db, 1);
    expect(query(2)).toHaveLength(0);
  });

  it('does not return a lead whose 24h free-form window has closed', () => {
    seedUnansweredLead(db, 25 * 60);
    expect(query(2)).toHaveLength(0);
  });

  it('never asks a lead who replied last (they did not go silent on us)', () => {
    seedUnansweredLead(db, 5);
    db.prepare(`INSERT INTO messages (customer_phone, direction, message_type, body, created_at) VALUES (?, 'inbound', 'text', 'ahi te escribo', ?)`)
      .run(PHONE, isoAgo(2));
    expect(query(2)).toHaveLength(0);
  });

  it('does not re-ask while the original permission question is unanswered', () => {
    seedUnansweredLead(db, 5);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.1');
    expect(query(2)).toHaveLength(0);
  });

  it('allows one deferred re-ask after the customer continues, then keeps c2 pending', () => {
    seedUnansweredLead(db, 60);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask1');
    const firstAsk = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10);
    expect(firstAsk).not.toBeNull();
    repos.followupSubscriptionEvent.markAccepted(firstAsk!, 'wamid.ask1');

    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'muéstrame más fotos', created_at: isoAgo(5) });
    expect(repos.followupSubscription.deferPendingAskAfterCustomerInbound(PHONE)).toBe(true);
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'claro', created_at: isoAgo(4) });

    const rows = query(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].consent_asks_so_far).toBe(1);
    // The deferral opens a new session, and the session — not the ask count — is
    // what mints the next cycle key.
    expect(rows[0].consent_session).toBe(2);
    expect(consentCycleKey(rows[0].consent_session)).toBe('c2');

    repos.followupSubscription.markAsked(PHONE, 'wamid.ask2');
    const secondAsk = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', consentCycleKey(rows[0].consent_session), 3, 10);
    expect(secondAsk).not.toBeNull();
    repos.followupSubscriptionEvent.markAccepted(secondAsk!, 'wamid.ask2');
    expect(repos.followupSubscription.deferPendingAskAfterCustomerInbound(PHONE)).toBe(false);
    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('pending');
    expect(query(2)).toHaveLength(0);
  });

  it('allows a second ask after customer opt-out and a new inbound reopens the opportunity', () => {
    seedUnansweredLead(db, 60);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask1');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes1', 'customer_reply');
    const firstAsk = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10);
    expect(firstAsk).not.toBeNull();
    repos.followupSubscriptionEvent.markAccepted(firstAsk!, 'wamid.ask1');

    repos.runInTransaction(() => {
      repos.optOut.setOptOut(PHONE);
      repos.followupSubscription.revoke(PHONE, 'customer_opt_out');
    });
    repos.runInTransaction(() => {
      repos.optOut.clearOptOut(PHONE);
      expect(repos.followupSubscription.reopenAfterCustomerInbound(PHONE)).toBe(true);
    });

    // New customer-initiated session, then our reply; customer goes silent again.
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'quiero continuar', created_at: isoAgo(5) });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'claro', created_at: isoAgo(4) });

    const rows = query(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].consent_asks_so_far).toBe(1);
    expect(rows[0].consent_session).toBe(2);
    expect(repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', consentCycleKey(rows[0].consent_session), 3, 10)).not.toBeNull();
  });

  it('never downgrades an operator revocation to a customer opt-out', () => {
    seedUnansweredLead(db, 5);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.revoke(PHONE, 'operator');
    const revokedAt = repos.followupSubscription.getByPhone(PHONE)?.revoked_at;

    repos.followupSubscription.revoke(PHONE, 'customer_opt_out');

    const row = repos.followupSubscription.getByPhone(PHONE);
    expect(row?.revoke_source).toBe('operator');
    expect(row?.revoked_at).toBe(revokedAt);
    expect(repos.followupSubscription.reopenAfterCustomerInbound(PHONE)).toBe(false);
  });

  it('lets an operator revocation override a customer opt-out', () => {
    seedUnansweredLead(db, 5);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.revoke(PHONE, 'customer_opt_out');

    repos.followupSubscription.revoke(PHONE, 'operator');

    expect(repos.followupSubscription.getByPhone(PHONE)?.revoke_source).toBe('operator');
  });

  it('never reopens an operator revocation on customer inbound', () => {
    seedUnansweredLead(db, 5);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.revoke(PHONE, 'operator');
    repos.optOut.setOptOut(PHONE);

    expect(repos.followupSubscription.reopenAfterCustomerInbound(PHONE)).toBe(false);
    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('revoked');
    expect(repos.optOut.isOptedOut(PHONE)).toBe(true);
  });

  it('never re-asks a declined lead', () => {
    seedUnansweredLead(db, 5);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.1');
    repos.followupSubscription.decline(PHONE, 'wamid.2');
    expect(query(2)).toHaveLength(0);
  });

  // Consent is session-scoped: re-engagement closes the cycle and earns a new ask.
  it('re-asks after a customer inbound closed an active consent cycle', () => {
    seedUnansweredLead(db, 5);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask1');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes1', 'customer_reply');
    const firstAsk = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10);
    repos.followupSubscriptionEvent.markAccepted(firstAsk!, 'wamid.ask1');

    // While consent is active there is nothing to ask.
    expect(query(2)).toHaveLength(0);

    expect(repos.followupSubscription.closeCycleOnCustomerInbound(PHONE)).toBe(true);

    const rows = query(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].consent_asks_so_far).toBe(1);
    // Closing the cycle opens the next consent session, so the re-ask cannot
    // collide with the key already spent on this customer.
    expect(rows[0].consent_session).toBe(2);
    expect(repos.followupSubscription.getByPhone(PHONE)?.activated_at).toBeNull();
  });

  it.each(['pending', 'declined', 'revoked'])('does not close a %s cycle', status => {
    seedUnansweredLead(db, 5);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    if (status === 'declined') repos.followupSubscription.decline(PHONE, 'wamid.no');
    if (status === 'revoked') repos.followupSubscription.revoke(PHONE, 'operator');

    expect(repos.followupSubscription.closeCycleOnCustomerInbound(PHONE)).toBe(false);
    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe(status);
  });

  it('keeps an unsent due consent event eligible so claim() can retry it', () => {
    seedUnansweredLead(db, 5);
    repos.followupSubscriptionEvent.ensureExists(PHONE, 'consent_ask', 'c1', isoAgo(3));
    expect(query(2)).toHaveLength(1);
  });

  it.each(['opt_out_at', 'converted_at', 'handed_off_at', 'soft_closed_at'])(
    'excludes a lead with %s set',
    column => {
      seedUnansweredLead(db, 5);
      db.prepare(`UPDATE conversations SET ${column} = ? WHERE customer_phone = ?`).run(isoAgo(1), PHONE);
      expect(query(2)).toHaveLength(0);
    },
  );

  it.each(['bridge_active', 'referred', 'human_only'])('excludes conversation_mode=%s', mode => {
    seedUnansweredLead(db, 5);
    db.prepare('UPDATE conversations SET conversation_mode = ? WHERE customer_phone = ?').run(mode, PHONE);
    expect(query(2)).toHaveLength(0);
  });

  it('excludes an unqualified lead with no plan, no people and no price given', () => {
    seedUnansweredLead(db, 5);
    db.prepare('UPDATE conversations SET collected_plan = NULL, collected_people = NULL, price_given_at = NULL WHERE customer_phone = ?').run(PHONE);
    expect(query(2)).toHaveLength(0);
  });

  // Regression: the live C03 thread. The customer answered a transport-diagnosis entry
  // segment and asked "¿qué vale el plan?", so the bot delivered a full quote — but
  // `collected_plan`/`collected_people` are written only from the CUSTOMER's own words or
  // an LLM structured turn, and the plain-text path never fills them. The lead was priced
  // and dormant yet silently unreachable, because the gate ignored `price_given_at`.
  it('includes a quoted lead even when plan and people were never captured', () => {
    seedUnansweredLead(db, 5);
    db.prepare(`
      UPDATE conversations
      SET collected_plan = NULL, collected_people = NULL, price_given_at = ?
      WHERE customer_phone = ?
    `).run(isoAgo(4), PHONE);
    expect(query(2).map(r => r.customer_phone)).toEqual([PHONE]);
  });

  it('never re-asks a lead the analyzer marked not_interested', () => {
    seedUnansweredLead(db, 5);
    db.prepare('UPDATE conversations SET lead_intent = ? WHERE customer_phone = ?').run('not_interested', PHONE);
    expect(query(2)).toHaveLength(0);
  });

  // NULL-intent leads (never analysed) must still be eligible. In SQLite
  // `NULL != 'not_interested'` is NULL and would filter the row out, so this test
  // locks the IS NULL branch of the gate.
  it('still asks a lead whose lead_intent was never set (NULL)', () => {
    seedUnansweredLead(db, 5);
    db.prepare('UPDATE conversations SET lead_intent = NULL WHERE customer_phone = ?').run(PHONE);
    expect(query(2).map(r => r.customer_phone)).toEqual([PHONE]);
  });
});

describe('listRecurringCandidates', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    seedUnansweredLead(db, 60);
  });

  const activate = (activatedMinutesAgo: number) => {
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');
    db.prepare('UPDATE followup_subscriptions SET activated_at = ? WHERE customer_phone = ?')
      .run(isoAgo(activatedMinutesAgo), PHONE);
  };

  /** `silentSinceMin` defaults to the cadence threshold; pass it to decouple the floor. */
  const query = (dueBeforeMin: number, maxSends = 12, silentSinceMin = dueBeforeMin) =>
    repos.conversation.listRecurringCandidates({
      dueBeforeIso: isoAgo(dueBeforeMin),
      silentSinceIso: isoAgo(silentSinceMin),
      maxSends,
      scanLimit: 500,
    });

  /** Records a delivered recurring send so the next cycle index advances. */
  const recordSend = (cycle: string, minutesAgo: number) => {
    const id = repos.followupSubscriptionEvent.ensureExists(PHONE, 'recurring', cycle, isoAgo(minutesAgo));
    repos.followupSubscriptionEvent.markAccepted(id, `wamid.${cycle}`);
    db.prepare('UPDATE followup_subscription_events SET accepted_at = ? WHERE id = ?').run(isoAgo(minutesAgo), id);
  };

  it('makes r1 due once the interval elapsed since activation', () => {
    activate(5);
    const rows = query(3);
    expect(rows).toHaveLength(1);
    expect(rows[0].sends_so_far).toBe(0);
  });

  // Consent authorises writing to a dormant customer, not interrupting a live chat.
  it('never sends while the customer is actively conversing', () => {
    activate(30);
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'como se reserva?', created_at: isoAgo(1) });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'te cuento', created_at: isoAgo(1) });

    expect(query(3)).toHaveLength(0);
  });

  it('never templates over an inbound we have not answered', () => {
    activate(30);
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'hola?', created_at: isoAgo(10) });

    expect(query(3)).toHaveLength(0);
  });

  it('becomes due again once the customer has been silent for the interval', () => {
    activate(60);
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'lo pienso', created_at: isoAgo(30) });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'claro', created_at: isoAgo(29) });

    expect(query(3)).toHaveLength(1);
  });

  // The floor is independent: a short/accelerated cadence must not interleave a
  // template with a conversation the customer was part of minutes ago.
  it('honours the silence floor even when the cadence interval already elapsed', () => {
    activate(60);
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'y la seguridad?', created_at: isoAgo(5) });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'te explico', created_at: isoAgo(4) });

    // Cadence satisfied (1 min), floor not satisfied (needs 30 min of silence).
    expect(query(1, 12, 30)).toHaveLength(0);
    // Same cadence, floor satisfied (needs 2 min of silence).
    expect(query(1, 12, 2)).toHaveLength(1);
  });

  it('does not become due early when DB activation is SQLite format and threshold is ISO', () => {
    activate(1);
    const dueBeforeIso = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(repos.conversation.listRecurringCandidates({ dueBeforeIso, silentSinceIso: dueBeforeIso, maxSends: 12, scanLimit: 500 }))
      .toHaveLength(0);
  });

  it('does not make r1 due before the interval elapsed', () => {
    activate(1);
    expect(query(3)).toHaveLength(0);
  });

  it('advances to r2 after r1 was delivered', () => {
    activate(30);
    recordSend('c1-r1', 5);
    const rows = query(3);
    expect(rows).toHaveLength(1);
    expect(rows[0].sends_so_far).toBe(1);
  });

  it('starts recurring cadence at r1 again after a new consent session', () => {
    // Previous consent session c1 already delivered two templates.
    activate(600);
    const c1 = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', 3, 10);
    repos.followupSubscriptionEvent.markAccepted(c1!, 'wamid.ask1');
    recordSend('c1-r1', 500);
    recordSend('c1-r2', 400);

    // Customer opts out, initiates a new conversation, and grants c2 consent.
    repos.followupSubscription.revoke(PHONE, 'customer_opt_out');
    expect(repos.followupSubscription.reopenAfterCustomerInbound(PHONE)).toBe(true);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask2');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes2', 'customer_reply');
    const c2 = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c2', 3, 10);
    repos.followupSubscriptionEvent.markAccepted(c2!, 'wamid.ask2');
    db.prepare('UPDATE followup_subscriptions SET activated_at = ? WHERE customer_phone = ?')
      .run(isoAgo(5), PHONE);

    const rows = query(3);
    expect(rows).toHaveLength(1);
    expect(rows[0].consent_cycle).toBe(2);
    expect(rows[0].sends_so_far).toBe(0);
    expect(recurringCycleKey(rows[0].sends_so_far, rows[0].consent_cycle)).toBe('c2-r1');
  });

  it('waits the interval again between r1 and r2', () => {
    activate(30);
    recordSend('c1-r1', 1);
    expect(query(3)).toHaveLength(0);
  });

  it('stops at the cap', () => {
    activate(600);
    for (let i = 1; i <= 12; i += 1) recordSend(`c1-r${i}`, 600 - i * 10);
    expect(query(3, 12)).toHaveLength(0);
  });

  it('treats maxSends=0 as unbounded', () => {
    activate(600);
    for (let i = 1; i <= 12; i += 1) recordSend(`c1-r${i}`, 600 - i * 10);
    expect(query(3, 0)).toHaveLength(1);
  });

  it('counts an uncertain send against the cap (Meta may hold it)', () => {
    activate(600);
    const id = repos.followupSubscriptionEvent.ensureExists(PHONE, 'recurring', 'c1-r1', isoAgo(20));
    repos.followupSubscriptionEvent.markUncertain(id, 'timeout');
    db.prepare('UPDATE followup_subscription_events SET accepted_at = ? WHERE id = ?').run(isoAgo(20), id);
    expect(query(3, 1)).toHaveLength(0);
  });

  it.each(['pending', 'declined', 'revoked', 'unasked'])('never sends when consent is %s', status => {
    activate(30);
    db.prepare('UPDATE followup_subscriptions SET status = ? WHERE customer_phone = ?').run(status, PHONE);
    expect(query(3)).toHaveLength(0);
  });

  it('stops immediately after opt-out', () => {
    activate(30);
    db.prepare('UPDATE conversations SET opt_out_at = ? WHERE customer_phone = ?').run(isoAgo(1), PHONE);
    expect(query(3)).toHaveLength(0);
  });

  it('stops once a customer inbound closed the consent cycle', () => {
    activate(30);
    expect(query(3)).toHaveLength(1);

    repos.followupSubscription.closeCycleOnCustomerInbound(PHONE);

    expect(query(3)).toHaveLength(0);
  });

  it('does not claim a second send while one is freshly in flight', () => {
    activate(30);
    const id = repos.followupSubscriptionEvent.claim(PHONE, 'recurring', 'c1-r1', 3, 10);
    expect(id).not.toBeNull();
    expect(repos.followupSubscriptionEvent.claim(PHONE, 'recurring', 'c1-r1', 3, 10)).toBeNull();
  });

  it('marks dispatch uncertain before Meta so a crash cannot resend', () => {
    activate(30);
    const id = repos.followupSubscriptionEvent.claim(PHONE, 'recurring', 'c1-r1', 3, 10);
    expect(id).not.toBeNull();
    repos.followupSubscriptionEvent.startDispatching(id!, new Date(Date.now() + 10 * 60_000).toISOString());

    expect(repos.followupSubscriptionEvent.claim(PHONE, 'recurring', 'c1-r1', 3, 10)).toBeNull();
    expect(repos.followupSubscriptionEvent.getByPhoneKindCycle(PHONE, 'recurring', 'c1-r1')?.status)
      .toBe('uncertain');
  });

  it('a failed send does not consume a cycle, so it retries', () => {
    activate(30);
    const id = repos.followupSubscriptionEvent.ensureExists(PHONE, 'recurring', 'c1-r1', isoAgo(10));
    repos.followupSubscriptionEvent.markFailed(id, '#132000');
    const rows = query(3);
    expect(rows).toHaveLength(1);
    expect(rows[0].sends_so_far).toBe(0);
    expect(repos.followupSubscriptionEvent.claim(PHONE, 'recurring', 'c1-r1', 3, 10)).toBe(id);
  });
});

describe('opt-out revokes the subscription atomically', () => {
  it('leaves no active subscription behind', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    seedUnansweredLead(db, 60);

    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');
    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('active');

    repos.runInTransaction(() => {
      repos.optOut.setOptOut(PHONE);
      repos.followupSubscription.revoke(PHONE, 'customer_opt_out');
    });

    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('revoked');
    expect(repos.optOut.isOptedOut(PHONE)).toBe(true);
    db.close();
  });
});
