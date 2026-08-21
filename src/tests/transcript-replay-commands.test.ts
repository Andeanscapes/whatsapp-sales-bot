import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache } from '../services/lead-routing.js';
import { leadHandler } from '../commands/lead.command.js';
import { customerHandler } from '../commands/customer.command.js';
import type { OutputBlock } from '../commands/index.js';

const PHONE = '573009900001';
const OWNER_CHAT = 333;

let db: Database.Database;
let repos: Repositories;
let previousTelegramChatId: string;

function collector(): { blocks: OutputBlock[]; emit: (b: OutputBlock) => void } {
  const blocks: OutputBlock[] = [];
  return { blocks, emit: (b: OutputBlock) => blocks.push(b) };
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.conversation.upsert(PHONE, { language: 'es' });
  previousTelegramChatId = env.TELEGRAM_CHAT_ID;
  env.TELEGRAM_CHAT_ID = String(OWNER_CHAT);
  resetRoutingConfigCache();
});

afterEach(() => {
  env.TELEGRAM_CHAT_ID = previousTelegramChatId;
  resetRoutingConfigCache();
  db.close();
  vi.restoreAllMocks();
});

/** Reproduces the reported thread: two gallery frames + a captioned price reply. */
function seedGalleryPriceTurn(): void {
  repos.message.addMessage({
    whatsapp_message_id: 'in-1',
    customer_phone: PHONE,
    direction: 'inbound',
    message_type: 'text',
    body: 'suena bien',
    created_at: '2026-08-20T10:00:00.000Z',
  });
  const reply = 'Claro, te comparto unas de la mina. Para 2 personas queda en $1.000.000 COP. ¿Qué les parece?';
  repos.message.addMessage({
    customer_phone: PHONE,
    direction: 'outbound',
    message_type: 'text',
    body: reply,
    created_at: '2026-08-20T10:00:06.000Z',
  });
  for (const [index, at] of ['2026-08-20T10:00:03.000Z', '2026-08-20T10:00:04.000Z'].entries()) {
    repos.outboundMedia.record({
      customer_phone: PHONE,
      media_url: `https://cdn.example.com/mina-${index}.jpg`,
      media_id: `gallery_/mina-${index}.jpg`,
      caption: '',
      carried_reply: 0,
      flow: 'requested_gallery',
      theme_type: 'mine',
      sequence: index,
      sent_at: at,
    });
  }
  repos.outboundMedia.record({
    customer_phone: PHONE,
    media_url: 'https://cdn.example.com/mina-2.jpg',
    media_id: 'gallery_/mina-2.jpg',
    caption: reply,
    carried_reply: 1,
    flow: 'requested_gallery',
    theme_type: 'mine',
    sequence: 2,
    sent_at: '2026-08-20T10:00:05.000Z',
  });
}

describe('/lead replay', () => {
  it('emits real photos instead of the "📷 imagen" placeholder', async () => {
    seedGalleryPriceTurn();
    const { blocks, emit } = collector();

    const footer = await leadHandler({ repos, args: [PHONE], chatId: OWNER_CHAT, emit });

    const photos = blocks.filter(b => b.kind === 'photoUrl');
    expect(photos).toHaveLength(3);
    expect(photos.map(p => (p as { url: string }).url)).toEqual([
      'https://cdn.example.com/mina-0.jpg',
      'https://cdn.example.com/mina-1.jpg',
      'https://cdn.example.com/mina-2.jpg',
    ]);

    // The regression being fixed: no block may render the placeholder.
    const texts = blocks.filter(b => b.kind === 'text').map(b => (b as { text: string }).text);
    expect(texts.some(t => t.includes('📷 imagen'))).toBe(false);

    // The price reply travels as the caption of the last photo, exactly as the
    // customer saw it — and is NOT repeated as a separate text block.
    expect((photos[2] as { caption?: string }).caption).toContain('$1.000.000 COP');
    expect(texts.some(t => t.includes('$1.000.000 COP'))).toBe(false);

    expect(footer).toContain('3 fotos');
  });

  it('leads with the field card so the operator keeps the lead summary', async () => {
    seedGalleryPriceTurn();
    const { blocks, emit } = collector();

    await leadHandler({ repos, args: [PHONE], chatId: OWNER_CHAT, emit });

    expect(blocks[0]).toMatchObject({ kind: 'text', parseMode: 'Markdown' });
    expect((blocks[0] as { text: string }).text).toContain('*Lead*');
  });

  it('shows a bare glyph for a pre-ledger image row, with no explanatory prose', async () => {
    repos.message.addMessage({
      customer_phone: PHONE,
      direction: 'outbound',
      message_type: 'image',
      body: '',
      created_at: '2026-08-20T10:00:00.000Z',
    });
    const { blocks, emit } = collector();

    const footer = await leadHandler({ repos, args: [PHONE], chatId: OWNER_CHAT, emit });

    expect(blocks.some(b => b.kind === 'photoUrl')).toBe(false);
    const texts = blocks.filter(b => b.kind === 'text').map(b => (b as { text: string }).text);
    // The transcript bubble is the glyph alone — no "imagen", no "(sin registro)".
    expect(texts).toContain('🤖 📷');
    expect(texts.some(t => t.includes('sin registro'))).toBe(false);
    expect(texts.some(t => t.includes('imagen'))).toBe(false);
    // The aggregate count stays, so the totals still add up.
    expect(footer).toContain('1 📷 sin url');
  });

  it('keeps a caption next to the glyph when the row has one', async () => {
    repos.message.addMessage({
      customer_phone: PHONE,
      direction: 'outbound',
      message_type: 'image',
      body: 'Hacienda El Recuerdo',
      created_at: '2026-08-20T10:00:00.000Z',
    });
    const { blocks, emit } = collector();

    await leadHandler({ repos, args: [PHONE], chatId: OWNER_CHAT, emit });

    const texts = blocks.filter(b => b.kind === 'text').map(b => (b as { text: string }).text);
    expect(texts).toContain('🤖 📷 Hacienda El Recuerdo');
  });

  it('downloads an inbound customer photo and degrades when the media id expired', async () => {
    repos.message.addMessage({
      whatsapp_message_id: 'in-photo',
      customer_phone: PHONE,
      direction: 'inbound',
      message_type: 'image',
      body: 'miren esto',
      created_at: '2026-08-20T10:00:00.000Z',
      media_id: 'wamid.EXPIRED',
    });

    const ok = collector();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/x' }), { status: 200 }),
    );
    await leadHandler({ repos, args: [PHONE], chatId: OWNER_CHAT, emit: ok.emit });
    // Graph metadata resolved but the binary fetch returns JSON, so the download
    // path is exercised end to end; either way it must not throw.
    expect(ok.blocks.length).toBeGreaterThan(0);

    vi.restoreAllMocks();
    const failed = collector();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('media expired'));
    await leadHandler({ repos, args: [PHONE], chatId: OWNER_CHAT, emit: failed.emit });
    const texts = failed.blocks.filter(b => b.kind === 'text').map(b => (b as { text: string }).text);
    expect(texts.some(t => t.includes('no disponible'))).toBe(true);
  });

  it('falls back to the text transcript when no emitter is available', async () => {
    seedGalleryPriceTurn();
    const output = await leadHandler({ repos, args: [PHONE], chatId: OWNER_CHAT });
    // Offline callers still get the full card + history in one string.
    expect(output).toContain('*Lead*');
    expect(output).toContain('Recent messages');
  });

  it('caps the requested turn count', async () => {
    seedGalleryPriceTurn();
    const { blocks, emit } = collector();
    const footer = await leadHandler({ repos, args: [PHONE, '999'], chatId: OWNER_CHAT, emit });
    expect(footer).toContain('ultimos 40 turnos');
    expect(blocks.length).toBeGreaterThan(0);
  });
});

describe('/customer replay', () => {
  it('emits the profile card plus real photos', async () => {
    seedGalleryPriceTurn();
    const { blocks, emit } = collector();

    await customerHandler({ repos, args: [PHONE], chatId: OWNER_CHAT, emit });

    expect((blocks[0] as { text: string }).text).toContain('Perfil de Cliente');
    expect(blocks.filter(b => b.kind === 'photoUrl').length).toBeGreaterThan(0);
  });
});
