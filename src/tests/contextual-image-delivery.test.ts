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

  async function inbound(phone: string, id: string): Promise<void> {
    const body = inboundPayload(phone, 'Pareja', id);
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

  // The plan card on a price turn is mandatory: it must never fall behind the
  // contextual-image dice roll. Only the themed gallery photo is probabilistic.
  it('still sends the plan card on a price turn when the contextual probability is zero', async () => {
    const phone = '573001110011';
    env.CONTEXTUAL_IMAGES_PROBABILITY = 0;
    processMessageMock.mockResolvedValue(baseResult({ priceJustGiven: true }));

    await inbound(phone, 'wamid-ctx-11');

    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(1));
    expect(sendImageUrlMock.mock.calls[0]?.[2]).toBe(REPLY);
  });

  it('falls back to text plus the captioned plan card when the reply is too long', async () => {
    const phone = '573001110008';
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
    processMessageMock.mockResolvedValue(baseResult({ priceJustGiven: true }));

    await inbound(phone, 'wamid-ctx-9a');
    await vi.waitFor(() => expect(sendImageUrlMock).toHaveBeenCalledTimes(1));
    sendImageUrlMock.mockClear();
    sendTextMock.mockClear();

    await inbound(phone, 'wamid-ctx-9b');

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
      const feedUrl = 'https://cdn.andeanscapes.com/whatsapp_bot/emerald_mining_chivor/exp/exp_01.jpg';
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
