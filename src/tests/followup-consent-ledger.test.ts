/**
 * Write-path coverage for `followup_consent_grants`.
 *
 * The repository was previously exercised by calling `record()` directly, which
 * proved the table worked and nothing about whether the five permission-changing
 * paths actually write to it. `/block` did not — it revoked both permission stores
 * with no audit row, so the one action meant to be permanent was the one with no
 * provenance. These tests assert the CALLERS, one row each.
 */
import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../app.js';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';
import { resetRoutingConfigCache } from '../services/lead-routing.js';
import { blockHandler } from '../commands/block.command.js';
import { followupGrantHandler } from '../commands/followup-grant.command.js';
import { followupRevokeHandler } from '../commands/followup-revoke.command.js';
import { hasFollowupPermission } from '../services/followup-service.js';

const { sendTextMock, processMessageMock } = vi.hoisted(() => ({
  sendTextMock: vi.fn(() => Promise.resolve({ whatsappMessageId: 'wamid.OUT' })),
  processMessageMock: vi.fn(async () => ({
    reply: 'Listo.',
    shouldSendReply: true,
    usedAi: false,
    leadScore: 10,
    shouldAlertOwner: false,
    shouldSendImage: false,
    shouldSendOwnerImage: false,
    shouldSendGalleryImages: false,
    priceJustGiven: false,
    outboundDateAction: null,
    ownerAlertType: null,
  })),
}));

vi.mock('../services/whatsapp-client.js', () => ({
  sendText: sendTextMock,
  sendImageUrl: vi.fn(() => Promise.resolve({ whatsappMessageId: 'wamid.IMG' })),
  downloadMedia: vi.fn(),
  WhatsAppSendError: class WhatsAppSendError extends Error {
    deliveryUncertain = false;
  },
}));

// The ledger write under test lives in the ROUTE, before processMessage is called,
// so stubbing the engine keeps the LLM out of these assertions.
vi.mock('../services/response-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/response-engine.js')>();
  return { ...actual, processMessage: processMessageMock };
});

const PHONE = '573001112233';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(body).digest('hex')}`;
}

function inboundPayload(phone: string, text: string, id: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'biz',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          messages: [{ from: phone, id, type: 'text', text: { body: text } }],
        },
      }],
    }],
  });
}

describe('followup consent grant ledger — write paths', () => {
  let db: Database.Database;
  let repos: Repositories;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let previousOwnerOnly: boolean;
  let previousRoutingJson: string;

  beforeEach(async () => {
    loadSkills();
    previousOwnerOnly = env.WEBHOOK_OWNER_ONLY_ENABLED;
    previousRoutingJson = env.LEAD_ROUTING_JSON;
    env.WEBHOOK_OWNER_ONLY_ENABLED = false;
    // Single-line mode: /block then skips the assignment guards.
    env.LEAD_ROUTING_JSON = '';
    resetRoutingConfigCache();
    sendTextMock.mockClear();
    processMessageMock.mockClear();
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    app = await buildApp(repos);
    await app.ready();
  });

  afterEach(async () => {
    env.WEBHOOK_OWNER_ONLY_ENABLED = previousOwnerOnly;
    env.LEAD_ROUTING_JSON = previousRoutingJson;
    resetRoutingConfigCache();
    await app.close();
    db.close();
  });

  async function postInbound(text: string, id: string): Promise<void> {
    const body = inboundPayload(PHONE, text, id);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  }

  function pendingAsk(): void {
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
  }

  it('records a customer affirmation with the message that granted it', async () => {
    pendingAsk();

    await postInbound('si', 'wamid.yes.1');

    await vi.waitFor(() => {
      expect(repos.followupConsentGrant.listByPhone(PHONE)).toHaveLength(1);
    });
    const [row] = repos.followupConsentGrant.listByPhone(PHONE);
    expect(row.decision).toBe('affirm');
    expect(row.source).toBe('customer_reply');
    expect(row.ask_cycle_key).toBe('c1');
    // Provenance is worthless without the message it came from.
    expect(row.inbound_message_id).toBe('wamid.yes.1');
  });

  it('records a customer decline', async () => {
    pendingAsk();

    await postInbound('no gracias', 'wamid.no.1');

    await vi.waitFor(() => {
      expect(repos.followupConsentGrant.listByPhone(PHONE)).toHaveLength(1);
    });
    expect(repos.followupConsentGrant.latestDecision(PHONE)?.decision).toBe('decline');
  });

  // Anything the classifier leaves ambiguous is not a permission decision, so it must
  // not appear in the ledger at all — otherwise the history fills with sales turns.
  it('records nothing for an ambiguous reply', async () => {
    pendingAsk();

    await postInbound('si claro un ritmo tranquilo', 'wamid.amb.1');

    await vi.waitFor(() => {
      expect(processMessageMock).toHaveBeenCalled();
    });
    expect(repos.followupConsentGrant.listByPhone(PHONE)).toEqual([]);
  });

  // A yes is only a permission answer while an ask is pending. Without a pending ask
  // the same word is ordinary conversation.
  it('records nothing when no ask is pending', async () => {
    await postInbound('si', 'wamid.yes.2');

    await vi.waitFor(() => {
      expect(processMessageMock).toHaveBeenCalled();
    });
    expect(repos.followupConsentGrant.listByPhone(PHONE)).toEqual([]);
  });

  it('records an operator grant', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });

    await followupGrantHandler({ repos, chatId: 111, args: [PHONE] });

    const history = repos.followupConsentGrant.listByPhone(PHONE);
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('grant');
    expect(history[0].source).toBe('operator_grant');
    expect(history[0].actor_id).toBe('telegram:111');
  });

  it('records an operator revocation', async () => {
    await followupRevokeHandler({ repos, chatId: 111, args: [PHONE] });

    const history = repos.followupConsentGrant.listByPhone(PHONE);
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('revoke');
    expect(history[0].source).toBe('operator_revoke');
    expect(history[0].actor_id).toBe('telegram:111');
  });

  // The path that had no ledger row at all.
  it('records an operator block', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });

    await blockHandler({ repos, chatId: 111, args: [PHONE] });

    const history = repos.followupConsentGrant.listByPhone(PHONE);
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('revoke');
    expect(history[0].source).toBe('operator_revoke');
    expect(history[0].actor_id).toBe('telegram:111');
    expect(repos.followupConsent.hasConsent(PHONE)).toBe(false);
  });

  // The whole point of an append-only ledger: the live rows get overwritten, the
  // history does not. A grant → block sequence must remain legible afterwards.
  it('keeps the full permission history across a grant then a block', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });

    await followupGrantHandler({ repos, chatId: 111, args: [PHONE] });
    await blockHandler({ repos, chatId: 111, args: [PHONE] });

    const history = repos.followupConsentGrant.listByPhone(PHONE);
    expect(history.map(row => row.decision)).toEqual(['revoke', 'grant']);
    expect(repos.followupConsentGrant.latestDecision(PHONE)?.decision).toBe('revoke');
  });

  // An operator grant cannot overrule the customer's own "no". Recording it would
  // write a permission row that `hasFollowupPermission` then ignores — the operator
  // is told "listo" for an outbound that silently never happens.
  it('refuses to grant over a customer decline and writes no ledger row', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    repos.followupSubscription.decline(PHONE, 'wamid.no');

    const output = await followupGrantHandler({ repos, chatId: 111, args: [PHONE] });

    expect(output).toContain('respondio NO');
    expect(repos.followupConsent.hasConsent(PHONE)).toBe(false);
    expect(repos.followupConsentGrant.listByPhone(PHONE)).toHaveLength(0);
  });

  // `revoke()` rewrites `declined` to `revoked`, so the live status forgets the
  // refusal. Without the ledger check, revoke-then-grant authorised a marketing
  // template over a recorded customer "no" — and `/followupstatus` reported SI.
  it('refuses to grant after an operator revocation erased the declined status', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    pendingAsk();
    await postInbound('no gracias', 'wamid.no.2');
    await vi.waitFor(() => {
      expect(repos.followupConsentGrant.latestCustomerDecision(PHONE)?.decision).toBe('decline');
    });

    await followupRevokeHandler({ repos, chatId: 111, args: [PHONE] });
    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('revoked');

    const output = await followupGrantHandler({ repos, chatId: 111, args: [PHONE] });

    expect(output).toContain('respondio NO');
    expect(repos.followupConsent.hasConsent(PHONE)).toBe(false);
    expect(hasFollowupPermission(repos, PHONE)).toBe(false);
  });

  // Defence in depth: even if a grant row already exists (written before this rule),
  // the recorded refusal must still block the send predicate and the candidate scan.
  it('keeps a recorded decline outranking a pre-existing operator grant', () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.followupConsent.grantConsent(PHONE, 'telegram:111');
    repos.followupConsentGrant.record({
      customer_phone: PHONE,
      decision: 'decline',
      decided_at: new Date().toISOString(),
      inbound_message_id: 'wamid.no.3',
      source: 'customer_reply',
      ask_cycle_key: 'c1',
    });
    // The live subscription is `revoked`, not `declined` — the ledger is the only
    // place the refusal survives.
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.revoke(PHONE, 'operator');

    expect(hasFollowupPermission(repos, PHONE)).toBe(false);
    expect(repos.conversation.listFollowupCandidates({
      silentSinceIso: new Date(Date.now() + 60_000).toISOString(),
      limit: 10,
    })).toHaveLength(0);
  });

  // A later affirmation in a new session is the customer changing their mind, so the
  // ledger check must read the NEWEST customer decision, not any decline ever.
  it('lets a newer customer affirmation supersede an older decline', () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.followupConsentGrant.record({
      customer_phone: PHONE,
      decision: 'decline',
      decided_at: '2026-09-01T10:00:00.000Z',
      source: 'customer_reply',
      ask_cycle_key: 'c1',
    });
    repos.followupConsentGrant.record({
      customer_phone: PHONE,
      decision: 'affirm',
      decided_at: '2026-09-02T10:00:00.000Z',
      source: 'customer_reply',
      ask_cycle_key: 'c2',
    });
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask2');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes2', 'customer_reply');

    expect(hasFollowupPermission(repos, PHONE)).toBe(true);
  });
});
