import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';

const { mockSendTextWithId, mockSendImageUrlWithId, mockSelectThemedImage, mockSendTelegramMessage } = vi.hoisted(() => ({
  mockSendTextWithId: vi.fn<(...args: unknown[]) => Promise<{ whatsappMessageId: string }>>(
    () => Promise.resolve({ whatsappMessageId: 'wamid.TEXT' }),
  ),
  mockSendImageUrlWithId: vi.fn<(...args: unknown[]) => Promise<{ whatsappMessageId: string }>>(
    () => Promise.resolve({ whatsappMessageId: 'wamid.IMAGE' }),
  ),
  mockSelectThemedImage: vi.fn<(...args: unknown[]) => unknown>(() => null),
  mockSendTelegramMessage: vi.fn<(...args: unknown[]) => Promise<boolean>>(() => Promise.resolve(true)),
}));

vi.mock('../services/whatsapp-client.js', () => ({
  sendTemplate: vi.fn(() => Promise.resolve({ whatsappMessageId: 'wamid.OK' })),
  sendTextWithId: mockSendTextWithId,
  sendImageUrlWithId: mockSendImageUrlWithId,
  MAX_IMAGE_CAPTION_CHARS: 1024,
  WhatsAppSendError: class WhatsAppSendError extends Error {
    constructor(message: string, readonly deliveryUncertain: boolean, readonly retryable = false) {
      super(message);
      this.name = 'WhatsAppSendError';
    }
  },
}));

vi.mock('../services/contextual-media.js', () => ({
  selectThemedImage: mockSelectThemedImage,
}));

// `notifyOwnerOnce` lazy-imports the transport; stubbing it keeps the owner-alert
// assertions on the Telegram boundary rather than on the network.
vi.mock('../services/telegram-bot.js', () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}));

import {
  runConsentAskCycle,
  resetExhaustedCycleReportCache,
} from '../services/followup-service.js';
import { env } from '../config/env.js';
import { llmClient } from '../services/response-engine.js';
import type { LlmResult } from '../services/llm/llm-client.js';

const PHONE = '573004445566';
let db: Database.Database;
let repos: Repositories;

function seedAskableLead(phone = PHONE): void {
  const inboundAt = new Date(Date.now() - 60_000).toISOString();
  const outboundAt = new Date(Date.now() - 30_000).toISOString();
  repos.conversation.upsert(phone, { language: 'es', collected_plan: 'plan_2d1n', collected_people: 2 });
  repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'hola', created_at: inboundAt });
  repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'respuesta', created_at: outboundAt });
}

function draft(reply: string): LlmResult {
  return {
    turn: {
      reply,
      sales_phase: 'discovery', action: 'answer', img: false,
      collected_fields: { name: null, plan: null, people: null, date: null, transport_need: null, pet: null },
      lead: { intent: 'curious', buying_signals: [], blockers: [], score_delta: 0, confidence: 1 },
    },
    tokens: { prompt: 10, completion: 10 },
  };
}

const eventFor = (cycleKey: string) =>
  repos.followupSubscriptionEvent.getByPhoneKindCycle(PHONE, 'consent_ask', cycleKey);

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  loadSkills();
  resetExhaustedCycleReportCache();
  mockSendTextWithId.mockClear();
  mockSendTextWithId.mockResolvedValue({ whatsappMessageId: 'wamid.TEXT' });
  mockSendImageUrlWithId.mockClear();
  mockSelectThemedImage.mockClear();
  mockSelectThemedImage.mockReturnValue(null);
  mockSendTelegramMessage.mockClear();
  mockSendTelegramMessage.mockResolvedValue(true);
  vi.spyOn(env, 'AI_ENABLED', 'get').mockReturnValue(true);
  vi.spyOn(env, 'FOLLOWUP_CONSENT_ASK_ENABLED', 'get').mockReturnValue(true);
  vi.spyOn(env, 'FOLLOWUP_DEV_CONSENT_SECONDS', 'get').mockReturnValue(1);
  vi.spyOn(env, 'FOLLOWUP_DEV_ALLOWLIST_PHONES', 'get').mockReturnValue('');
  vi.spyOn(env, 'FOLLOWUP_MAX_ATTEMPTS', 'get').mockReturnValue(3);
  vi.spyOn(env, 'TELEGRAM_BOT_TOKEN', 'get').mockReturnValue('tok');
  vi.spyOn(env, 'TELEGRAM_CHAT_ID', 'get').mockReturnValue('123');
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/**
 * A bounded attempt exists to stop us hammering the LLM provider. Spending one on
 * a condition we did not cause — a state guard, a closed window — let three
 * unlucky ticks kill the cycle permanently, which is how the reported lead ended
 * up never being asked again.
 */
describe('consent ask — transient skips must not consume attempts', () => {
  /**
   * `isBlockedState` only ever fires for a state that changed AFTER the SQL scan —
   * the scan filters the same conditions. So the guard has to be exercised as the
   * real race: the row is claimed, then the conversation converts (or is handed
   * off) before dispatch. Seeding the blocked state up front would instead be
   * filtered by the scan and never create an event row at all.
   */
  function blockStateAfterClaim(options: { once?: boolean } = {}): void {
    const eventRepo = repos.followupSubscriptionEvent;
    const realClaim = eventRepo.claim.bind(eventRepo);
    let fired = false;
    vi.spyOn(eventRepo, 'claim').mockImplementation((...args) => {
      const claimed = realClaim(...args);
      if (claimed !== null && !(options.once && fired)) {
        fired = true;
        repos.conversation.upsert(PHONE, { converted_at: new Date().toISOString() });
      }
      return claimed;
    });
  }

  it('releases the claim when a state guard blocks the send', async () => {
    seedAskableLead();
    blockStateAfterClaim();
    const completeSpy = vi.spyOn(llmClient, 'complete');

    await runConsentAskCycle(repos);

    expect(completeSpy).not.toHaveBeenCalled();
    expect(mockSendTextWithId).not.toHaveBeenCalled();
    // Released rows return to 'due' with the attempt refunded, so the cycle stays
    // claimable instead of dying after FOLLOWUP_MAX_ATTEMPTS unlucky ticks.
    const event = eventFor('c1');
    expect(event?.status).toBe('due');
    expect(event?.attempts).toBe(0);
  });

  it('becomes askable again once the blocking state clears', async () => {
    seedAskableLead();
    // Blocks the first dispatch only, so the second tick is a clean run against
    // the same cycle key — proving the refunded attempt is genuinely reusable.
    blockStateAfterClaim({ once: true });
    vi.spyOn(llmClient, 'complete').mockResolvedValue(draft('¿Te aviso si hay novedades?\n[[FOLLOWUP_CONSENT]]'));

    await runConsentAskCycle(repos);
    expect(eventFor('c1')?.attempts).toBe(0);
    expect(mockSendTextWithId).not.toHaveBeenCalled();

    // Raw SQL on purpose: `conversation.upsert` skips null values, so it cannot
    // clear a column.
    db.prepare('UPDATE conversations SET converted_at = NULL WHERE customer_phone = ?').run(PHONE);
    await runConsentAskCycle(repos);

    expect(mockSendTextWithId).toHaveBeenCalledTimes(1);
    expect(eventFor('c1')?.status).toBe('accepted');
  });

  it('releases the claim when the 24h free-form window has closed', async () => {
    // Inbound older than 24h - 10min: past the window, but still inside the
    // silence threshold, so the SQL scan can hand it to the dispatcher.
    const staleInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    repos.conversation.upsert(PHONE, { language: 'es', collected_plan: 'plan_2d1n', collected_people: 2 });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'hola', created_at: staleInbound });
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'respuesta',
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    await runConsentAskCycle(repos);

    expect(mockSendTextWithId).not.toHaveBeenCalled();
    const event = eventFor('c1');
    // Either never claimed (filtered by SQL) or released — never a burned attempt.
    expect(event === null || (event.status === 'due' && event.attempts === 0)).toBe(true);
  });
});

/**
 * A rejected draft IS a real provider attempt, so it must stay bounded — but the
 * exhaustion has to be visible, because nothing recovers it automatically.
 */
describe('consent ask — draft rejection stays bounded and observable', () => {
  beforeEach(() => {
    seedAskableLead();
    // Missing [[FOLLOWUP_CONSENT]] — the exact failure the skill used to invite.
    vi.spyOn(llmClient, 'complete').mockResolvedValue(draft('¿Te aviso si hay novedades?'));
  });

  it('consumes one attempt per rejected draft and then stops calling the LLM', async () => {
    const completeSpy = vi.spyOn(llmClient, 'complete').mockResolvedValue(draft('sin marcador'));

    for (let tick = 0; tick < 6; tick += 1) await runConsentAskCycle(repos);

    expect(completeSpy).toHaveBeenCalledTimes(3);
    const event = eventFor('c1');
    expect(event?.status).toBe('failed');
    expect(event?.attempts).toBe(3);
    expect(event?.error_reason).toBe('draft_marker_missing');
    expect(mockSendTextWithId).not.toHaveBeenCalled();
  });

  it('adds corrective runtime guidance after the first invalid draft', async () => {
    const completeSpy = vi.spyOn(llmClient, 'complete')
      .mockResolvedValueOnce(draft('sin marcador'))
      .mockResolvedValueOnce(draft('¿Te puedo escribir más adelante?\n[[FOLLOWUP_CONSENT]]'));

    await runConsentAskCycle(repos);
    await runConsentAskCycle(repos);

    const firstPrompt = completeSpy.mock.calls[0]?.[0].systemPrompt ?? '';
    const retryPrompt = completeSpy.mock.calls[1]?.[0].systemPrompt ?? '';
    expect(firstPrompt).not.toContain('CORRECCION PERMISO:');
    expect(retryPrompt).toContain('CORRECCION PERMISO:');
    expect(retryPrompt).toContain('La ultima linea debe ser exactamente [[FOLLOWUP_CONSENT]].');
    expect(mockSendTextWithId).toHaveBeenCalledTimes(1);
    expect(eventFor('c1')?.status).toBe('accepted');
    expect(eventFor('c1')?.attempts).toBe(2);
  });

  it('alerts the owner exactly once, not once per tick', async () => {
    vi.spyOn(llmClient, 'complete').mockResolvedValue(draft('sin marcador'));

    for (let tick = 0; tick < 8; tick += 1) await runConsentAskCycle(repos);
    // Let the fire-and-forget notice settle.
    await new Promise(resolve => setImmediate(resolve));

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    const [, body] = mockSendTelegramMessage.mock.calls[0];
    expect(String(body)).toContain('c1');
    expect(String(body)).toContain('draft_marker_missing');
    expect(repos.ownerAlert.wasAlertedToday(PHONE, 'followup_consent_exhausted:c1')).toBe(true);
  });

  it('does not alert while attempts remain', async () => {
    vi.spyOn(llmClient, 'complete').mockResolvedValue(draft('sin marcador'));

    await runConsentAskCycle(repos);
    await new Promise(resolve => setImmediate(resolve));

    expect(eventFor('c1')?.attempts).toBe(1);
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it('asks again under a new cycle key after an opt-out reopen', async () => {
    vi.spyOn(llmClient, 'complete').mockResolvedValue(draft('sin marcador'));
    for (let tick = 0; tick < 4; tick += 1) await runConsentAskCycle(repos);
    expect(eventFor('c1')?.status).toBe('failed');

    // Customer opts out, then returns of their own accord.
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.revoke(PHONE, 'customer_opt_out');
    expect(repos.followupSubscription.reopenAfterCustomerInbound(PHONE)).toBe(true);

    vi.spyOn(llmClient, 'complete').mockResolvedValue(draft('¿Te aviso si hay novedades?\n[[FOLLOWUP_CONSENT]]'));
    await runConsentAskCycle(repos);

    expect(mockSendTextWithId).toHaveBeenCalledTimes(1);
    expect(eventFor('c2')?.status).toBe('accepted');
  });
});
