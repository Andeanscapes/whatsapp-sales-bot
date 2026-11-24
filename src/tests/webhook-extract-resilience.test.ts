import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../app.js';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';
import { setErrorRepos } from '../services/error-logger.js';
import { drainWebhookQueue, extractWebhookItems } from '../routes/whatsapp-webhook.route.js';
import { getWebhookStats, resetWebhookStats } from '../services/webhook-stats.js';

const { sendTextMock, downloadMediaMock, sendTelegramDocumentMock, sendTelegramMessageMock, processMessageMock, lastProcessed } =
  vi.hoisted(() => {
    const seen: string[] = [];
    return {
      sendTextMock: vi.fn(() => Promise.resolve()),
      downloadMediaMock: vi.fn(() => Promise.resolve({ buffer: Buffer.from('pdf'), mimeType: 'application/pdf' })),
      sendTelegramDocumentMock: vi.fn(() => Promise.resolve(true)),
      sendTelegramMessageMock: vi.fn(() => Promise.resolve(true)),
      lastProcessed: seen,
      processMessageMock: vi.fn(async (params: { message: string }) => {
        seen.push(params.message);
        return {
          reply: 'ok',
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
        };
      }),
    };
  });

vi.mock('../services/whatsapp-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/whatsapp-client.js')>();
  return {
    ...actual,
    sendText: sendTextMock,
    sendImageUrl: vi.fn(() => Promise.resolve({ whatsappMessageId: 'wamid.IMG' })),
    downloadMedia: downloadMediaMock,
  };
});

vi.mock('../services/telegram-document.js', () => ({ sendTelegramDocument: sendTelegramDocumentMock }));

vi.mock('../services/telegram-bot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/telegram-bot.js')>();
  return { ...actual, sendTelegramMessage: sendTelegramMessageMock, sendTelegramPhoto: vi.fn(), sendTelegramVoice: vi.fn() };
});

vi.mock('../services/response-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/response-engine.js')>();
  return { ...actual, processMessage: processMessageMock };
});

const PHONE = '573001112244';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(body).digest('hex')}`;
}

function envelope(messages: unknown[]): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'biz', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages } }] }],
  });
}

const textMessage = (id = 'wamid.T1', body = 'hola') => ({ from: PHONE, id, type: 'text', text: { body } });
const goodEntry = { id: 'biz', changes: [{ field: 'messages', value: { messages: [textMessage()] } }] };
const wrap = (entry: unknown[]) => ({ object: 'whatsapp_business_account', entry });

describe('extractWebhookItems: one bad item never discards the batch', () => {
  // Each case previously returned null for the WHOLE payload, so a real customer
  // message travelling in the same POST was lost silently and permanently.
  const survives: Record<string, unknown> = {
    'entry without changes': wrap([goodEntry, { id: 'biz', time: 1 }]),
    'change without value': wrap([goodEntry, { id: 'biz', changes: [{ field: 'messages' }] }]),
    'change without field': wrap([goodEntry, { id: 'biz', changes: [{ value: { statuses: [] } }] }]),
    'empty entry object': wrap([goodEntry, {}]),
    'numeric entry id': wrap([{ id: 987654, changes: [{ field: 'messages', value: { messages: [textMessage()] } }] }]),
    'statuses-only sibling': wrap([goodEntry, { id: 'biz', changes: [{ field: 'messages', value: { statuses: [{ id: 's' }] } }] }]),
    'message missing id': wrap([{ id: 'biz', changes: [{ field: 'messages', value: { messages: [textMessage(), { from: PHONE, type: 'text' }] } }] }]),
  };

  for (const [name, payload] of Object.entries(survives)) {
    it(`keeps the real message when a sibling is malformed: ${name}`, () => {
      const { messages } = extractWebhookItems(payload);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toBe('hola');
    });
  }

  it('truncates oversized referral fields instead of rejecting the payload', () => {
    const payload = wrap([{
      id: 'biz',
      changes: [{ field: 'messages', value: { messages: [{ ...textMessage(), referral: { ctwa_clid: 'A'.repeat(900), headline: 'H'.repeat(900), source_type: 'ad' } }] } }],
    }]);

    const { messages, skipped } = extractWebhookItems(payload);

    expect(skipped).toHaveLength(0);
    expect(messages[0]?.referral?.ctwa_clid).toHaveLength(500);
    expect(messages[0]?.referral?.headline).toHaveLength(500);
  });

  it('does not report a skip for ordinary status traffic', () => {
    const { messages, skipped } = extractWebhookItems(
      wrap([{ id: 'biz', changes: [{ field: 'messages', value: { statuses: [{ id: 's', status: 'delivered' }] } }] }]),
    );

    expect(messages).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  it('reports an unparsable payload instead of returning silently', () => {
    const { messages, skipped } = extractWebhookItems({ not: 'a webhook' });

    expect(messages).toHaveLength(0);
    expect(skipped).toEqual([{ level: 'envelope', reason: 'unparsable_payload' }]);
  });

  it('reports a reaction with its own reason and never stores it', () => {
    const { messages, skipped } = extractWebhookItems(
      wrap([{ id: 'biz', changes: [{ field: 'messages', value: { messages: [{ from: PHONE, id: 'wamid.R', type: 'reaction', reaction: { emoji: '👍' } }] } }] }]),
    );

    expect(messages).toHaveLength(0);
    expect(skipped).toEqual([{ level: 'message', reason: 'reaction_ignored', messageType: 'reaction' }]);
  });

  it('reports an unknown type without a message body', () => {
    const { skipped } = extractWebhookItems(
      wrap([{ id: 'biz', changes: [{ field: 'messages', value: { messages: [{ from: PHONE, id: 'wamid.X', type: 'order' }] } }] }]),
    );

    expect(skipped).toEqual([{ level: 'message', reason: 'unsupported_type', messageType: 'order' }]);
    expect(JSON.stringify(skipped)).not.toContain(PHONE);
  });
});

describe('extractWebhookItems: tapped replies become text', () => {
  it('maps a template button tap to text', () => {
    const { messages } = extractWebhookItems(
      wrap([{ id: 'biz', changes: [{ field: 'messages', value: { messages: [{ from: PHONE, id: 'wamid.B', type: 'button', button: { text: 'Si', payload: 'YES' } }] } }] }]),
    );

    expect(messages[0]).toMatchObject({ type: 'text', text: 'Si' });
  });

  it('maps an interactive button reply to text', () => {
    const { messages } = extractWebhookItems(
      wrap([{ id: 'biz', changes: [{ field: 'messages', value: { messages: [{ from: PHONE, id: 'wamid.I', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Quiero reservar' } } }] } }] }]),
    );

    expect(messages[0]).toMatchObject({ type: 'text', text: 'Quiero reservar' });
  });

  it('skips an interactive subtype with no plain title instead of guessing', () => {
    const { messages, skipped } = extractWebhookItems(
      wrap([{ id: 'biz', changes: [{ field: 'messages', value: { messages: [{ from: PHONE, id: 'wamid.F', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{}' } } }] } }] }]),
    );

    expect(messages).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ reason: 'unsupported_type', messageType: 'interactive' });
  });
});

describe('extractWebhookItems: previously discarded media types', () => {
  it('extracts a document with its filename', () => {
    const { messages } = extractWebhookItems(
      wrap([{ id: 'biz', changes: [{ field: 'messages', value: { messages: [{ from: PHONE, id: 'wamid.D', type: 'document', document: { id: 'media-1', mime_type: 'application/pdf', filename: 'comprobante.pdf' } }] } }] }]),
    );

    expect(messages[0]).toMatchObject({ type: 'document', text: 'comprobante.pdf', filename: 'comprobante.pdf' });
    expect(messages[0]?.media).toEqual({ id: 'media-1', mimeType: 'application/pdf' });
  });

  it('labels a location, falling back to coordinates', () => {
    const named = extractWebhookItems(
      wrap([{ id: 'biz', changes: [{ field: 'messages', value: { messages: [{ from: PHONE, id: 'wamid.L1', type: 'location', location: { latitude: 4.6, longitude: -74.1, name: 'Chivor' } }] } }] }]),
    );
    const bare = extractWebhookItems(
      wrap([{ id: 'biz', changes: [{ field: 'messages', value: { messages: [{ from: PHONE, id: 'wamid.L2', type: 'location', location: { latitude: 4.6, longitude: -74.1 } }] } }] }]),
    );

    expect(named.messages[0]).toMatchObject({ type: 'location', text: 'Chivor' });
    expect(bare.messages[0]).toMatchObject({ type: 'location', text: '4.6,-74.1' });
  });

  it('extracts sticker, contacts and unsupported', () => {
    const { messages } = extractWebhookItems(
      wrap([{
        id: 'biz',
        changes: [{
          field: 'messages',
          value: {
            messages: [
              { from: PHONE, id: 'wamid.S', type: 'sticker', sticker: { id: 'media-2', mime_type: 'image/webp' } },
              { from: PHONE, id: 'wamid.C', type: 'contacts', contacts: [{ name: { formatted_name: 'Juan Perez' } }] },
              { from: PHONE, id: 'wamid.U', type: 'unsupported' },
            ],
          },
        }],
      }]),
    );

    expect(messages.map(m => m.type)).toEqual(['sticker', 'contacts', 'unsupported']);
    // A contact card names a THIRD PARTY. `body` feeds getRecentMessages, which
    // builds the LLM history sent to DeepSeek, so the name is never carried.
    expect(messages[1]?.text).toBe('');
  });
});

describe('webhook route intake', () => {
  let db: Database.Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let previousOwnerOnly: boolean;
  let previousTelegramChat: string;

  async function post(payload: string) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) },
      payload,
    });
  }

  beforeEach(async () => {
    loadSkills();
    previousOwnerOnly = env.WEBHOOK_OWNER_ONLY_ENABLED;
    previousTelegramChat = env.TELEGRAM_CHAT_ID;
    env.WEBHOOK_OWNER_ONLY_ENABLED = false;
    env.TELEGRAM_CHAT_ID = '987654';
    lastProcessed.length = 0;
    resetWebhookStats();
    vi.clearAllMocks();
    db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    // logSystemError writes through a module-level repo reference that only
    // server.ts sets, so skips would not reach system_errors without this.
    setErrorRepos(repos);
    app = await buildApp(repos);
    await app.ready();
  });

  afterEach(async () => {
    env.WEBHOOK_OWNER_ONLY_ENABLED = previousOwnerOnly;
    env.TELEGRAM_CHAT_ID = previousTelegramChat;
    setErrorRepos(null);
    await app.close();
    db.close();
  });

  it('delivers a tapped button to the reply path as text', async () => {
    const res = await post(envelope([{ from: PHONE, id: 'wamid.BTN', type: 'button', button: { text: 'Si' } }]));
    expect(res.statusCode).toBe(200);
    await drainWebhookQueue(5_000);

    expect(lastProcessed).toContain('Si');
  });

  it('stores a document and relays it to the owner as a likely receipt', async () => {
    const res = await post(envelope([{ from: PHONE, id: 'wamid.DOC', type: 'document', document: { id: 'media-9', mime_type: 'application/pdf', filename: 'pago.pdf' } }]));
    expect(res.statusCode).toBe(200);
    await drainWebhookQueue(5_000);

    const stored = db.prepare('SELECT message_type, body FROM messages WHERE customer_phone = ?').all(PHONE) as { message_type: string; body: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.message_type).toBe('document');
    // The customer's own file name reaches Telegram, and the caption flags it.
    expect(sendTelegramDocumentMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramDocumentMock).toHaveBeenCalledWith(
      '987654',
      expect.any(Buffer),
      'pago.pdf',
      'application/pdf',
      expect.stringContaining('comprobante'),
    );
    // Never answered by the bot: only text reaches the reply path.
    expect(lastProcessed).toHaveLength(0);
  });

  it('keeps the transcript row when the document download fails', async () => {
    downloadMediaMock.mockRejectedValueOnce(new Error('media gone'));

    await post(envelope([{ from: PHONE, id: 'wamid.DOC2', type: 'document', document: { id: 'media-10', mime_type: 'application/pdf' } }]));
    await drainWebhookQueue(5_000);

    const stored = db.prepare('SELECT message_type FROM messages WHERE customer_phone = ?').all(PHONE);
    expect(stored).toHaveLength(1);
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
    expect(sendTelegramMessageMock).toHaveBeenCalled();
  });

  it('stores a sticker without replying', async () => {
    await post(envelope([{ from: PHONE, id: 'wamid.STK', type: 'sticker', sticker: { id: 'media-11', mime_type: 'image/webp' } }]));
    await drainWebhookQueue(5_000);

    const stored = db.prepare('SELECT message_type FROM messages WHERE customer_phone = ?').all(PHONE) as { message_type: string }[];
    expect(stored[0]?.message_type).toBe('sticker');
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('records a webhook_parse system error for a discarded item', async () => {
    await post(envelope([{ from: PHONE, id: 'wamid.ORD', type: 'order' }]));
    await drainWebhookQueue(5_000);

    const errors = db.prepare('SELECT error_type, context_json FROM system_errors').all() as { error_type: string; context_json: string | null }[];
    const parseErrors = errors.filter(e => e.error_type === 'webhook_parse');
    expect(parseErrors).toHaveLength(1);
    // Shape only: a skip report must never carry a phone number or a body...
    expect(parseErrors[0]?.context_json ?? '').not.toContain(PHONE);
    // ...but the item type must survive masking, or the log cannot be diagnosed.
    expect(parseErrors[0]?.context_json ?? '').toContain('order');
  });

  it('logs no webhook_parse for ordinary status callbacks', async () => {
    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'biz', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.S1', status: 'delivered' }] } }] }],
    });

    await post(payload);

    const errors = db.prepare("SELECT count(*) n FROM system_errors WHERE error_type = 'webhook_parse'").get() as { n: number };
    expect(errors.n).toBe(0);
  });

  it('counts posts, messages, skips and reactions separately', async () => {
    await post(envelope([
      textMessage('wamid.CT1', 'hola'),
      { from: PHONE, id: 'wamid.CR1', type: 'reaction', reaction: { emoji: '👍' } },
      { from: PHONE, id: 'wamid.CO1', type: 'order' },
    ]));
    await drainWebhookQueue(5_000);

    const stats = getWebhookStats();
    expect(stats.posts).toBe(1);
    expect(stats.messages).toBe(1);
    expect(stats.reactions).toBe(1);
    expect(stats.skipped).toBe(1);
  });

  it('never stores a reaction, so it cannot become the newest message', async () => {
    await post(envelope([{ from: PHONE, id: 'wamid.RX', type: 'reaction', reaction: { emoji: '👍' } }]));
    await drainWebhookQueue(5_000);

    const stored = db.prepare('SELECT count(*) n FROM messages WHERE customer_phone = ?').get(PHONE) as { n: number };
    expect(stored.n).toBe(0);
  });

  it('aggregates many identical skips into one system error row', async () => {
    // Meta batches up to 1000 updates per POST. One row per item would flood the
    // table operators read to find lost messages.
    const many = Array.from({ length: 50 }, (_, i) => ({ from: PHONE, id: `wamid.MANY${i}`, type: 'order' }));
    await post(envelope(many));
    await drainWebhookQueue(5_000);

    const rows = db.prepare("SELECT context_json FROM system_errors WHERE error_type = 'webhook_parse'").all() as { context_json: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.context_json ?? '').toContain('"count":50');
    expect(getWebhookStats().skipped).toBe(50);
  });

  it('stores a contacts card without the third party name', async () => {
    await post(envelope([{ from: PHONE, id: 'wamid.CC', type: 'contacts', contacts: [{ name: { formatted_name: 'Juan Perez' } }] }]));
    await drainWebhookQueue(5_000);

    const stored = db.prepare('SELECT message_type, body FROM messages WHERE customer_phone = ?').all(PHONE) as { message_type: string; body: string | null }[];
    expect(stored[0]?.message_type).toBe('contacts');
    expect(stored[0]?.body ?? '').not.toContain('Juan Perez');
  });

  it('stores a document even when no Telegram chat is configured', async () => {
    env.TELEGRAM_CHAT_ID = '';

    await post(envelope([{ from: PHONE, id: 'wamid.DOC3', type: 'document', document: { id: 'media-12', mime_type: 'application/pdf' } }]));
    await drainWebhookQueue(5_000);

    const stored = db.prepare('SELECT count(*) n FROM messages WHERE customer_phone = ?').get(PHONE) as { n: number };
    expect(stored.n).toBe(1);
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
  });

  it('tells a live bridge agent what arrived instead of an empty bubble', async () => {
    // These types were dropped at extraction before, so the plain text relay —
    // which renders msg.text — would reach the agent blank.
    const repos = createRepositories(db);
    repos.conversation.upsert(PHONE, {});
    repos.bridgeSession.open(env.TELEGRAM_CHAT_ID, PHONE);
    repos.conversation.setMode(PHONE, 'bridge_active');

    await post(envelope([{ from: PHONE, id: 'wamid.STK2', type: 'sticker', sticker: { id: 'media-13', mime_type: 'image/webp' } }]));
    await drainWebhookQueue(5_000);

    const relayed = sendTelegramMessageMock.mock.calls.map(call => String((call as unknown[])[1] ?? ''));
    expect(relayed.some(text => text.includes('sticker'))).toBe(true);
    expect(relayed.some(text => text.trim().endsWith(PHONE))).toBe(false);
  });

  it('does not write a system error for a reaction', async () => {
    // Reactions are expected traffic. Logging them as webhook_parse would bury
    // the real parse failures operators read system_errors for.
    await post(envelope([{ from: PHONE, id: 'wamid.RX2', type: 'reaction', reaction: { emoji: '👍' } }]));
    await drainWebhookQueue(5_000);

    const errors = db.prepare("SELECT count(*) n FROM system_errors WHERE error_type = 'webhook_parse'").get() as { n: number };
    expect(errors.n).toBe(0);
    expect(getWebhookStats().reactions).toBe(1);
  });
});

describe('drainWebhookQueue', () => {
  it('returns 0 when there is nothing in flight', async () => {
    await expect(drainWebhookQueue(1_000)).resolves.toBe(0);
  });
});
