import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';

const { mockSendTemplate, mockSendTextWithId, mockSendImageUrlWithId, mockSelectThemedImage } = vi.hoisted(() => ({
  mockSendTemplate: vi.fn<(...args: unknown[]) => Promise<{ whatsappMessageId: string }>>(
    () => Promise.resolve({ whatsappMessageId: 'wamid.OK' }),
  ),
  mockSendTextWithId: vi.fn<(...args: unknown[]) => Promise<{ whatsappMessageId: string }>>(
    () => Promise.resolve({ whatsappMessageId: 'wamid.TEXT' }),
  ),
  mockSendImageUrlWithId: vi.fn<(...args: unknown[]) => Promise<{ whatsappMessageId: string }>>(
    () => Promise.resolve({ whatsappMessageId: 'wamid.IMAGE' }),
  ),
  mockSelectThemedImage: vi.fn<(...args: unknown[]) => unknown>(() => null),
}));

vi.mock('../services/whatsapp-client.js', () => ({
  sendTemplate: mockSendTemplate,
  sendTextWithId: mockSendTextWithId,
  sendImageUrlWithId: mockSendImageUrlWithId,
  // Mirrors the real constant: a stub of 0/undefined would silently disable the
  // image envelope and make every consent-ask test pass down the text path.
  MAX_IMAGE_CAPTION_CHARS: 1024,
  WhatsAppSendError: class WhatsAppSendError extends Error {
    constructor(message: string, readonly deliveryUncertain: boolean, readonly retryable = false, readonly metaCode?: string) {
      super(message);
      this.name = 'WhatsAppSendError';
    }
  },
}));

// Theme resolution itself is unit-tested in contextual-media.test.ts; here we only
// control which branch the consent ask takes.
vi.mock('../services/contextual-media.js', () => ({
  selectThemedImage: mockSelectThemedImage,
}));

import { runConsentAskCycle, runFollowupCycle, runRecurringCycle } from '../services/followup-service.js';
import { WhatsAppSendError } from '../services/whatsapp-client.js';
import { env } from '../config/env.js';
import { llmClient } from '../services/response-engine.js';
import type { LlmResult } from '../services/llm/llm-client.js';

const PHONE = '573001112233';
let db: Database.Database;
let repos: Repositories;

/** Lead that satisfies every SQL gate: consent, collected field, silence, answered inbound. */
function seedEligibleLead(phone = PHONE, opts: { language?: string; hoursAgo?: number } = {}): void {
  const hoursAgo = opts.hoursAgo ?? 48;
  const inboundAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  const outboundAt = new Date(Date.now() - (hoursAgo - 0.5) * 60 * 60 * 1000).toISOString();

  repos.conversation.upsert(phone, { language: opts.language ?? 'es', collected_plan: 'plan_2d1n', collected_people: 2 });
  repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'hola', created_at: inboundAt });
  repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'respuesta', created_at: outboundAt });
  repos.followupConsent.grantConsent(phone, 'telegram:1');
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  loadSkills();
  mockSendTemplate.mockClear();
  mockSendTemplate.mockResolvedValue({ whatsappMessageId: 'wamid.OK' });
  mockSendTextWithId.mockClear();
  mockSendTextWithId.mockResolvedValue({ whatsappMessageId: 'wamid.TEXT' });
  mockSendImageUrlWithId.mockClear();
  mockSendImageUrlWithId.mockResolvedValue({ whatsappMessageId: 'wamid.IMAGE' });
  mockSelectThemedImage.mockClear();
  mockSelectThemedImage.mockReturnValue(null);
  vi.spyOn(env, 'ALLOW_FOLLOWUP_TEMPLATE', 'get').mockReturnValue(true);
  vi.spyOn(env, 'FOLLOWUP_TEMPLATE_HEADER', 'get').mockReturnValue('none');
  // Pin the dev accelerators: without this the suite silently inherits whatever
  // .env.dev happens to set, and a non-empty allowlist filters out the test phone.
  // Individual tests override these with their own spies.
  vi.spyOn(env, 'FOLLOWUP_DEV_MINUTES', 'get').mockReturnValue(0);
  vi.spyOn(env, 'FOLLOWUP_DEV_ALLOWLIST_PHONES', 'get').mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('followup scheduler — eligibility', () => {
  it('sends exactly one template to an eligible lead', async () => {
    seedEligibleLead();
    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    const [to, templateName, languageCode, bodyParams] = mockSendTemplate.mock.calls[0];
    expect(to).toBe(PHONE);
    expect(templateName).toBe('tour_followup_nodate_v1');
    expect(languageCode).toBe('es_CO');
    expect(bodyParams).toHaveLength(1);
    expect(repos.followupEvent.getLatest(PHONE)?.status).toBe('sent');
  });

  it('does not resend on a later tick (restart-safe)', async () => {
    seedEligibleLead();
    await runFollowupCycle(repos);
    await runFollowupCycle(repos);
    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('sends once when two overlapping ticks race', async () => {
    seedEligibleLead();
    await Promise.all([runFollowupCycle(repos), runFollowupCycle(repos)]);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('is disabled unless ALLOW_FOLLOWUP_TEMPLATE is true', async () => {
    vi.spyOn(env, 'ALLOW_FOLLOWUP_TEMPLATE', 'get').mockReturnValue(false);
    seedEligibleLead();
    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it.each([
    ['no consent', () => repos.followupConsent.revokeConsent(PHONE)],
    ['opted out', () => repos.conversation.upsert(PHONE, { opt_out_at: new Date().toISOString() })],
    ['booked', () => repos.conversation.upsert(PHONE, { converted_at: new Date().toISOString() })],
    ['handed off', () => repos.conversation.setHandedOff(PHONE)],
  ])('skips a lead that is %s', async (_label, mutate) => {
    seedEligibleLead();
    mutate();
    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('skips a lead with no collected qualification field', async () => {
    const inboundAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'hola', created_at: inboundAt });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'r', created_at: new Date().toISOString() });
    repos.followupConsent.grantConsent(PHONE, 'telegram:1');

    await runFollowupCycle(repos);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  // A delivered quote qualifies the lead on its own: neither collected column is
  // guaranteed to be set when the bot prices a plan (see QUALIFIED_FOR_FOLLOWUP_SQL).
  it('templates a quoted lead whose plan and people were never captured', async () => {
    const inboundAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setPriceGiven(PHONE);
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'que vale el plan ?', created_at: inboundAt });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'r', created_at: new Date().toISOString() });
    repos.followupConsent.grantConsent(PHONE, 'telegram:1');

    await runFollowupCycle(repos);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('never templates over an unanswered inbound', async () => {
    seedEligibleLead();
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'inbound', message_type: 'text',
      body: 'sigo esperando', created_at: new Date().toISOString(),
    });

    await runFollowupCycle(repos);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('re-checks dormancy after claim before sending', async () => {
    seedEligibleLead();
    const originalHasConsent = repos.followupConsent.hasConsent.bind(repos.followupConsent);
    vi.spyOn(repos.followupConsent, 'hasConsent').mockImplementation(phone => {
      repos.message.addMessage({
        customer_phone: phone, direction: 'inbound', message_type: 'text',
        body: 'volvi', created_at: new Date().toISOString(),
      });
      return originalHasConsent(phone);
    });

    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(repos.followupEvent.getLatest(PHONE)).toBeNull();
  });

  it('skips a lead still inside the silence window', async () => {
    seedEligibleLead(PHONE, { hoursAgo: 2 });
    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('skips when the bot is paused without consuming a retry attempt', async () => {
    seedEligibleLead();
    repos.setPaused(true);
    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
    // The claim is released, not failed: a pause must not burn the send budget.
    expect(repos.followupEvent.getLatest(PHONE)).toBeNull();

    repos.setPaused(false);
    await runFollowupCycle(repos);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(repos.followupEvent.getLatest(PHONE)?.attempts).toBe(1);
  });

  it.each([
    ['bridge_active', () => repos.conversation.setMode(PHONE, 'bridge_active')],
    ['referred', () => repos.conversation.setMode(PHONE, 'referred')],
    ['human_only', () => repos.conversation.setMode(PHONE, 'human_only')],
    ['soft-closed', () => repos.conversation.setSoftClosed(PHONE)],
  ])('skips a lead that is %s', async (_label, mutate) => {
    seedEligibleLead();
    mutate();
    await runFollowupCycle(repos);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });
});

describe('followup scheduler — consent ask race', () => {
  it('does not send when the customer writes while the LLM drafts the ask', async () => {
    vi.spyOn(env, 'AI_ENABLED', 'get').mockReturnValue(true);
    vi.spyOn(env, 'FOLLOWUP_CONSENT_ASK_ENABLED', 'get').mockReturnValue(true);
    vi.spyOn(env, 'FOLLOWUP_DEV_CONSENT_SECONDS', 'get').mockReturnValue(1);
    seedEligibleLead(PHONE, { hoursAgo: 0.05 });
    repos.followupConsent.revokeConsent(PHONE);

    const result: LlmResult = {
      turn: {
        reply: '¿Te parece si te escribo más adelante?\n[[FOLLOWUP_CONSENT]]',
        sales_phase: 'discovery', action: 'answer', img: false,
        collected_fields: { name: null, plan: null, people: null, date: null, transport_need: null, pet: null },
        lead: { intent: 'curious', buying_signals: [], blockers: [], score_delta: 0, confidence: 1 },
      },
      tokens: { prompt: 10, completion: 10 },
    };
    const completeSpy = vi.spyOn(llmClient, 'complete').mockImplementation(async () => {
      repos.message.addMessage({
        customer_phone: PHONE, direction: 'inbound', message_type: 'text',
        body: 'ya regrese', created_at: new Date().toISOString(),
      });
      return result;
    });

    await runConsentAskCycle(repos);

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(mockSendTextWithId).not.toHaveBeenCalled();
    expect(repos.followupSubscription.getByPhone(PHONE)).toBeNull();
  });
});

describe('followup scheduler — consent ask envelope', () => {
  const ASK = '¿Te parece si te escribo más adelante?';
  const IMAGE_URL = 'https://cdn.andeanscapes.com/whatsapp_bot/media/mine1.jpg';

  function draft(): LlmResult {
    return {
      turn: {
        reply: `${ASK}\n[[FOLLOWUP_CONSENT]]`,
        sales_phase: 'discovery', action: 'answer', img: false,
        collected_fields: { name: null, plan: null, people: null, date: null, transport_need: null, pet: null },
        lead: { intent: 'curious', buying_signals: [], blockers: [], score_delta: 0, confidence: 1 },
      },
      tokens: { prompt: 10, completion: 10 },
    };
  }

  beforeEach(() => {
    vi.spyOn(env, 'AI_ENABLED', 'get').mockReturnValue(true);
    vi.spyOn(env, 'FOLLOWUP_CONSENT_ASK_ENABLED', 'get').mockReturnValue(true);
    vi.spyOn(env, 'FOLLOWUP_DEV_CONSENT_SECONDS', 'get').mockReturnValue(1);
    seedEligibleLead(PHONE, { hoursAgo: 0.05 });
    repos.followupConsent.revokeConsent(PHONE);
    vi.spyOn(llmClient, 'complete').mockResolvedValue(draft());
  });

  it('delivers the ask as the caption of the configured themed photo', async () => {
    vi.spyOn(env, 'FOLLOWUP_CONSENT_ASK_IMAGE_TYPE', 'get').mockReturnValue('mine');
    mockSelectThemedImage.mockReturnValue({ url: IMAGE_URL, caption: '', type: 'mine', experienceId: 'e', siteId: 's' });

    await runConsentAskCycle(repos);

    expect(mockSendImageUrlWithId).toHaveBeenCalledWith(PHONE, IMAGE_URL, ASK);
    expect(mockSendTextWithId).not.toHaveBeenCalled();
  });

  // The ask must read identically in LLM history however it was delivered, and the
  // reply has to stay attributable to the image message id.
  it('records the image-delivered ask as outbound text with the image message id', async () => {
    vi.spyOn(env, 'FOLLOWUP_CONSENT_ASK_IMAGE_TYPE', 'get').mockReturnValue('mine');
    mockSelectThemedImage.mockReturnValue({ url: IMAGE_URL, caption: '', type: 'mine', experienceId: 'e', siteId: 's' });

    await runConsentAskCycle(repos);

    const history = repos.message.getRecentMessages(PHONE, 10);
    expect(history.some(m => m.role === 'assistant' && m.content === ASK)).toBe(true);
    expect(repos.followupSubscription.getByPhone(PHONE)?.ask_outbound_message_id).toBe('wamid.IMAGE');
  });

  it('falls back to plain text when no themed photo resolves', async () => {
    vi.spyOn(env, 'FOLLOWUP_CONSENT_ASK_IMAGE_TYPE', 'get').mockReturnValue('mine');
    mockSelectThemedImage.mockReturnValue(null);

    await runConsentAskCycle(repos);

    expect(mockSendTextWithId).toHaveBeenCalledWith(PHONE, ASK);
    expect(mockSendImageUrlWithId).not.toHaveBeenCalled();
  });

  it('sends plain text when no theme is configured', async () => {
    vi.spyOn(env, 'FOLLOWUP_CONSENT_ASK_IMAGE_TYPE', 'get').mockReturnValue('');

    await runConsentAskCycle(repos);

    expect(mockSelectThemedImage).toHaveBeenCalledWith(
      expect.anything(),
      repos,
      PHONE,
      '',
      expect.any(String),
      undefined,
    );
    expect(mockSendTextWithId).toHaveBeenCalledWith(PHONE, ASK);
    expect(mockSendImageUrlWithId).not.toHaveBeenCalled();
  });

  it('degrades to text when the themed url is not public https', async () => {
    vi.spyOn(env, 'FOLLOWUP_CONSENT_ASK_IMAGE_TYPE', 'get').mockReturnValue('mine');
    mockSelectThemedImage.mockReturnValue({
      url: 'http://localhost/private.jpg', caption: '', type: 'mine', experienceId: 'e', siteId: 's',
    });

    await runConsentAskCycle(repos);

    expect(mockSendTextWithId).toHaveBeenCalledWith(PHONE, ASK);
    expect(mockSendImageUrlWithId).not.toHaveBeenCalled();
  });
});

describe('followup scheduler — template header image', () => {
  const MINE_URL = 'https://cdn.andeanscapes.com/whatsapp_bot/media/mine7.jpg';

  beforeEach(() => {
    seedEligibleLead();
    vi.spyOn(env, 'FOLLOWUP_TEMPLATE_HEADER', 'get').mockReturnValue('image');
  });

  it('prefers a themed gallery photo over the plan brochure card', async () => {
    vi.spyOn(env, 'FOLLOWUP_TEMPLATE_IMAGE_TYPE', 'get').mockReturnValue('mine');
    mockSelectThemedImage.mockReturnValue({ url: MINE_URL, caption: '', type: 'mine', experienceId: 'e', siteId: 's' });

    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    // sendTemplate(phone, name, lang, bodyParams, headerImageUrl)
    expect(mockSendTemplate.mock.calls[0][4]).toBe(MINE_URL);
  });

  it('skips instead of falling back to another experience when selection is stale', async () => {
    repos.conversation.setSelectedExperienceId(PHONE, 'removed_experience');

    await runFollowupCycle(repos);

    expect(mockSelectThemedImage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  // Without this the next template picks from the same eligible pool and can show
  // the customer the identical photo again.
  it('records the themed header so the next template rotates', async () => {
    vi.spyOn(env, 'FOLLOWUP_TEMPLATE_IMAGE_TYPE', 'get').mockReturnValue('mine');
    mockSelectThemedImage.mockReturnValue({ url: MINE_URL, caption: '', type: 'mine', experienceId: 'e', siteId: 's' });

    await runFollowupCycle(repos);

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    expect(repos.mediaSend.countRecentImagesWithPrefix(PHONE, cutoff, 'followup_gallery_')).toBe(1);
    // Must NOT land in the `gallery_` namespace: that one meters the in-conversation
    // contextual-photo cadence and 72h ceiling.
    expect(repos.mediaSend.countRecentImagesWithPrefix(PHONE, cutoff, 'gallery_')).toBe(0);
  });

  it('falls back to the plan card when the theme yields nothing', async () => {
    vi.spyOn(env, 'FOLLOWUP_TEMPLATE_IMAGE_TYPE', 'get').mockReturnValue('mine');
    mockSelectThemedImage.mockReturnValue(null);

    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][4]).not.toBe(MINE_URL);
    // A plan/owner image still resolved, so no gallery send was recorded.
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    expect(repos.mediaSend.countRecentImagesWithPrefix(PHONE, cutoff, 'followup_gallery_')).toBe(0);
  });

  // An unsendable themed URL must degrade to the plan card. Aborting would lose a
  // send the plan card could have carried.
  it('falls back to the plan card when the themed url is not public https', async () => {
    vi.spyOn(env, 'FOLLOWUP_TEMPLATE_IMAGE_TYPE', 'get').mockReturnValue('mine');
    mockSelectThemedImage.mockReturnValue({
      url: 'http://localhost/private.jpg', caption: '', type: 'mine', experienceId: 'e', siteId: 's',
    });

    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][4]).toMatch(/^https:\/\//);
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    expect(repos.mediaSend.countRecentImagesWithPrefix(PHONE, cutoff, 'followup_gallery_')).toBe(0);
  });
});

describe('followup scheduler — recurring batch selection', () => {
  it('does not let a non-due high-cycle row starve a due r1 at the batch limit', async () => {
    const duePhone = PHONE;
    const blockedPhone = '573001112244';
    seedEligibleLead(duePhone, { hoursAgo: 24 * 70 });
    repos.followupSubscription.ensureExists(duePhone);
    repos.followupSubscription.markAsked(duePhone, 'wamid.ask');
    repos.followupSubscription.affirm(duePhone, 'wamid.yes', 'customer_reply');

    vi.spyOn(env, 'FOLLOWUP_RECURRING_ENABLED', 'get').mockReturnValue(true);
    vi.spyOn(env, 'FOLLOWUP_DEV_RECURRING_SECONDS', 'get').mockReturnValue(0);
    vi.spyOn(env, 'FOLLOWUP_RECURRING_INTERVAL_MONTHS', 'get').mockReturnValue(1);
    vi.spyOn(env, 'FOLLOWUP_RECURRING_TEMPLATE_NAME', 'get').mockReturnValue('tour_followup_nodate_v1');
    vi.spyOn(env, 'FOLLOWUP_RECURRING_TEMPLATE_HEADER', 'get').mockReturnValue('none');
    vi.spyOn(env, 'FOLLOWUP_MAX_SENDS_PER_TICK', 'get').mockReturnValue(1);
    vi.spyOn(repos.conversation, 'listRecurringCandidates').mockReturnValue([
      {
        customer_phone: blockedPhone, language: 'es', collected_plan: 'plan_2d1n',
        selected_experience_id: null, sends_so_far: 1, consent_cycle: 1,
        // r2 needs three months; two months is broad-eligible but not exactly due.
        last_send_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        customer_phone: duePhone, language: 'es', collected_plan: 'plan_2d1n',
        selected_experience_id: null, sends_so_far: 0, consent_cycle: 1,
        last_send_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    await runRecurringCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][0]).toBe(duePhone);
  });

  it('re-checks the last message direction after claiming', async () => {
    seedEligibleLead(PHONE, { hoursAgo: 24 * 70 });
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');

    vi.spyOn(env, 'FOLLOWUP_RECURRING_ENABLED', 'get').mockReturnValue(true);
    vi.spyOn(env, 'FOLLOWUP_DEV_RECURRING_SECONDS', 'get').mockReturnValue(0);
    vi.spyOn(env, 'FOLLOWUP_RECURRING_INTERVAL_MONTHS', 'get').mockReturnValue(1);
    vi.spyOn(env, 'FOLLOWUP_RECURRING_TEMPLATE_NAME', 'get').mockReturnValue('tour_followup_nodate_v1');
    vi.spyOn(env, 'FOLLOWUP_RECURRING_TEMPLATE_HEADER', 'get').mockReturnValue('none');

    vi.spyOn(repos.conversation, 'listRecurringCandidates').mockImplementation(() => {
      // Race: this arrives after the scan snapshot but before the post-claim guard.
      repos.message.addMessage({
        customer_phone: PHONE,
        direction: 'inbound',
        message_type: 'text',
        body: 'una duda',
        created_at: new Date().toISOString(),
      });
      return [{
        customer_phone: PHONE,
        language: 'es',
        collected_plan: 'plan_2d1n',
        selected_experience_id: null,
        sends_so_far: 0,
        consent_cycle: 1,
        last_send_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      }];
    });

    await runRecurringCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });
});

describe('followup scheduler — dev timing and allowlist', () => {
  it('fires after FOLLOWUP_DEV_MINUTES instead of the 24h threshold', async () => {
    vi.spyOn(env, 'FOLLOWUP_DEV_MINUTES', 'get').mockReturnValue(2);
    seedEligibleLead(PHONE, { hoursAgo: 0.2 }); // 12 min of silence

    await runFollowupCycle(repos);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('restricts sends to allowlisted phones in dev', async () => {
    vi.spyOn(env, 'FOLLOWUP_DEV_ALLOWLIST_PHONES', 'get').mockReturnValue('573009998888');
    seedEligibleLead();

    await runFollowupCycle(repos);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });
});

describe('followup scheduler — template assets', () => {
  it('includes the header image when the template requires one', async () => {
    vi.spyOn(env, 'FOLLOWUP_TEMPLATE_HEADER', 'get').mockReturnValue('image');
    const registry = await import('../services/product-registry.js');
    vi.spyOn(registry, 'getOwnerImage').mockReturnValue({
      url: 'https://cdn.example.com/owner.jpg',
      caption: 'owner',
    });
    vi.spyOn(registry, 'getDynamicPlanImages').mockReturnValue([]);
    seedEligibleLead();

    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][4]).toBe('https://cdn.example.com/owner.jpg');
  });

  it('skips required-image templates when no public HTTPS image resolves', async () => {
    vi.spyOn(env, 'FOLLOWUP_TEMPLATE_HEADER', 'get').mockReturnValue('image');
    const registry = await import('../services/product-registry.js');
    vi.spyOn(registry, 'getOwnerImage').mockReturnValue(null);
    vi.spyOn(registry, 'getDynamicPlanImages').mockReturnValue([]);
    seedEligibleLead();

    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(repos.followupEvent.getLatest(PHONE)).toBeNull();
  });

  it('skips English leads until an EN template name is configured', async () => {
    seedEligibleLead(PHONE, { language: 'en' });
    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(repos.followupEvent.getLatest(PHONE)).toBeNull();
  });

  it('uses the EN template name for English leads when configured', async () => {
    vi.spyOn(env, 'FOLLOWUP_TEMPLATE_NAME_EN', 'get').mockReturnValue('tour_followup_nodate_en_v1');
    seedEligibleLead(PHONE, { language: 'en' });

    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][1]).toBe('tour_followup_nodate_en_v1');
    expect(mockSendTemplate.mock.calls[0][2]).toBe('en');
  });
});

describe('followup scheduler — failure handling', () => {
  it('stops retrying after FOLLOWUP_MAX_ATTEMPTS', async () => {
    vi.spyOn(env, 'FOLLOWUP_MAX_ATTEMPTS', 'get').mockReturnValue(2);
    mockSendTemplate.mockRejectedValue(new WhatsAppSendError('HTTP 400 (meta 132000)', false, false, '132000'));
    seedEligibleLead();

    await runFollowupCycle(repos);
    await runFollowupCycle(repos);
    await runFollowupCycle(repos);
    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(2);
    expect(repos.followupEvent.getLatest(PHONE)?.status).toBe('failed');
    expect(repos.followupEvent.getLatest(PHONE)?.attempts).toBe(2);
  });

  it('records the failure reason and never marks a failed send as sent', async () => {
    mockSendTemplate.mockRejectedValue(new WhatsAppSendError('HTTP 500', false, true));
    seedEligibleLead();

    await runFollowupCycle(repos);

    const event = repos.followupEvent.getLatest(PHONE);
    expect(event?.status).toBe('failed');
    expect(event?.error_reason).toContain('HTTP 500');
    expect(event?.whatsapp_message_id).toBeNull();
  });

  it('marks deliveryUncertain as terminal and never retries', async () => {
    mockSendTemplate.mockRejectedValue(new WhatsAppSendError('transport timeout', true));
    seedEligibleLead();

    await runFollowupCycle(repos);
    await runFollowupCycle(repos);
    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(repos.followupEvent.getLatest(PHONE)?.status).toBe('uncertain');
  });

  it('persists the delivered template as an outbound audit row', async () => {
    seedEligibleLead();
    await runFollowupCycle(repos);

    // `getRecentMessages` deliberately excludes templates from LLM history, so the
    // audit row is asserted directly.
    const row = db.prepare(
      "SELECT direction, message_type, whatsapp_message_id FROM messages WHERE customer_phone = ? AND message_type = 'template'"
    ).get(PHONE) as { direction: string; message_type: string; whatsapp_message_id: string } | undefined;
    expect(row).toMatchObject({ direction: 'outbound', message_type: 'template', whatsapp_message_id: 'wamid.OK' });
  });
});

describe('followup consent repository', () => {
  it('grants and revokes consent', () => {
    expect(repos.followupConsent.hasConsent(PHONE)).toBe(false);
    repos.followupConsent.grantConsent(PHONE, 'telegram:1');
    expect(repos.followupConsent.hasConsent(PHONE)).toBe(true);
    repos.followupConsent.revokeConsent(PHONE);
    expect(repos.followupConsent.hasConsent(PHONE)).toBe(false);
  });

  it('re-granting after revocation clears the revocation', () => {
    repos.followupConsent.grantConsent(PHONE, 'telegram:1');
    repos.followupConsent.revokeConsent(PHONE);
    repos.followupConsent.grantConsent(PHONE, 'telegram:2');
    expect(repos.followupConsent.hasConsent(PHONE)).toBe(true);
  });
});

// The one-shot template used to INNER JOIN `followup_consent`, which only
// `/followupgrant` writes. A customer "sí" unlocked the recurring cadence but never
// the 7-day template, and with no operator grant in production the path was
// unreachable for its entire life. Permission is now one predicate over two
// provenances.
describe('followup one-shot permission bridge', () => {
  /** Same shape as seedEligibleLead but with NO operator grant. */
  function seedWithoutOperatorGrant(phone = PHONE, hoursAgo = 48): void {
    const inboundAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    const outboundAt = new Date(Date.now() - (hoursAgo - 0.5) * 60 * 60 * 1000).toISOString();
    repos.conversation.upsert(phone, { language: 'es', collected_plan: 'plan_2d1n', collected_people: 2 });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'hola', created_at: inboundAt });
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'respuesta', created_at: outboundAt });
  }

  it('sends the one-shot on a customer affirmation alone, with no operator grant', async () => {
    seedWithoutOperatorGrant();
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');
    expect(repos.followupConsent.hasConsent(PHONE)).toBe(false);

    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('still sends on an operator grant with no customer subscription', async () => {
    seedWithoutOperatorGrant();
    repos.followupConsent.grantConsent(PHONE, 'telegram:1');

    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when neither provenance granted permission', async () => {
    seedWithoutOperatorGrant();
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');

    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it.each(['declined', 'revoked'] as const)('sends nothing for a %s subscription', async status => {
    seedWithoutOperatorGrant();
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    if (status === 'declined') repos.followupSubscription.decline(PHONE, 'wamid.no');
    else repos.followupSubscription.revoke(PHONE, 'operator');

    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  // An operator revocation must beat a stale active subscription, and vice versa:
  // both provenances are checked, so neither may resurrect a revoked lead.
  it('sends nothing once an opted-out customer has both provenances revoked', async () => {
    seedWithoutOperatorGrant();
    repos.followupConsent.grantConsent(PHONE, 'telegram:1');
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');

    repos.followupConsent.revokeConsent(PHONE);
    repos.followupSubscription.revoke(PHONE, 'customer_opt_out');

    await runFollowupCycle(repos);

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });
});

// The live subscription row is mutable, so it cannot answer "when was permission
// granted, and by whom?". This ledger is append-only and must survive every mutation.
describe('followup consent grant ledger', () => {
  it('records an affirmation and survives later subscription mutations', () => {
    repos.followupSubscription.ensureExists(PHONE);
    repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
    repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');
    repos.followupConsentGrant.record({
      customer_phone: PHONE,
      decision: 'affirm',
      decided_at: new Date().toISOString(),
      inbound_message_id: 'wamid.yes',
      source: 'customer_reply',
    });

    // Whatever happens to the live row, the history stands.
    repos.followupSubscription.revoke(PHONE, 'operator');

    const history = repos.followupConsentGrant.listByPhone(PHONE);
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('affirm');
    expect(history[0].source).toBe('customer_reply');
    expect(history[0].inbound_message_id).toBe('wamid.yes');
    expect(repos.followupSubscription.getByPhone(PHONE)?.status).toBe('revoked');
  });

  it('keeps every decision in order, newest first', () => {
    repos.followupConsentGrant.record({ customer_phone: PHONE, decision: 'affirm', decided_at: '2026-09-01T10:00:00.000Z', source: 'customer_reply' });
    repos.followupConsentGrant.record({ customer_phone: PHONE, decision: 'revoke', decided_at: '2026-09-02T10:00:00.000Z', source: 'operator_revoke' });
    repos.followupConsentGrant.record({ customer_phone: PHONE, decision: 'grant', decided_at: '2026-09-03T10:00:00.000Z', source: 'operator_grant' });

    const history = repos.followupConsentGrant.listByPhone(PHONE);
    expect(history.map(row => row.decision)).toEqual(['grant', 'revoke', 'affirm']);
    expect(repos.followupConsentGrant.latestDecision(PHONE)?.source).toBe('operator_grant');
  });

  it('scopes reads by phone and counts a date range', () => {
    repos.followupConsentGrant.record({ customer_phone: PHONE, decision: 'affirm', decided_at: '2026-09-01T10:00:00.000Z', source: 'customer_reply' });
    repos.followupConsentGrant.record({ customer_phone: '573009990999', decision: 'decline', decided_at: '2026-09-01T11:00:00.000Z', source: 'customer_reply' });

    expect(repos.followupConsentGrant.listByPhone(PHONE)).toHaveLength(1);
    expect(repos.followupConsentGrant.countBetween('2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z')).toBe(2);
    expect(repos.followupConsentGrant.countBetween('2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z')).toBe(0);
  });

  it('has no history for a lead who decided before the ledger existed', () => {
    expect(repos.followupConsentGrant.listByPhone(PHONE)).toEqual([]);
    expect(repos.followupConsentGrant.latestDecision(PHONE)).toBeNull();
  });
});

describe('followup event claim', () => {
  it('refuses a second claim for the same anchor while pending and fresh', () => {
    const first = repos.followupEvent.claim(PHONE, '2026-08-12T10:00:00Z', 3, 10);
    const second = repos.followupEvent.claim(PHONE, '2026-08-12T10:00:00Z', 3, 10);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('reclaims a stale pending claim after a crash', () => {
    const claimId = repos.followupEvent.claim(PHONE, '2026-08-12T10:00:00Z', 3, 10);
    expect(claimId).not.toBeNull();
    // Simulate a crash: pending row left with an old claimed_at.
    db.prepare("UPDATE followup_events SET claimed_at = datetime('now', '-15 minutes') WHERE id = ?").run(claimId);

    const reclaimed = repos.followupEvent.claim(PHONE, '2026-08-12T10:00:00Z', 3, 10);
    expect(reclaimed).toBe(claimId);
    expect(repos.followupEvent.getLatest(PHONE)?.attempts).toBe(2);
  });

  it('refuses any further claim once a template was delivered', () => {
    const claimId = repos.followupEvent.claim(PHONE, '2026-08-12T10:00:00Z', 3, 10);
    repos.followupEvent.markSent(claimId!, 'wamid.1');
    expect(repos.followupEvent.claim(PHONE, '2026-08-13T10:00:00Z', 3, 10)).toBeNull();
  });

  it('refuses any further claim once delivery is uncertain', () => {
    const claimId = repos.followupEvent.claim(PHONE, '2026-08-12T10:00:00Z', 3, 10);
    repos.followupEvent.markUncertain(claimId!, 'transport timeout');
    expect(repos.followupEvent.claim(PHONE, '2026-08-13T10:00:00Z', 3, 10)).toBeNull();
  });
});
