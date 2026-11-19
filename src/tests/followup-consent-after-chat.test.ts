/**
 * Regression net for the 2.0.x consent loss (export 2026-11-18).
 *
 * Releases 2.0.0–2.0.3 reset an `active` subscription to `unasked` on the next
 * ordinary customer inbound (`closeCycleOnCustomerInbound`, removed in 2.1.0). Every
 * lead who said "sí" and then kept chatting lost the permission before the recurring
 * template came due: 8 of 25 affirmations in Aug–Sep never got a template, all of
 * them had written again; the 17 who stayed silent all got one.
 *
 * These tests drive the REAL engine (`processMessage`) after a recorded yes and then
 * read the sender's own candidate query and due test, so a reintroduced reset fails
 * here rather than one month later in production.
 *
 * Documented rule for ambiguous replies: "sí, apenas tenga todo listo te escribo"
 * says the customer will initiate contact. It is not permission for us to write, so
 * it stays `ambiguous` and never activates consent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { loadSkills } from '../services/skill-loader.js';
import { isConsentAskSuperseded, processMessage } from '../services/response-engine.js';
import { classifyPendingConsentReply } from '../services/followup-consent.js';
import { isRecurringDue, recurringDueBeforeIso, recurringSilentSinceIso } from '../services/followup-service.js';
import type { LlmResult } from '../services/llm/llm-client.js';

/** An ordinary model turn: the later messages take the normal sales path. */
function salesTurn(): LlmResult {
  return {
    turn: {
      reply: 'Claro, te cuento. ¿Para cuántas personas sería?',
      sales_phase: 'discovery',
      action: 'qualify',
      collected_fields: { name: null, plan: null, people: null, date: null, transport_need: null, pet: null },
      lead: { intent: 'qualifying', buying_signals: [], blockers: [], score_delta: 0, confidence: 0.7 },
      img: false,
    },
    tokens: { prompt: 0, completion: 0 },
  };
}

vi.mock('../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({
    complete: vi.fn((): Promise<LlmResult | null> => Promise.resolve(salesTurn())),
  })),
}));

vi.mock('../services/budget-guard.js', () => ({
  checkBudget: vi.fn(() => ({ aiAllowed: true })),
}));

vi.mock('../services/time-window-policy.js', () => ({
  checkTimeWindow: vi.fn(() => ({ isLimited: false })),
}));

vi.mock('../services/lead-analyzer.js', () => ({
  analyzeLead: vi.fn(() => Promise.resolve(null)),
}));

const PHONE = '573000000077';
const DAY_MS = 86_400_000;

/** Strictly increasing timestamps: the candidate query needs our reply AFTER the inbound. */
let clock = 0;
function tick(): string {
  clock += 1;
  return new Date(Date.now() + clock * 1_000).toISOString();
}

interface LanguageCase {
  lang: 'es' | 'en';
  yes: string;
  laterMessages: [string, string];
  optOut: string;
  willWriteMyself: string;
  greeting: string;
  yesAfterGreeting: string;
  otherTopic: string;
}

const CASES: LanguageCase[] = [
  {
    lang: 'es',
    yes: 'Si por favor',
    laterMessages: ['y cuanto vale para dos?', 'listo, lo hablo con mi esposa'],
    optOut: 'no me escribas mas',
    willWriteMyself: 'Si apenas tenga todo listo te escribo',
    greeting: 'Buenas tardes',
    yesAfterGreeting: 'Si claro no hay problema',
    otherTopic: 'y donde queda el pueblo?',
  },
  {
    lang: 'en',
    yes: 'yes please',
    laterMessages: ['how much is it for two?', 'ok, I will talk with my wife'],
    optOut: 'stop messaging me',
    willWriteMyself: 'yes once everything is ready I will text you',
    greeting: 'Good afternoon',
    yesAfterGreeting: 'yes, no problem',
    otherTopic: 'where is the town?',
  },
];

describe.each(CASES)('consent survives later chatting ($lang)', ({
  lang, yes, laterMessages, optOut, willWriteMyself, greeting, yesAfterGreeting, otherTopic,
}) => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    loadSkills();
    vi.spyOn(env, 'FOLLOWUP_DEV_RECURRING_SECONDS', 'get').mockReturnValue(0);
    vi.spyOn(env, 'FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS', 'get').mockReturnValue(0);
    vi.spyOn(env, 'FOLLOWUP_RECURRING_INTERVAL_MONTHS', 'get').mockReturnValue(1);
    vi.spyOn(env, 'FOLLOWUP_RECURRING_MIN_SILENCE_HOURS', 'get').mockReturnValue(72);
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    repos.conversation.upsert(PHONE, { language: lang });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  /** The ask went out and the customer's reply was classified as a yes by the webhook. */
  function recordYes(): void {
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'outbound', message_type: 'text',
      body: 'ask', created_at: tick(), whatsapp_message_id: 'wamid.ask',
    });
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    expect(classifyPendingConsentReply(yes, false)).toBe('affirm');
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'inbound', message_type: 'text',
      body: yes, created_at: tick(), whatsapp_message_id: 'wamid.yes',
    });
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'outbound', message_type: 'text',
      body: 'thanks', created_at: tick(),
    });
  }

  /** One ordinary customer turn through the real engine, answered by us. */
  async function chat(text: string, reply = 'reply'): Promise<void> {
    await processMessage({ repos, customerPhone: PHONE, message: text });
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'outbound', message_type: 'text',
      body: reply, created_at: tick(),
    });
  }

  function dueAfterDays(days: number): boolean {
    const now = Date.now() + days * DAY_MS;
    const rows = repos.conversation.listRecurringCandidates({
      dueBeforeIso: recurringDueBeforeIso(now),
      silentSinceIso: recurringSilentSinceIso(now),
      maxSends: 12,
      scanLimit: 500,
    });
    const row = rows.find(candidate => candidate.customer_phone === PHONE);
    return row !== undefined && isRecurringDue(row, now);
  }

  it('yes then silence: the first recurring template is due after one month', () => {
    recordYes();

    expect(dueAfterDays(20)).toBe(false);
    expect(dueAfterDays(32)).toBe(true);
  });

  it('yes then two more messages: consent stays active and the template is still due', async () => {
    recordYes();
    for (const text of laterMessages) await chat(text);

    const subscription = repos.followupSubscription.getByPhone(PHONE);
    expect(subscription?.status).toBe('active');
    expect(subscription?.activated_at).not.toBeNull();
    expect(subscription?.consent_session).toBe(1);
    expect(repos.conversation.getHandedOffAt(PHONE)).toBeNull();
    expect(dueAfterDays(32)).toBe(true);
  });

  it('yes then opt-out: consent is revoked and nothing is ever due', async () => {
    recordYes();
    await processMessage({ repos, customerPhone: PHONE, message: optOut });

    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('revoked');
    expect(dueAfterDays(32)).toBe(false);
    expect(dueAfterDays(400)).toBe(false);
  });

  it('"I will write to you when ready" is ambiguous and never activates consent', () => {
    expect(classifyPendingConsentReply(willWriteMyself, false)).toBe('ambiguous');

    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('pending');
    expect(dueAfterDays(32)).toBe(false);
  });
  /** The ask is out and nothing has been answered yet. */
  function pendingAsk(): void {
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'outbound', message_type: 'text',
      body: 'ask', created_at: tick(), whatsapp_message_id: 'wamid.ask',
    });
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
  }

  /** What the webhook decides for the next inbound (same predicate pair it calls). */
  function webhookDecision(text: string): string {
    const subscription = repos.followupSubscription.getByPhone(PHONE);
    return subscription?.status === 'pending'
      ? classifyPendingConsentReply(text, isConsentAskSuperseded(repos, PHONE, subscription))
      : 'ambiguous';
  }

  // Export 2026-11-18: "Buenas tardes" deferred the ask to `unasked`, the "si claro"
  // that followed was never read, a second ask went out and stayed pending forever.
  it('a greeting before the answer keeps the ask pending and the yes still counts', async () => {
    pendingAsk();
    await chat(greeting, lang === 'es' ? 'Buenas tardes, un gusto.' : 'Good afternoon, nice to hear from you.');

    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('pending');
    expect(webhookDecision(yesAfterGreeting)).toBe('affirm');
  });

  it('a greeting answered with the permission question again keeps the yes', async () => {
    pendingAsk();
    await chat(greeting, lang === 'es'
      ? 'Buenas tardes. ¿Te puedo escribir por acá más adelante con novedades?'
      : 'Good afternoon. Can I message you here later with news?');

    expect(webhookDecision(lang === 'es' ? 'si' : 'yes')).toBe('affirm');
  });

  // Review 2026-11-19: invariant 8 makes our reply to a greeting usually end in a
  // new sales question. A bare yes then answers that question, never the ask.
  it('a greeting answered with a new sales question: a bare yes is not consent', async () => {
    pendingAsk();
    await chat(greeting, lang === 'es' ? 'Buenas tardes. ¿Les cuento cómo es el plan PRIME?' : 'Good afternoon. Shall I tell you about the PRIME plan?');

    expect(webhookDecision(lang === 'es' ? 'si' : 'yes')).toBe('ambiguous');
  });

  it('several greetings and a photo + text reply with no question keep the ask open', () => {
    pendingAsk();
    for (const body of [lang === 'es' ? 'Hola' : 'Hi', greeting]) {
      repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body, created_at: tick() });
    }
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'image', created_at: tick() });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: lang === 'es' ? 'Hola, un gusto.' : 'Hi, nice to hear from you.', created_at: tick() });

    expect(webhookDecision(lang === 'es' ? 'si' : 'yes')).toBe('affirm');
  });

  // The 2026-10-14 rule is unchanged: once the customer moved on and we asked
  // something newer, a bare yes answers that newer question.
  it('a real new topic still supersedes the ask', async () => {
    pendingAsk();
    await chat(otherTopic);

    expect(webhookDecision(lang === 'es' ? 'si' : 'yes')).toBe('ambiguous');
  });
  // 2026-10-14 rule kept inside the greeting exception: a booking question owns the "si".
  it('a booking question asked after a greeting still supersedes the ask', () => {
    pendingAsk();
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: greeting, created_at: tick() });
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'outbound', message_type: 'text',
      body: lang === 'es' ? '¿Quieren que iniciemos la reserva?' : 'Shall we start it now?', created_at: tick(),
    });

    expect(webhookDecision(lang === 'es' ? 'si' : 'yes')).toBe('ambiguous');
  });
});
