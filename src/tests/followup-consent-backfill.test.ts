import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { applyMissedConsents, BACKFILL_ACTOR, findMissedConsents } from '../services/followup-consent-backfill.js';
import { hasFollowupPermission } from '../services/followup-service.js';

const PHONE = '573000000088';
const DAY_MS = 86_400_000;

interface Lang {
  lang: 'es' | 'en';
  ask: string;
  yes: string;
  greeting: string;
  chatter: string;
  willWriteMyself: string;
}

const LANGS: Lang[] = [
  {
    lang: 'es', ask: '¿Te puedo escribir por acá más adelante con novedades?', yes: 'Si por favor',
    greeting: 'Buenas tardes', chatter: 'y cuanto vale para dos?', willWriteMyself: 'Claro yo te escribo',
  },
  {
    lang: 'en', ask: 'Can I message you here later with news?', yes: 'yes please',
    greeting: 'Good afternoon', chatter: 'how much is it for two?', willWriteMyself: "Sure, I'll text you",
  },
];

describe.each(LANGS)('lost consent backfill ($lang)', ({ lang, ask, yes, greeting, chatter, willWriteMyself }) => {
  let db: Database.Database;
  let repos: Repositories;
  let minute = 0;

  /** Thread starts 10 days ago and advances one minute per message. */
  const at = (): string => new Date(Date.now() - 10 * DAY_MS + (minute += 1) * 60_000).toISOString();

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    minute = 0;
    repos.conversation.upsert(PHONE, { language: lang, collected_people: 2 });
  });

  function say(direction: 'inbound' | 'outbound', body: string, id?: string): void {
    repos.message.addMessage({
      customer_phone: PHONE, direction, message_type: 'text', body, created_at: at(),
      ...(id ? { whatsapp_message_id: id } : {}),
    });
  }

  function sendAsk(id = 'wamid.ask1', cycle = 'c1'): void {
    say('outbound', ask, id);
    const eventId = repos.followupSubscriptionEvent.ensureExists(PHONE, 'consent_ask', cycle, at());
    repos.followupSubscriptionEvent.markAccepted(eventId, id);
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, id);
  }

  /** The 2.0.x reset: consent recorded, then erased by the next ordinary inbound. */
  function eraseConsent(): void {
    db.prepare(`UPDATE followup_subscriptions SET status = 'unasked', activated_at = NULL,
      consent_session = consent_session + 1 WHERE customer_phone = ?`).run(PHONE);
  }

  it('recovers a 2.0.x yes erased by later chatting, and the one-shot becomes due', () => {
    sendAsk();
    say('inbound', yes, 'wamid.yes');
    say('outbound', 'ok');
    say('inbound', chatter, 'wamid.in2');
    say('outbound', 'reply');
    eraseConsent();

    const missed = findMissedConsents(repos);
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ phone: PHONE, action: 'reactivate', currentStatus: 'unasked', replyMessageId: 'wamid.yes' });

    expect(applyMissedConsents(repos, missed, 'test')).toBe(1);
    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('active');
    expect(hasFollowupPermission(repos, PHONE)).toBe(true);
    expect(repos.followupConsentGrant.listByPhone(PHONE)[0]).toMatchObject({ source: 'backfill_2026_09', actor_id: BACKFILL_ACTOR });

    const sevenDaysSilent = new Date(Date.now() - 7 * DAY_MS).toISOString();
    expect(repos.conversation.listFollowupCandidates({ silentSinceIso: sevenDaysSilent, limit: 25 })
      .map(row => row.customer_phone)).toContain(PHONE);

    // Idempotent: nothing left to recover on a second run.
    expect(findMissedConsents(repos)).toEqual([]);
  });

  it('recovers a yes that followed a greeting the bot answered first', () => {
    sendAsk();
    say('inbound', greeting, 'wamid.greet');
    say('outbound', 'hello back');
    say('inbound', yes, 'wamid.yes');
    say('outbound', 'ok');

    expect(findMissedConsents(repos).map(row => row.action)).toEqual(['reactivate']);
  });

  it('never recovers a yes to a sales question asked after a greeting', () => {
    sendAsk();
    say('inbound', greeting, 'wamid.greet');
    say('outbound', lang === 'es' ? '¿Les cuento cómo es el plan PRIME?' : 'Shall I tell you about the PRIME plan?');
    say('inbound', yes, 'wamid.yes');
    say('outbound', 'ok');

    expect(findMissedConsents(repos)).toEqual([]);
  });

  // The send predicate still reads that older decline, so a reactivation would never ship.
  it('lists a yes with an older decline on record apart, and never reactivates it', () => {
    repos.followupConsentGrant.record({
      customer_phone: PHONE, decision: 'decline', decided_at: new Date(Date.now() - 20 * DAY_MS).toISOString(),
      source: 'customer_reply',
    });
    sendAsk();
    say('inbound', yes, 'wamid.yes');
    say('outbound', 'ok');
    eraseConsent();

    const missed = findMissedConsents(repos);
    expect(missed.map(row => row.action)).toEqual(['skip_older_decline_on_record']);
    expect(applyMissedConsents(repos, missed, 'test')).toBe(0);
    expect(hasFollowupPermission(repos, PHONE)).toBe(false);
  });

  // yes → stop request → customer writes again (reopen clears opt_out_at only).
  it('never reactivates a yes followed by a stop request, even after the chat reopened', () => {
    sendAsk();
    say('inbound', yes, 'wamid.yes');
    say('outbound', 'ok');
    eraseConsent();
    repos.optOut.setOptOut(PHONE);
    repos.optOut.clearOptOut(PHONE);

    const missed = findMissedConsents(repos);
    expect(missed.map(row => row.action)).toEqual(['skip_stopped_after_yes']);
    expect(applyMissedConsents(repos, missed, 'test')).toBe(0);
  });

  it('ignores a reply that only says the customer will write first', () => {
    sendAsk();
    say('inbound', willWriteMyself, 'wamid.amb');
    say('outbound', 'ok');

    expect(findMissedConsents(repos)).toEqual([]);
  });

  it('ignores a yes that answered a newer sales question, not the ask', () => {
    sendAsk();
    say('inbound', chatter, 'wamid.in1');
    say('outbound', 'reply');
    say('inbound', yes, 'wamid.yes');

    expect(findMissedConsents(repos)).toEqual([]);
  });

  it('lists but never reactivates an opted-out customer', () => {
    sendAsk();
    say('inbound', yes, 'wamid.yes');
    say('outbound', 'ok');
    eraseConsent();
    repos.conversation.upsert(PHONE, { opt_out_at: new Date().toISOString() });

    const missed = findMissedConsents(repos);
    expect(missed.map(row => row.action)).toEqual(['skip_opted_out']);
    expect(applyMissedConsents(repos, missed, 'test')).toBe(0);
    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('unasked');
  });

  it('never reactivates a customer who later declined a newer ask', () => {
    sendAsk('wamid.ask1', 'c1');
    say('inbound', yes, 'wamid.yes');
    say('outbound', 'ok');
    eraseConsent();
    sendAsk('wamid.ask2', 'c2');
    say('inbound', lang === 'es' ? 'no gracias' : 'no thanks', 'wamid.no');
    repos.followupSubscription.decline(PHONE, 'wamid.no');

    expect(findMissedConsents(repos)).toEqual([]);
  });

  it('skips booked and not-interested leads', () => {
    sendAsk();
    say('inbound', yes, 'wamid.yes');
    say('outbound', 'ok');
    eraseConsent();
    repos.conversation.upsert(PHONE, { lead_intent: 'not_interested' });
    expect(findMissedConsents(repos).map(row => row.action)).toEqual(['skip_not_interested']);

    repos.conversation.upsert(PHONE, { converted_at: new Date().toISOString() });
    expect(findMissedConsents(repos).map(row => row.action)).toEqual(['skip_booked']);
  });

  it('leaves an already active subscription alone', () => {
    sendAsk();
    say('inbound', yes, 'wamid.yes');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');

    expect(findMissedConsents(repos)).toEqual([]);
  });
});
