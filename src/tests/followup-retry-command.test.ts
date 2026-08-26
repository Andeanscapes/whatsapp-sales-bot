import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache } from '../services/lead-routing.js';
import { followupRetryHandler } from '../commands/followup-retry.command.js';

const PHONE = '573009900001';
const OWNER_CHAT = 333;
const MAX_ATTEMPTS = 3;

let db: Database.Database;
let repos: Repositories;
let previousChatId: string;
let previousMaxAttempts: number;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousChatId = env.TELEGRAM_CHAT_ID;
  previousMaxAttempts = env.FOLLOWUP_MAX_ATTEMPTS;
  env.TELEGRAM_CHAT_ID = String(OWNER_CHAT);
  // Pinned: the handler compares against this, and the repo default differs.
  env.FOLLOWUP_MAX_ATTEMPTS = MAX_ATTEMPTS;
  resetRoutingConfigCache();
});

afterEach(() => {
  env.TELEGRAM_CHAT_ID = previousChatId;
  env.FOLLOWUP_MAX_ATTEMPTS = previousMaxAttempts;
  resetRoutingConfigCache();
  db.close();
});

function run(arg: string = PHONE): Promise<string> {
  return followupRetryHandler({ repos, args: [arg], chatId: OWNER_CHAT });
}

/** Burns every bounded attempt on the current consent cycle, as the scheduler would. */
function exhaustCycle(): void {
  repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
  repos.followupSubscription.ensureExists(PHONE);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const id = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', MAX_ATTEMPTS, 10);
    expect(id).not.toBeNull();
    repos.followupSubscriptionEvent.markFailed(id as number, 'draft_marker_missing');
  }
  expect(repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', MAX_ATTEMPTS, 10)).toBeNull();
}

const currentEvent = () =>
  repos.followupSubscriptionEvent.getByPhoneKindCycle(PHONE, 'consent_ask', 'c1');

describe('/followupretry', () => {
  it('requires a phone argument', async () => {
    expect(await run('')).toContain('Uso: /followupretry');
  });

  it('rejects an unknown lead', async () => {
    expect(await run()).toContain(PHONE);
  });

  it('makes an exhausted cycle claimable again', async () => {
    exhaustCycle();

    const output = await run();

    expect(output).toContain('reiniciado');
    expect(output).toContain('draft_marker_missing');
    const event = currentEvent();
    expect(event?.status).toBe('due');
    expect(event?.attempts).toBe(0);
    expect(event?.error_reason).toBeNull();
    // The whole point: the scheduler can issue attempts again.
    expect(repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', MAX_ATTEMPTS, 10)).not.toBeNull();
  });

  it('refuses a cycle that still has attempts left', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.followupSubscription.ensureExists(PHONE);
    const id = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', MAX_ATTEMPTS, 10);
    repos.followupSubscriptionEvent.markFailed(id as number, 'draft_marker_missing');

    expect(await run()).toContain('aun tiene intentos');
    expect(currentEvent()?.attempts).toBe(1);
  });

  // The safety boundary: these statuses mean Meta may already have the message, so
  // replaying the cycle could double-send.
  it.each(['accepted', 'uncertain'] as const)('never resets a terminal %s cycle', async status => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.followupSubscription.ensureExists(PHONE);
    const id = repos.followupSubscriptionEvent.claim(PHONE, 'consent_ask', 'c1', MAX_ATTEMPTS, 10) as number;
    if (status === 'accepted') repos.followupSubscriptionEvent.markAccepted(id, 'wamid.SENT');
    else repos.followupSubscriptionEvent.markUncertain(id, 'dispatch_started_delivery_unknown');

    const output = await run();

    expect(output).toContain(`esta en '${status}'`);
    expect(currentEvent()?.status).toBe(status);
    expect(repos.followupSubscriptionEvent.resetExhaustedCycle(PHONE, 'consent_ask', 'c1')).toBe(false);
  });

  it('reports when there is no subscription to retry', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    expect(await run()).toContain('No hay suscripcion');
  });

  // Args are split on whitespace, so `/followupretry +57 300 990 0001` arrives as
  // `+57`. `normalizeCommandPhone` rejects it (under 8 digits), which is the point:
  // the command must refuse rather than act on a truncated number and report success
  // for a reset it never performed.
  it('refuses a truncated phone instead of resetting the wrong cycle', async () => {
    exhaustCycle();

    const output = await followupRetryHandler({ repos, args: ['+57', '300', '990', '0001'], chatId: OWNER_CHAT });

    expect(output).toContain('Uso: /followupretry');
    expect(currentEvent()?.attempts).toBe(MAX_ATTEMPTS);
  });
});
