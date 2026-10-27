import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../app.js';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';
import { galleryMediaId, REQUESTED_GALLERY_MEDIA_ID_PREFIX } from '../services/media-service.js';
import { MAX_IMAGE_CAPTION_CHARS } from '../services/whatsapp-client.js';
import * as budgetGuard from '../services/budget-guard.js';
import * as leadAnalyzer from '../services/lead-analyzer.js';
import * as completion from '../services/llm/deepseek-completion.js';
import * as skillLoader from '../services/skill-loader.js';
import { getActiveExperience, getDynamicPlanImages } from '../services/product-registry.js';
import { calculatePriceQuote, formatCop } from '../services/pricing-calculator.js';
import { useAllSitesActive } from './helpers/all-sites-catalog.js';

// The multi-site regression net runs with every destination active, as the CI
// fixture had before destinations could be paused.
beforeEach(() => {
  useAllSitesActive();
});

const IMAGE_URL = 'https://cdn.andeanscapes.com/whatsapp_bot/media/mine1.jpg';
const REPLY = '¡Perfecto! ¿Qué buscan: la mina como protagonista, o algo más rural?';

const { paceMock, sendTextMock, sendImageUrlMock, processMessageMock } = vi.hoisted(() => ({
  paceMock: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  sendTextMock: vi.fn<(to: string, text: string) => Promise<void>>(() => Promise.resolve()),
  // Mirrors the real signature: sendImageUrl returns the Meta message id. A
  // Promise<void> stub would hide a caller that reads .whatsappMessageId.
  sendImageUrlMock: vi.fn<(to: string, imageUrl: string, caption: string) => Promise<{ whatsappMessageId: string | null }>>(() => Promise.resolve({ whatsappMessageId: 'wamid.IMG' })),
  processMessageMock: vi.fn(),
}));

vi.mock('../services/human-delay.js', () => ({
  createTurnPacer: vi.fn(() => ({ pace: paceMock })),
}));

vi.mock('../services/whatsapp-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/whatsapp-client.js')>();
  return {
    ...actual,
    sendText: sendTextMock,
    sendImageUrl: sendImageUrlMock,
    downloadMedia: vi.fn(),
  };
});

// Imported after the mock factory so the real error class is used for instanceof.
const { WhatsAppSendError } = await import('../services/whatsapp-client.js');

vi.mock('../services/response-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/response-engine.js')>();
  return { ...actual, processMessage: processMessageMock };
});

function baseResult(overrides: Record<string, unknown>) {
  return {
    reply: REPLY,
    shouldSendReply: true,
    usedAi: true,
    leadScore: 10,
    shouldAlertOwner: false,
    shouldSendImage: false,
    shouldSendOwnerImage: false,
    shouldSendGalleryImages: false,
    priceJustGiven: false,
    outboundDateAction: null,
    ownerAlertType: null,
    ...overrides,
  };
}

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

describe('contextual image delivery', () => {
  let db: Database.Database;
  let repos: Repositories;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let previousOwnerOnly: boolean;
  let previousSendImages: boolean;
  let previousProbability: number;

  beforeEach(async () => {
    loadSkills();
    previousOwnerOnly = env.WEBHOOK_OWNER_ONLY_ENABLED;
    previousSendImages = env.SEND_IMAGES_ENABLED;
    previousProbability = env.CONTEXTUAL_IMAGES_PROBABILITY;
    env.WEBHOOK_OWNER_ONLY_ENABLED = false;
    env.SEND_IMAGES_ENABLED = true;
    paceMock.mockReset();
    paceMock.mockResolvedValue(true);
    sendTextMock.mockClear();
    sendImageUrlMock.mockClear();
    sendImageUrlMock.mockImplementation(() => Promise.resolve({ whatsappMessageId: 'wamid.IMG' }));
    processMessageMock.mockReset();
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    app = await buildApp(repos);
    await app.ready();
  });

  afterEach(async () => {
    env.WEBHOOK_OWNER_ONLY_ENABLED = previousOwnerOnly;
    env.SEND_IMAGES_ENABLED = previousSendImages;
    env.CONTEXTUAL_IMAGES_PROBABILITY = previousProbability;
    await app.close();
    db.close();
  });

  async function inbound(phone: string, id: string, text = 'Pareja'): Promise<void> {
    const body = inboundPayload(phone, text, id);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  }

  it('sends the reply as the image caption in a single message', async () => {
    const phone = '573001110001';
    processMessageMock.mockResolvedValue(baseResult({ contextualImage: { url: IMAGE_URL } }));

    await inbound(phone, 'wamid-ctx-1');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalled());
    expect(sendImageUrlMock).toHaveBeenCalledWith(phone, IMAGE_URL, REPLY);
    // The whole point: no separate text message can overtake the photo.
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('still records the reply as outbound text so LLM history is unchanged', async () => {
    const phone = '573001110002';
    processMessageMock.mockResolvedValue(baseResult({ contextualImage: { url: IMAGE_URL } }));

    await inbound(phone, 'wamid-ctx-2');

    await vi.waitFor(() => {
      const history = repos.message.getRecentMessages(phone, 10);
      expect(history.some(m => m.role === 'assistant' && m.content === REPLY)).toBe(true);
    });
  });

  it('falls back to plain text when the reply is too long to caption', async () => {
    const phone = '573001110003';
    const longReply = 'a'.repeat(MAX_IMAGE_CAPTION_CHARS + 1);
    processMessageMock.mockResolvedValue(baseResult({ reply: longReply, contextualImage: { url: IMAGE_URL } }));

    await inbound(phone, 'wamid-ctx-3');

    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, longReply));
    expect(sendImageUrlMock).not.toHaveBeenCalled();
  });

  it('falls back to plain text when the image send fails, so the reply is never lost', async () => {
    const phone = '573001110004';
    sendImageUrlMock.mockRejectedValueOnce(new Error('media fetch failed'));
    processMessageMock.mockResolvedValue(baseResult({ contextualImage: { url: IMAGE_URL } }));

    await inbound(phone, 'wamid-ctx-4');

    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, REPLY));
  });

  // Meta may already hold an uncertain send, so re-sending the same copy as text
  // would show the customer the reply twice.
  it('does not re-send the reply as text when delivery is uncertain', async () => {
    const phone = '573001110006';
    sendImageUrlMock.mockRejectedValueOnce(new WhatsAppSendError('202 without id', true));
    processMessageMock.mockResolvedValue(baseResult({ contextualImage: { url: IMAGE_URL } }));

    await inbound(phone, 'wamid-ctx-6');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalled());
    await vi.waitFor(() => {
      const history = repos.message.getRecentMessages(phone, 10);
      expect(history.some(m => m.role === 'assistant' && m.content === REPLY)).toBe(true);
    });
    expect(sendTextMock).not.toHaveBeenCalled();
    // The claim is retained so the same photo is not re-sent within 72h.
    expect(repos.mediaSend.countRecentImages(phone, new Date(Date.now() - 60_000).toISOString())).toBe(1);
  });

  // The plan card used to arrive as a second message captioned with the feed's
  // generic "Imagen de referencia del plan …", pushing the reply above it.
  it('puts the reply on the plan card on a price turn, as a single message', async () => {
    const phone = '573001110007';
    repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_chivor' });
    processMessageMock.mockResolvedValue(baseResult({ priceJustGiven: true }));

    await inbound(phone, 'wamid-ctx-7');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalled());
    const [, url, caption] = sendImageUrlMock.mock.calls[0] ?? [];
    expect(caption).toBe(REPLY);
    expect(url).toMatch(/^https:\/\//);
    // One image and no separate text: the old flow sent text + captioned card.
    expect(sendImageUrlMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('sends the quoted plan card with the unchanged reply while keeping the stored plan', async () => {
    const phone = '573001110017';
    const reply = 'La PRIME para ustedes dos queda en $1.840.000. ¿Con cuál se quedan?';
    repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_chivor' });
    processMessageMock.mockResolvedValue(baseResult({
      reply, priceJustGiven: true, quotedPlanId: 'prime_2d1n_chivor',
    }));

    await inbound(phone, 'wamid-quoted-plan-card');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledWith(
      phone, 'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/chivor/plans/prime/card.png?v=61b11c8f405b', reply,
    ));
    expect(sendImageUrlMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(repos.conversation.getCollectedPlan(phone)).toBe('core_2d1n_chivor');
  });

  it('sends no stored-plan card for a price objection without a uniquely quoted alternative', async () => {
    const phone = '573001110027';
    repos.conversation.upsert(phone, { collected_plan: 'prime_2d1n_coscuez' });
    processMessageMock.mockResolvedValue(baseResult({
      reply: 'Podemos comparar el alcance de la opción esencial. ¿Te interesa?',
      priceJustGiven: true,
      priceObjectionThisTurn: true,
    }));

    await inbound(phone, 'wamid-price-objection-no-card');

    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, expect.any(String)));
    expect(sendImageUrlMock).not.toHaveBeenCalled();
  });

  it('still sends the switched plan card when a price objection also switches plan', async () => {
    const phone = '573001110029';
    repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_coscuez' });
    processMessageMock.mockResolvedValue(baseResult({
      reply: 'Listo, quedamos con la esencial. ¿Qué fecha les sirve?',
      priceObjectionThisTurn: true,
      planSwitchedAfterQuote: true,
    }));

    await inbound(phone, 'wamid-price-objection-switch');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledWith(
      phone,
      'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/coscuez/plans/core/card.png',
      expect.any(String),
    ));
  });

  it('sends only the uniquely quoted alternative card on a price objection', async () => {
    const phone = '573001110028';
    repos.conversation.upsert(phone, { collected_plan: 'prime_2d1n_coscuez' });
    processMessageMock.mockResolvedValue(baseResult({
      reply: 'La opción esencial queda en el total indicado. ¿La comparamos?',
      priceJustGiven: true,
      priceObjectionThisTurn: true,
      quotedPlanId: 'core_2d1n_coscuez',
    }));

    await inbound(phone, 'wamid-price-objection-alternative-card');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledWith(
      phone,
      'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/coscuez/plans/core/card.png',
      expect.any(String),
    ));
    expect(sendImageUrlMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(repos.conversation.getCollectedPlan(phone)).toBe('prime_2d1n_coscuez');
  });

  // The plan card on a price turn is mandatory: it must never fall behind the
  // contextual-image dice roll. Only the themed gallery photo is probabilistic.
  // A plan without its own card used to ship the first plan's card (a Chivor CORE card
  // under a Coscuez PRIME quote). Now the reply goes out as plain text instead.
  it('sends plain text on a price turn when the stored plan has no card of its own', async () => {
    const phone = '573001110018';
    repos.conversation.upsert(phone, { collected_plan: 'plan_without_card_fixture' });
    processMessageMock.mockResolvedValue(baseResult({ priceJustGiven: true }));

    await inbound(phone, 'wamid-no-card');

    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, REPLY));
    expect(sendImageUrlMock).not.toHaveBeenCalled();
  });

  it('still sends the plan card on a price turn when the contextual probability is zero', async () => {
    const phone = '573001110011';
    repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_chivor' });
    env.CONTEXTUAL_IMAGES_PROBABILITY = 0;
    processMessageMock.mockResolvedValue(baseResult({ priceJustGiven: true }));

    await inbound(phone, 'wamid-ctx-11');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(1));
    expect(sendImageUrlMock.mock.calls[0]?.[2]).toBe(REPLY);
  });

  it('falls back to text plus the captioned plan card when the reply is too long', async () => {
    const phone = '573001110008';
    repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_chivor' });
    const longReply = 'a'.repeat(MAX_IMAGE_CAPTION_CHARS + 1);
    processMessageMock.mockResolvedValue(baseResult({ reply: longReply, priceJustGiven: true }));

    await inbound(phone, 'wamid-ctx-8');

    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, longReply));
    // The plan card is not lost; it keeps its own feed caption.
    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(1));
    expect(sendImageUrlMock.mock.calls[0]?.[2]).not.toBe(longReply);
  });

  // The 72h claim is per media id, so a repeat quote finds the card already sent.
  it('sends plain text on a price turn when the plan card was already claimed', async () => {
    const phone = '573001110009';
    repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_chivor' });
    processMessageMock.mockResolvedValue(baseResult({ priceJustGiven: true }));

    await inbound(phone, 'wamid-ctx-9a');
    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(1));
    sendImageUrlMock.mockClear();
    sendTextMock.mockClear();

    await inbound(phone, 'wamid-ctx-9b');

    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, REPLY));
    expect(sendImageUrlMock).not.toHaveBeenCalled();
  });

  it('sends the card of the newly selected plan on a price turn after a plan switch', async () => {
    const phone = '573001110012';
    const coreCard = 'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/chivor/plans/core/card.png?v=d6a8dd2cee2b';
    const primeCard = 'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/chivor/plans/prime/card.png?v=61b11c8f405b';
    processMessageMock.mockImplementationOnce(async () => {
      repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_chivor' });
      return baseResult({ priceJustGiven: true });
    });

    await inbound(phone, 'wamid-ctx-12a');
    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(1));
    expect(sendImageUrlMock.mock.calls[0]?.[1]).toBe(coreCard);

    processMessageMock.mockImplementationOnce(async () => {
      repos.conversation.upsert(phone, { collected_plan: 'prime_2d1n_chivor' });
      return baseResult({ priceJustGiven: true });
    });

    await inbound(phone, 'wamid-ctx-12b');
    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(2));
    expect(sendImageUrlMock.mock.calls[1]?.[1]).toBe(primeCard);
    expect(sendImageUrlMock.mock.calls[1]?.[2]).toBe(REPLY);
  });

  it('sends the new plan card with the reply when the plan switches after a quote, even without a price', async () => {
    const phone = '573001110013';
    const primeCard = 'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/chivor/plans/prime/card.png?v=61b11c8f405b';
    processMessageMock.mockImplementationOnce(async () => {
      repos.conversation.upsert(phone, { collected_plan: 'prime_2d1n_chivor' });
      return baseResult({ planSwitchedAfterQuote: true });
    });

    await inbound(phone, 'wamid-ctx-13');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(1));
    expect(sendImageUrlMock).toHaveBeenCalledWith(phone, primeCard, REPLY);
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('does not resend on a price turn the card already shipped as a requested brochure', async () => {
    const phone = '573001110014';
    const coreCard = 'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/chivor/plans/core/card.png?v=d6a8dd2cee2b';
    repos.mediaSend.claimSend(phone, `${REQUESTED_GALLERY_MEDIA_ID_PREFIX}wamid-old_${galleryMediaId({ url: coreCard })}`, new Date(0).toISOString());
    processMessageMock.mockImplementationOnce(async () => {
      repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_chivor' });
      return baseResult({ priceJustGiven: true });
    });

    await inbound(phone, 'wamid-ctx-14');

    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, REPLY));
    expect(sendImageUrlMock).not.toHaveBeenCalled();
  });

  it('sends plain text on a price turn when image sending is disabled', async () => {
    const phone = '573001110010';
    env.SEND_IMAGES_ENABLED = false;
    processMessageMock.mockResolvedValue(baseResult({ priceJustGiven: true }));

    await inbound(phone, 'wamid-ctx-10');

    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, REPLY));
    expect(sendImageUrlMock).not.toHaveBeenCalled();
  });

  // A first plan choice cues a proactive [[FOTOS:<theme>]] demonstration, but on a
  // price turn the plan card is the detailed image and must carry the reply instead
  // of being displaced by the unsolicited gallery.
  it('prefers the plan card over a proactive gallery on a price turn', async () => {
    const phone = '573001110020';
    const card = 'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/coscuez/plans/core/card.png';
    repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_coscuez' });
    processMessageMock.mockResolvedValue(baseResult({
      priceJustGiven: true,
      requestedGalleryImages: [IMAGE_URL],
      galleryRequestedByCustomer: false,
    }));

    await inbound(phone, 'wamid-card-vs-gallery-1');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledWith(phone, card, REPLY));
    expect(sendImageUrlMock).toHaveBeenCalledTimes(1);
    expect(sendImageUrlMock.mock.calls.some(call => call[1] === IMAGE_URL)).toBe(false);
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('keeps an explicit gallery request on a price turn instead of the card', async () => {
    const phone = '573001110021';
    const card = 'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/chivor/plans/core/card.png?v=d6a8dd2cee2b';
    repos.conversation.upsert(phone, { collected_plan: 'core_2d1n_chivor' });
    processMessageMock.mockResolvedValue(baseResult({
      priceJustGiven: true,
      requestedGalleryImages: [IMAGE_URL],
      galleryRequestedByCustomer: true,
    }));

    await inbound(phone, 'wamid-card-vs-gallery-2');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledWith(phone, IMAGE_URL, REPLY));
    expect(sendImageUrlMock.mock.calls.some(call => call[1] === card)).toBe(false);
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it.each(['missing', 'recently sent'])('keeps the proactive gallery when the card is %s', async (state) => {
    const phone = '573001110024';
    const planId = 'core_2d1n_coscuez';
    const card = getDynamicPlanImages(skillLoader.getSkills()).find(image => image.planId === planId)!;
    repos.conversation.upsert(phone, { collected_plan: state === 'missing' ? 'plan_without_card_fixture' : planId });
    if (state === 'recently sent') {
      repos.mediaSend.claimSend(phone, card.id, new Date(0).toISOString());
    }
    processMessageMock.mockResolvedValue(baseResult({
      priceJustGiven: true, requestedGalleryImages: [IMAGE_URL], galleryRequestedByCustomer: false,
    }));

    await inbound(phone, 'wamid-gallery-card-unavailable');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledExactlyOnceWith(phone, IMAGE_URL, REPLY));
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  describe('media delivery through the real engine', () => {
    beforeEach(async () => {
      const engine = await vi.importActual<typeof import('../services/response-engine.js')>('../services/response-engine.js');
      processMessageMock.mockImplementation(engine.processMessage);
      useAllSitesActive();
      loadSkills();
      vi.spyOn(skillLoader, 'refreshSkills').mockResolvedValue();
      vi.spyOn(budgetGuard, 'checkBudget').mockReturnValue({ aiAllowed: true });
      vi.spyOn(leadAnalyzer, 'analyzeLead').mockResolvedValue(null);
      env.CONTEXTUAL_IMAGES_PROBABILITY = 0;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('delivers the selected CORE card on the first quote and does not resend on date deferral', async () => {
      const phone = '573001110022';
      const planId = 'core_2d1n_coscuez';
      const skills = skillLoader.getSkills();
      const total = calculatePriceQuote(getActiveExperience(skills), { planId, people: 1 })!.planTotal;
      const card = getDynamicPlanImages(skills).find(image => image.planId === planId)!;
      const quote = `Perfecto, CORE en Coscuez. Para una persona queda en ${formatCop(total)}. ¿Tenés algún mes en mente?`;
      const choice = 'Coscuez tiene una opción esencial y otra más completa. ¿Cuál te llama más?';
      const deferral = 'Entendido. ¿Qué mes te vendría mejor?';
      const provider = vi.spyOn(completion, 'requestDeepSeekCompletion');
      for (const content of [choice, `${quote}\n[[FOTOS:mine]]`, deferral]) {
        provider.mockResolvedValueOnce({ content, finishReason: 'stop', promptTokens: 10, completionTokens: 10 });
      }
      repos.conversation.upsert(phone, { language: 'es', collected_people: 1 });
      repos.message.addMessage({
        customer_phone: phone, direction: 'inbound', message_type: 'text',
        body: 'Voy solo', created_at: new Date(Date.now() - 120_000).toISOString(),
      });
      repos.message.addMessage({
        customer_phone: phone, direction: 'outbound', message_type: 'text',
        body: '¿Cuál destino te llama más, Chivor o Coscuez?', created_at: new Date(Date.now() - 60_000).toISOString(),
      });

      await inbound(phone, 'wamid-coscuez-choice', 'el de coscuez que vale ?');
      await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, choice));
      await inbound(phone, 'wamid-coscuez-core-quote', 'si el basico');
      await vi.waitFor(() => expect(repos.outboundMedia.listByPhone(phone)).toHaveLength(1));

      expect(repos.conversation.getCollectedPlan(phone)).toBe(planId);
      await expect(processMessageMock.mock.results[1]?.value).resolves.toMatchObject({
        priceJustGiven: true, galleryRequestedByCustomer: false, mediaPlanId: planId,
      });
      expect(sendImageUrlMock).toHaveBeenCalledExactlyOnceWith(phone, card.url, quote);
      expect(repos.outboundMedia.listByPhone(phone)[0]).toMatchObject({
        media_url: card.url, caption: quote, carried_reply: 1, flow: 'price_image',
      });

      await inbound(phone, 'wamid-coscuez-deferred', 'no todavia');
      await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, deferral));
      expect(sendImageUrlMock).toHaveBeenCalledTimes(1);
      expect(provider).toHaveBeenCalledTimes(3);
    });

    it('keeps photos accepted from an offer when the same turn quotes the plan', async () => {
      const phone = '573001110023';
      const planId = 'core_2d1n_coscuez';
      const skills = skillLoader.getSkills();
      const total = calculatePriceQuote(getActiveExperience(skills), { planId, people: 1 })!.planTotal;
      const card = getDynamicPlanImages(skills).find(image => image.planId === planId)!;
      const reply = `El plan queda en ${formatCop(total)}. ¿Qué mes te sirve?`;
      vi.spyOn(completion, 'requestDeepSeekCompletion').mockResolvedValue({
        content: `${reply}\n[[FOTOS:mine]]`, finishReason: 'stop', promptTokens: 10, completionTokens: 10,
      });
      repos.conversation.upsert(phone, { language: 'es', collected_plan: planId, collected_people: 1 });
      repos.message.addMessage({
        customer_phone: phone, direction: 'outbound', message_type: 'text',
        body: '¿Te mando fotos de la mina?', created_at: new Date(Date.now() - 60_000).toISOString(),
      });

      await inbound(phone, 'wamid-coscuez-photo-offer', 'Si, ¿cuánto vale?');
      await vi.waitFor(() => expect(repos.message.getRecentMessages(phone, 10)).toContainEqual(
        expect.objectContaining({ role: 'assistant', content: reply }),
      ));

      expect(sendImageUrlMock).toHaveBeenCalled();
      await expect(processMessageMock.mock.results[0]?.value).resolves.toMatchObject({
        priceJustGiven: true, galleryRequestedByCustomer: true,
      });
      expect(sendImageUrlMock.mock.calls.every(call => call[1].includes('/coscuez/gallery/mine/'))).toBe(true);
      expect(sendImageUrlMock.mock.calls.some(call => call[1] === card.url)).toBe(false);
      expect(sendImageUrlMock.mock.calls.at(-1)?.[2]).toBe(reply);
      expect(sendTextMock).not.toHaveBeenCalled();
    });

    it('delivers same-site photos after correcting missing markers for a generic request and a complaint', async () => {
      const phone = '573001110025';
      const previousRetry = env.MEDIA_MARKER_RETRY_ENABLED;
      const previousCap = env.MAX_GALLERY_IMAGES_PER_SEND;
      env.MEDIA_MARKER_RETRY_ENABLED = true;
      env.MAX_GALLERY_IMAGES_PER_SEND = 1;
      try {
        repos.conversation.upsert(phone, { language: 'es', collected_plan: 'prime_2d1n_chivor', collected_people: 2 });
        repos.message.addMessage({
          customer_phone: phone, direction: 'inbound', message_type: 'text',
          body: 'Elegimos PRIME en Chivor', created_at: new Date(Date.now() - 120_000).toISOString(),
        });
        repos.message.addMessage({
          customer_phone: phone, direction: 'outbound', message_type: 'text',
          body: '¿Qué mes les vendría mejor?', created_at: new Date(Date.now() - 60_000).toISOString(),
        });
        const reply = '¿Qué mes les vendría mejor?';
        const provider = vi.spyOn(completion, 'requestDeepSeekCompletion');
        for (const content of [reply, `${reply}\n[[FOTOS:mine]]`, reply, `${reply}\n[[FOTOS:mine]]`]) {
          provider.mockResolvedValueOnce({ content, finishReason: 'stop', promptTokens: 10, completionTokens: 10 });
        }

        await inbound(phone, 'wamid-generic-experience', 'tienes fotos de la experiencia ?');
        await vi.waitFor(() => expect(repos.outboundMedia.listByPhone(phone)).toHaveLength(1));
        await inbound(phone, 'wamid-wrong-site-complaint', 'pero esas fotos son de coscuez');
        await vi.waitFor(() => expect(repos.outboundMedia.listByPhone(phone)).toHaveLength(2));

        expect(provider).toHaveBeenCalledTimes(4);
        expect(sendImageUrlMock).toHaveBeenCalledTimes(2);
        expect(sendImageUrlMock.mock.calls.every(call => call[1].includes('/chivor/gallery/mine/'))).toBe(true);
        expect(repos.outboundMedia.listByPhone(phone).every(row => row.theme_site_id === 'chivor' && row.carried_reply === 1)).toBe(true);
        expect(repos.conversation.getCollectedPlan(phone)).toBe('prime_2d1n_chivor');
        expect(sendTextMock).not.toHaveBeenCalled();
      } finally {
        env.MEDIA_MARKER_RETRY_ENABLED = previousRetry;
        env.MAX_GALLERY_IMAGES_PER_SEND = previousCap;
      }
    });
  });

  describe('requested gallery photos', () => {
    const SECOND_URL = 'https://cdn.andeanscapes.com/whatsapp_bot/media/hotel1.jpg';

    // The reply rides on the LAST photo instead of a trailing text message:
    // WhatsApp downloads every `image.link` before delivering, so a text sent
    // afterwards can overtake the images and put the question above them.
    it('sends leading photos captionless and captions the last one with the unchanged reply', async () => {
      const phone = '573001110012';
      processMessageMock.mockResolvedValue(baseResult({
        shouldSendGalleryImages: true,
        requestedGalleryImages: [IMAGE_URL, SECOND_URL],
      }));

      await inbound(phone, 'wamid-ctx-12');

      await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(2));
      expect(sendImageUrlMock.mock.calls.map(call => call.slice(1))).toEqual([
        [IMAGE_URL, ''],
        [SECOND_URL, REPLY],
      ]);
      expect(sendTextMock).not.toHaveBeenCalled();
    });

    it('finishes an already-started gallery burst when a newer inbound supersedes its pacing', async () => {
      const phone = '573001110016';
      paceMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      processMessageMock.mockResolvedValue(baseResult({
        shouldSendGalleryImages: true,
        requestedGalleryImages: [IMAGE_URL, SECOND_URL],
      }));

      await inbound(phone, 'wamid-ctx-16');

      await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(2));
      expect(sendImageUrlMock.mock.calls.map(call => call.slice(1))).toEqual([
        [IMAGE_URL, ''],
        [SECOND_URL, REPLY],
      ]);
      expect(sendTextMock).not.toHaveBeenCalled();
    });

    it('delivers a long text fallback after a started gallery is superseded', async () => {
      const phone = '573001110017';
      const longReply = 'x'.repeat(MAX_IMAGE_CAPTION_CHARS + 1);
      paceMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      processMessageMock.mockResolvedValue(baseResult({
        reply: longReply,
        shouldSendGalleryImages: true,
        requestedGalleryImages: [IMAGE_URL, SECOND_URL],
      }));

      await inbound(phone, 'wamid-ctx-17');

      await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, longReply));
      expect(sendImageUrlMock).toHaveBeenCalledTimes(2);
    });

    it('delivers text when the captioned photo fails after an earlier photo succeeded', async () => {
      const phone = '573001110018';
      sendImageUrlMock
        .mockResolvedValueOnce({ whatsappMessageId: 'wamid.LEADING' })
        .mockRejectedValueOnce(new Error('definitive failure'));
      processMessageMock.mockResolvedValue(baseResult({
        shouldSendGalleryImages: true,
        requestedGalleryImages: [IMAGE_URL, SECOND_URL],
      }));

      await inbound(phone, 'wamid-ctx-18');

      await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, REPLY));
      expect(sendImageUrlMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to a text reply when it is too long to caption the last photo', async () => {
      const phone = '573001110015';
      const longReply = 'x'.repeat(1100);
      processMessageMock.mockResolvedValue(baseResult({
        reply: longReply,
        shouldSendGalleryImages: true,
        requestedGalleryImages: [IMAGE_URL, SECOND_URL],
      }));

      await inbound(phone, 'wamid-ctx-15');

      await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, longReply));
      expect(sendImageUrlMock.mock.calls.map(call => call.slice(1))).toEqual([
        [IMAGE_URL, ''],
        [SECOND_URL, ''],
      ]);
    });

    it('records each photo in the gallery namespace and honors a repeated explicit request', async () => {
      const phone = '573001110013';
      processMessageMock.mockResolvedValue(baseResult({
        shouldSendGalleryImages: true,
        requestedGalleryImages: [IMAGE_URL],
      }));

      await inbound(phone, 'wamid-ctx-13a');
      await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(1));

      expect(repos.mediaSend.getLastSentAtForImage(
        phone,
        galleryMediaId({ url: IMAGE_URL }),
        REQUESTED_GALLERY_MEDIA_ID_PREFIX,
      )).not.toBeNull();

      sendImageUrlMock.mockClear();
      await inbound(phone, 'wamid-ctx-13b');
      await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledOnce());
      expect(sendImageUrlMock).toHaveBeenCalledWith(phone, IMAGE_URL, REPLY);
    });

    it('skips a malformed photo url instead of aborting the turn', async () => {
      const phone = '573001110014';
      processMessageMock.mockResolvedValue(baseResult({
        shouldSendGalleryImages: true,
        requestedGalleryImages: ['not-a-url', IMAGE_URL],
      }));

      await inbound(phone, 'wamid-ctx-14');

      await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(1));
      expect(sendImageUrlMock).toHaveBeenCalledWith(phone, IMAGE_URL, REPLY);
    });

    it('cancels requested photos but preserves text when bridge activates during generation', async () => {
      const phone = '573001110019';
      processMessageMock.mockImplementationOnce(async () => {
        repos.bridgeSession.open('agent-19', phone);
        repos.conversation.setMode(phone, 'bridge_active');
        return baseResult({
          shouldSendGalleryImages: true,
          requestedGalleryImages: [IMAGE_URL, SECOND_URL],
        });
      });

      await inbound(phone, 'wamid-ctx-19');

      await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, REPLY));
      expect(sendImageUrlMock).not.toHaveBeenCalled();
    });
  });

  it('sends plain text when there is no contextual image', async () => {
    const phone = '573001110005';
    processMessageMock.mockResolvedValue(baseResult({}));

    await inbound(phone, 'wamid-ctx-5');

    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, REPLY));
    expect(sendImageUrlMock).not.toHaveBeenCalled();
  });

  // The replay ledger is what makes `/lead` show real photos instead of the
  // "📷 imagen" placeholder. These assert the WIRING at the delivery sites: a
  // correct repository is useless if nothing calls it.
  describe('replay ledger', () => {
    it('records the contextual reply-carrying photo with its caption', async () => {
      const phone = '573001110101';
      processMessageMock.mockResolvedValue(baseResult({ contextualImage: { url: IMAGE_URL } }));

      await inbound(phone, 'wamid-ledger-1');

      await vi.waitFor(() => expect(repos.outboundMedia.listByPhone(phone)).toHaveLength(1));
      const [row] = repos.outboundMedia.listByPhone(phone);
      expect(row.media_url).toBe(IMAGE_URL);
      expect(row.flow).toBe('contextual_image');
      // carried_reply drives caption de-duplication in the replay.
      expect(row.carried_reply).toBe(1);
      expect(row.caption).toBe(REPLY);
      expect(row.turn_inbound_message_id).toBe('wamid-ledger-1');
    });

    it('records every requested gallery frame in order, flagging only the captioned one', async () => {
      const phone = '573001110102';
      const SECOND_URL = 'https://cdn.andeanscapes.com/whatsapp_bot/media/hotel1.jpg';
      processMessageMock.mockResolvedValue(baseResult({
        shouldSendGalleryImages: true,
        requestedGalleryImages: [IMAGE_URL, SECOND_URL],
      }));

      await inbound(phone, 'wamid-ledger-2');

      await vi.waitFor(() => expect(repos.outboundMedia.listByPhone(phone)).toHaveLength(2));
      // listByPhone is newest-first; compare chronologically.
      const rows = repos.outboundMedia.listByPhone(phone).slice().reverse();
      expect(rows.map(r => r.media_url)).toEqual([IMAGE_URL, SECOND_URL]);
      expect(rows.map(r => r.sequence)).toEqual([0, 1]);
      expect(rows.map(r => r.carried_reply)).toEqual([0, 1]);
      expect(rows[1].caption).toBe(REPLY);
      expect(rows.every(r => r.flow === 'requested_gallery')).toBe(true);
    });

    it('resolves the gallery theme for a real feed url, and leaves it null otherwise', async () => {
      // A url that exists in the catalog feed carries theme metadata; a plan card
      // or owner image does not, and must degrade to null rather than guess.
      const feedUrl = 'https://cdn.andeanscapes.com/whatsapp_bot/media/emerald_mining_tour/chivor/gallery/mine/01.jpg';
      const themed = '573001110103';
      processMessageMock.mockResolvedValue(baseResult({ contextualImage: { url: feedUrl } }));

      await inbound(themed, 'wamid-ledger-3');

      await vi.waitFor(() => expect(repos.outboundMedia.listByPhone(themed)).toHaveLength(1));
      expect(repos.outboundMedia.listByPhone(themed)[0].theme_type).toBe('mine');

      const unthemed = '573001110113';
      processMessageMock.mockResolvedValue(baseResult({ contextualImage: { url: IMAGE_URL } }));

      await inbound(unthemed, 'wamid-ledger-3b');

      await vi.waitFor(() => expect(repos.outboundMedia.listByPhone(unthemed)).toHaveLength(1));
      const row = repos.outboundMedia.listByPhone(unthemed)[0];
      expect(row.theme_type ?? null).toBeNull();
      // The url is still recorded, so the replay can show the photo untitled.
      expect(row.media_url).toBe(IMAGE_URL);
    });

    it('records nothing when the photo never reached the customer', async () => {
      const phone = '573001110104';
      sendImageUrlMock.mockRejectedValueOnce(new Error('media fetch failed'));
      processMessageMock.mockResolvedValue(baseResult({ contextualImage: { url: IMAGE_URL } }));

      await inbound(phone, 'wamid-ledger-4');

      // The reply fell back to text; a ledger row here would make the replay
      // show a photo the customer never saw.
      await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledWith(phone, REPLY));
      expect(repos.outboundMedia.listByPhone(phone)).toEqual([]);
    });

    it('never lets a ledger failure break a delivered send', async () => {
      const phone = '573001110105';
      processMessageMock.mockResolvedValue(baseResult({ contextualImage: { url: IMAGE_URL } }));
      const recordSpy = vi.spyOn(repos.outboundMedia, 'record').mockImplementation(() => {
        throw new Error('disk full');
      });

      await inbound(phone, 'wamid-ledger-5');

      // The customer still got the photo, and the reply is still recorded.
      await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledWith(phone, IMAGE_URL, REPLY));
      await vi.waitFor(() => {
        const history = repos.message.getRecentMessages(phone, 10);
        expect(history.some(m => m.role === 'assistant' && m.content === REPLY)).toBe(true);
      });
      expect(recordSpy).toHaveBeenCalled();
      recordSpy.mockRestore();
    });
  });
});
