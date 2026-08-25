import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache } from '../services/lead-routing.js';
import { followupStatusHandler } from '../commands/followup-status.command.js';

const PHONE = '573009900001';
const OWNER_CHAT = 333;

let db: Database.Database;
let repos: Repositories;
let previousChatId: string;
let previousConsentSeconds: number;
let previousAskEnabled: boolean;
let previousAllowlist: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousChatId = env.TELEGRAM_CHAT_ID;
  previousConsentSeconds = env.FOLLOWUP_DEV_CONSENT_SECONDS;
  previousAskEnabled = env.FOLLOWUP_CONSENT_ASK_ENABLED;
  previousAllowlist = env.FOLLOWUP_DEV_ALLOWLIST_PHONES;
  env.TELEGRAM_CHAT_ID = String(OWNER_CHAT);
  env.FOLLOWUP_DEV_CONSENT_SECONDS = 60;
  env.FOLLOWUP_CONSENT_ASK_ENABLED = true;
  env.FOLLOWUP_DEV_ALLOWLIST_PHONES = '';
  resetRoutingConfigCache();
});

afterEach(() => {
  env.TELEGRAM_CHAT_ID = previousChatId;
  env.FOLLOWUP_DEV_CONSENT_SECONDS = previousConsentSeconds;
  env.FOLLOWUP_CONSENT_ASK_ENABLED = previousAskEnabled;
  env.FOLLOWUP_DEV_ALLOWLIST_PHONES = previousAllowlist;
  resetRoutingConfigCache();
  db.close();
});

function run(): Promise<string> {
  return followupStatusHandler({ repos, args: [PHONE], chatId: OWNER_CHAT });
}

describe('/followupstatus', () => {
  it('reports a missing lead', async () => {
    expect(await run()).toContain('573009900001');
  });

  it('names the subscription status as the blocker when it is not unasked', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');

    const output = await run();

    // This is the exact state that silently blocks every future ask.
    expect(output).toContain('status: pending');
    expect(output).toContain("suscripcion en 'pending'");
  });

  it('reports no blockers for a qualified unasked lead', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.followupSubscription.ensureExists(PHONE);

    const output = await run();

    expect(output).toContain('ninguno — elegible');
  });

  it('lists each conversation gate that rejects the lead', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setHandedOff(PHONE);
    repos.conversation.setSoftClosed(PHONE);

    const output = await run();

    expect(output).toContain('handed_off_at');
    expect(output).toContain('soft_closed_at');
    // No plan, no people, no price → not qualified.
    expect(output).toContain('no calificado');
  });

  it('shows remaining silence and that the last message must be ours', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.message.addMessage({
      whatsapp_message_id: 'in-1',
      customer_phone: PHONE,
      direction: 'inbound',
      message_type: 'text',
      body: 'hola',
      created_at: new Date().toISOString(),
    });

    const output = await run();

    expect(output).toMatch(/faltan ~\d+s de silencio/);
    expect(output).toContain('el ultimo mensaje es del cliente');
  });

  it('warns when the dev allowlist excludes the number', async () => {
    const previous = env.FOLLOWUP_DEV_ALLOWLIST_PHONES;
    env.FOLLOWUP_DEV_ALLOWLIST_PHONES = '573000000000';
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });

    const output = await run();

    expect(output).toContain('EXCLUYE este numero');
    env.FOLLOWUP_DEV_ALLOWLIST_PHONES = previous;
  });

  it('lists dispatch events with their failure reason', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.followupSubscription.ensureExists(PHONE);
    const eventId = repos.followupSubscriptionEvent.ensureExists(
      PHONE, 'consent_ask', 'c1', new Date().toISOString(),
    );
    repos.followupSubscriptionEvent.markFailed(eventId, 'llm_draft_rejected');

    const output = await run();

    expect(output).toContain('consent_ask c1');
    expect(output).toContain('llm_draft_rejected');
  });

  it('shows the consent session and the cycle key it mints', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.followupSubscription.ensureExists(PHONE);

    expect(await run()).toContain('cycle_key c1');

    repos.followupSubscription.markAsked(PHONE, 'wamid.ask1');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');
    repos.followupSubscription.revoke(PHONE, 'customer_opt_out');
    repos.followupSubscription.reopenAfterCustomerInbound(PHONE);

    expect(await run()).toContain('cycle_key c2');
  });

  // `followup_subscriptions.ask_attempts` is never written by any code path, so
  // printing it told the operator "0" while the real count sat on the event row.
  it('does not report the never-written ask_attempts column', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.followupSubscription.ensureExists(PHONE);

    expect(await run()).not.toContain('ask_attempts');
  });

  it('flags an exhausted cycle as the blocker', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.followupSubscription.ensureExists(PHONE);
    const eventId = repos.followupSubscriptionEvent.ensureExists(
      PHONE, 'consent_ask', 'c1', new Date().toISOString(),
    );
    // Burn every bounded attempt on the current cycle.
    db.prepare('UPDATE followup_subscription_events SET attempts = ? WHERE id = ?')
      .run(env.FOLLOWUP_MAX_ATTEMPTS, eventId);
    repos.followupSubscriptionEvent.markFailed(eventId, 'draft_marker_missing');

    const output = await run();

    expect(output).toContain('AGOTADO');
    expect(output).toContain('requiere nueva sesion');
  });

  it('does not flag exhaustion while attempts remain', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', collected_people: 2 });
    repos.followupSubscription.ensureExists(PHONE);
    const eventId = repos.followupSubscriptionEvent.ensureExists(
      PHONE, 'consent_ask', 'c1', new Date().toISOString(),
    );
    repos.followupSubscriptionEvent.markFailed(eventId, 'draft_marker_missing');

    expect(await run()).not.toContain('AGOTADO');
  });
});
