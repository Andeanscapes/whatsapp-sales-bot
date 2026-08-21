import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { registerCommand } from '../commands/index.js';
import { processUpdate, type TelegramUpdate } from '../services/telegram-bot.js';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Booking', weight: 100, telegramChatId: '111', agentName: 'AgentA' },
  ],
};

const OWNER_CHAT = 333;

let db: Database.Database;
let repos: Repositories;
let previousRoutingJson: string;
let previousTelegramChatId: string;
let previousTelegramBotToken: string;

function update(text: string): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      chat: { id: OWNER_CHAT, type: 'private' },
      from: { id: OWNER_CHAT, username: 'owner' },
      text,
    },
  };
}

/** Telegram API calls captured in order, so block ordering is assertable. */
function captureCalls(): { calls: { path: string; body: unknown }[]; restore: () => void } {
  const calls: { path: string; body: unknown }[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.lastIndexOf('/') + 1);
    let body: unknown = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ path, body });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  return { calls, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  previousTelegramChatId = env.TELEGRAM_CHAT_ID;
  previousTelegramBotToken = env.TELEGRAM_BOT_TOKEN;
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  env.TELEGRAM_CHAT_ID = String(OWNER_CHAT);
  env.TELEGRAM_BOT_TOKEN = 'test-token';
  resetRoutingConfigCache();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  env.TELEGRAM_CHAT_ID = previousTelegramChatId;
  env.TELEGRAM_BOT_TOKEN = previousTelegramBotToken;
  resetRoutingConfigCache();
  db.close();
  vi.restoreAllMocks();
});

describe('command output blocks', () => {
  it('sends a single-block command with no pacing delay', async () => {
    registerCommand({ name: 'tbplain', description: 'test', handler: async () => 'solo texto' });
    const { calls, restore } = captureCalls();

    const startedAt = Date.now();
    await processUpdate(update('/tbplain'), repos);
    const elapsed = Date.now() - startedAt;

    // Pacing must apply BETWEEN blocks only. A status/report command has one
    // block, so adding ~1.2s here would tax the entire operator surface.
    expect(elapsed).toBeLessThan(400);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('sendMessage');
    restore();
  });

  it('batches consecutive photos into one album and puts the handler text last', async () => {
    registerCommand({
      name: 'tbreplay',
      description: 'test',
      handler: async ctx => {
        ctx.emit?.({ kind: 'photoUrl', url: 'https://cdn.example.com/1.jpg' });
        ctx.emit?.({ kind: 'photoUrl', url: 'https://cdn.example.com/2.jpg', caption: 'con caption' });
        return 'Chat activo';
      },
    });
    const { calls, restore } = captureCalls();

    await processUpdate(update('/tbreplay'), repos);

    // One request for the burst, not one per photo — this is what removes the
    // trickle-in delay operators were seeing.
    expect(calls.map(c => c.path)).toEqual(['sendMediaGroup', 'sendMessage']);
    const media = (calls[0].body as { media: { type: string; media: string; caption?: string }[] }).media;
    expect(media.map(m => m.media)).toEqual(['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg']);
    expect(media[0].type).toBe('photo');
    // Per-item captions survive batching, so the reply stays under its own photo.
    expect(media[0].caption).toBeUndefined();
    expect(media[1].caption).toBe('con caption');
    // The call-to-action must arrive after the replay, not before it.
    expect((calls[1].body as { text: string }).text).toBe('Chat activo');
    restore();
  }, 10_000);

  it('never puts two captioned photos in one album', async () => {
    registerCommand({
      name: 'tbtwocaptions',
      description: 'test',
      handler: async ctx => {
        ctx.emit?.({ kind: 'photoUrl', url: 'https://cdn.example.com/t1.jpg', caption: '🤖 turno uno' });
        ctx.emit?.({ kind: 'photoUrl', url: 'https://cdn.example.com/t2.jpg', caption: '🤖 turno dos' });
        return '';
      },
    });
    const { calls, restore } = captureCalls();

    await processUpdate(update('/tbtwocaptions'), repos);

    // Telegram shows NO caption for a group holding two of them, which hid both
    // bot replies in the operator replay. Separate sends keep each text visible.
    expect(calls.map(c => c.path)).toEqual(['sendPhoto', 'sendPhoto']);
    expect((calls[0].body as { caption?: string }).caption).toBe('🤖 turno uno');
    expect((calls[1].body as { caption?: string }).caption).toBe('🤖 turno dos');
    restore();
  }, 10_000);

  it('keeps a gallery with one caption as a single album', async () => {
    registerCommand({
      name: 'tbgallery',
      description: 'test',
      handler: async ctx => {
        for (let i = 0; i < 4; i += 1) ctx.emit?.({ kind: 'photoUrl', url: `https://cdn.example.com/g${i}.jpg` });
        ctx.emit?.({ kind: 'photoUrl', url: 'https://cdn.example.com/g4.jpg', caption: '🤖 la respuesta' });
        return '';
      },
    });
    const { calls, restore } = captureCalls();

    await processUpdate(update('/tbgallery'), repos);

    // The carrier is the last photo of its turn, so batching must survive: one
    // request, exactly one caption.
    expect(calls.map(c => c.path)).toEqual(['sendMediaGroup']);
    const media = (calls[0].body as { media: { caption?: string }[] }).media;
    expect(media).toHaveLength(5);
    expect(media.filter(m => m.caption !== undefined).map(m => m.caption)).toEqual(['🤖 la respuesta']);
    restore();
  }, 10_000);

  it('keeps a lone photo as sendPhoto so it renders full size', async () => {
    registerCommand({
      name: 'tbsolo',
      description: 'test',
      handler: async ctx => {
        ctx.emit?.({ kind: 'photoUrl', url: 'https://cdn.example.com/only.jpg', caption: 'sola' });
        return '';
      },
    });
    const { calls, restore } = captureCalls();

    await processUpdate(update('/tbsolo'), repos);

    expect(calls.map(c => c.path)).toEqual(['sendPhoto']);
    restore();
  });

  it('splits a long photo run into albums of ten and never mixes text into them', async () => {
    registerCommand({
      name: 'tbmixed',
      description: 'test',
      handler: async ctx => {
        for (let i = 0; i < 12; i += 1) ctx.emit?.({ kind: 'photoUrl', url: `https://cdn.example.com/${i}.jpg` });
        ctx.emit?.({ kind: 'text', text: 'cliente dijo algo' });
        for (let i = 0; i < 2; i += 1) ctx.emit?.({ kind: 'photoUrl', url: `https://cdn.example.com/b${i}.jpg` });
        return 'fin';
      },
    });
    const { calls, restore } = captureCalls();

    await processUpdate(update('/tbmixed'), repos);

    // 12 photos -> album(10) + 2 remaining -> album(2); then text; then album(2); then footer.
    expect(calls.map(c => c.path)).toEqual([
      'sendMediaGroup', 'sendMediaGroup', 'sendMessage', 'sendMediaGroup', 'sendMessage',
    ]);
    expect((calls[0].body as { media: unknown[] }).media).toHaveLength(10);
    expect((calls[1].body as { media: unknown[] }).media).toHaveLength(2);
    // Chronology is preserved: the text lands between the two photo runs.
    expect((calls[2].body as { text: string }).text).toBe('cliente dijo algo');
    restore();
  }, 10_000);

  it('retries the same block after a 429 instead of dropping it', async () => {
    registerCommand({ name: 'tb429', description: 'test', handler: async () => 'texto final' });

    const attempts: string[] = [];
    let first = true;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      attempts.push(url.slice(url.lastIndexOf('/') + 1));
      if (first) {
        first = false;
        // Telegram reports the backoff in the JSON body, not the header.
        return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 0 } }), { status: 429 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    await processUpdate(update('/tb429'), repos);

    // Two attempts on the SAME sendMessage: a rate-limited trailing text block
    // that is skipped means the command answers nothing at all.
    expect(attempts).toEqual(['sendMessage', 'sendMessage']);
    spy.mockRestore();
  }, 10_000);

  it('degrades a failed photo to a text line carrying the url', async () => {
    registerCommand({
      name: 'tbbadphoto',
      description: 'test',
      handler: async ctx => {
        ctx.emit?.({ kind: 'photoUrl', url: 'https://cdn.example.com/gone.jpg', caption: 'mina' });
        return 'listo';
      },
    });

    const bodies: unknown[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
      if (url.endsWith('/sendPhoto')) {
        return new Response(JSON.stringify({ ok: false, description: 'wrong file identifier' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    await processUpdate(update('/tbbadphoto'), repos);

    const texts = bodies
      .filter((b): b is { text: string } => typeof (b as { text?: unknown }).text === 'string')
      .map(b => b.text);
    // The operator still learns which image was involved.
    expect(texts.some(t => t.includes('https://cdn.example.com/gone.jpg') && t.includes('mina'))).toBe(true);
    expect(texts).toContain('listo');
    spy.mockRestore();
  }, 10_000);

  it('caps emitted blocks so a replay cannot flood the chat', async () => {
    registerCommand({
      name: 'tbflood',
      description: 'test',
      handler: async ctx => {
        for (let i = 0; i < 100; i += 1) {
          ctx.emit?.({ kind: 'photoUrl', url: `https://cdn.example.com/${i}.jpg` });
        }
        return '';
      },
    });
    const { calls, restore } = captureCalls();

    await processUpdate(update('/tbflood'), repos);

    // The cap is on BLOCKS (40 photos), which album batching turns into 4 calls.
    expect(calls.map(c => c.path)).toEqual(Array(4).fill('sendMediaGroup'));
    const total = calls.reduce((sum, c) => sum + (c.body as { media: unknown[] }).media.length, 0);
    expect(total).toBe(40);
    restore();
  }, 30_000);

  it('completes a photo-heavy replay quickly instead of trickling in', async () => {
    registerCommand({
      name: 'tbfast',
      description: 'test',
      handler: async ctx => {
        for (let i = 0; i < 20; i += 1) ctx.emit?.({ kind: 'photoUrl', url: `https://cdn.example.com/${i}.jpg` });
        return 'listo';
      },
    });
    const { calls, restore } = captureCalls();

    const startedAt = Date.now();
    await processUpdate(update('/tbfast'), repos);
    const elapsed = Date.now() - startedAt;

    // 20 photos used to be 20 sequential sends with a 1.2s gap (~24s). Now it is
    // two albums plus the footer.
    expect(calls).toHaveLength(3);
    expect(elapsed).toBeLessThan(1500);
    restore();
  }, 10_000);

  it('retries an album photo-by-photo when the batch is rejected', async () => {
    registerCommand({
      name: 'tbbadalbum',
      description: 'test',
      handler: async ctx => {
        ctx.emit?.({ kind: 'photoUrl', url: 'https://cdn.example.com/ok.jpg' });
        ctx.emit?.({ kind: 'photoUrl', url: 'https://cdn.example.com/bad.jpg', caption: 'roto' });
        return '';
      },
    });

    const paths: string[] = [];
    const bodies: unknown[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      paths.push(url.slice(url.lastIndexOf('/') + 1));
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
      // One bad url fails the whole album; the good photo must not be lost.
      if (url.endsWith('/sendMediaGroup')) {
        return new Response(JSON.stringify({ ok: false, description: 'failed to get HTTP URL content' }), { status: 400 });
      }
      if (url.endsWith('/sendPhoto') && typeof init?.body === 'string' && init.body.includes('bad.jpg')) {
        return new Response(JSON.stringify({ ok: false, description: 'wrong file identifier' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    await processUpdate(update('/tbbadalbum'), repos);

    expect(paths[0]).toBe('sendMediaGroup');
    // Both photos retried individually; the good one succeeds.
    expect(paths.filter(p => p === 'sendPhoto')).toHaveLength(2);
    // The unrecoverable one degrades to a text line carrying its url.
    const texts = bodies
      .filter((b): b is { text: string } => typeof (b as { text?: unknown }).text === 'string')
      .map(b => b.text);
    expect(texts.some(t => t.includes('bad.jpg') && t.includes('roto'))).toBe(true);
    spy.mockRestore();
  }, 10_000);

  const CDN_URL = 'https://cdn.andeanscapes.com/whatsapp_bot/emerald_mining_chivor/exp/exp_32.jpg';

  /** Counts Telegram calls and separates them from catalog CDN fetches. */
  function trackTelegram(onTelegram: (path: string, body: string | null, seen: string[]) => Response) {
    const telegramPaths: string[] = [];
    const cdnFetches: string[] = [];
    /** Calls that asked Telegram to fetch a url itself (JSON body carrying `photo`). */
    const urlSends: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(input);
      if (!raw.includes('api.telegram.org')) {
        cdnFetches.push(raw);
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      const path = raw.slice(raw.lastIndexOf('/') + 1);
      const body = typeof init?.body === 'string' ? init.body : null;
      const seen = [...telegramPaths];
      // Record BEFORE invoking the stub: a stub that throws (simulating a
      // timeout) must still count as an attempt, otherwise the test cannot
      // detect a duplicate send.
      telegramPaths.push(path);
      if (path === 'sendPhoto' && body) {
        urlSends.push(JSON.parse(body).photo as string);
      }
      return onTelegram(path, body, seen);
    });
    return { telegramPaths, cdnFetches, urlSends, restore: () => spy.mockRestore() };
  }

  it('uploads the bytes without re-attempting the url for a single photo', async () => {
    registerCommand({
      name: 'tbupload',
      description: 'test',
      handler: async ctx => {
        ctx.emit?.({ kind: 'photoUrl', url: CDN_URL, caption: '🤖 hospedaje' });
        return '';
      },
    });

    const tracked = trackTelegram((path, body) => {
      // Telegram's fetcher refuses the url; the CDN itself is healthy.
      if (path === 'sendPhoto' && body?.includes(CDN_URL)) {
        return new Response(JSON.stringify({ ok: false, description: 'failed to get HTTP URL content' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    await processUpdate(update('/tbupload'), repos);

    // The url must be handed to Telegram exactly ONCE; the second call is the
    // multipart upload. A repeated url send is the double-post bug.
    expect(tracked.urlSends).toEqual([CDN_URL]);
    expect(tracked.telegramPaths.filter(p => p === 'sendPhoto')).toHaveLength(2);
    expect(tracked.cdnFetches).toEqual([CDN_URL]);
    // Delivered as an image, so no link fallback.
    expect(tracked.telegramPaths).not.toContain('sendMessage');
    tracked.restore();
  }, 10_000);

  it('does not post a photo twice when the url attempt times out', async () => {
    registerCommand({
      name: 'tbtimeout',
      description: 'test',
      handler: async ctx => {
        ctx.emit?.({ kind: 'photoUrl', url: CDN_URL });
        return '';
      },
    });

    // A timeout is indistinguishable from a slow success: Telegram may already
    // have accepted the photo, so the url must never be retried.
    const tracked = trackTelegram((path, body) => {
      if (path === 'sendPhoto' && body?.includes(CDN_URL)) throw new Error('The operation was aborted due to timeout');
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    await processUpdate(update('/tbtimeout'), repos);

    // The photo may already be in the chat, so the url is never sent again.
    expect(tracked.urlSends).toEqual([CDN_URL]);
    tracked.restore();
  }, 10_000);

  it('still retries each album item by url before uploading it', async () => {
    registerCommand({
      name: 'tbalbumurl',
      description: 'test',
      handler: async ctx => {
        ctx.emit?.({ kind: 'photoUrl', url: `${CDN_URL}?a=1` });
        ctx.emit?.({ kind: 'photoUrl', url: `${CDN_URL}?a=2` });
        return '';
      },
    });

    const tracked = trackTelegram((path) => {
      // The batch fails, but the individual url sends succeed.
      if (path === 'sendMediaGroup') {
        return new Response(JSON.stringify({ ok: false, description: 'failed to get HTTP URL content' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    await processUpdate(update('/tbalbumurl'), repos);

    // Album items were never tried individually, so one url attempt each is
    // correct — and no byte upload is needed because they succeed.
    expect(tracked.urlSends).toEqual([`${CDN_URL}?a=1`, `${CDN_URL}?a=2`]);
    expect(tracked.cdnFetches).toEqual([]);
    tracked.restore();
  }, 10_000);

  it('refuses to fetch a non-catalog url when falling back to upload', async () => {
    registerCommand({
      name: 'tbssrf',
      description: 'test',
      handler: async ctx => {
        ctx.emit?.({ kind: 'photoUrl', url: 'https://evil.example.com/internal.jpg', caption: 'x' });
        return '';
      },
    });

    const fetched: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const raw = String(input);
      fetched.push(raw);
      if (raw.includes('api.telegram.org') && raw.endsWith('/sendPhoto')) {
        return new Response(JSON.stringify({ ok: false, description: 'bad url' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    await processUpdate(update('/tbssrf'), repos);

    // The host allowlist must stop this becoming a general-purpose fetcher.
    expect(fetched.some(u => u.startsWith('https://evil.example.com'))).toBe(false);
    spy.mockRestore();
  }, 10_000);

  it('still reports a handler failure to the operator', async () => {
    registerCommand({
      name: 'tbthrow',
      description: 'test',
      handler: async () => { throw new Error('boom'); },
    });
    const { calls, restore } = captureCalls();

    await processUpdate(update('/tbthrow'), repos);

    expect(calls).toHaveLength(1);
    expect((calls[0].body as { text: string }).text).toContain('Error procesando el comando');
    restore();
  });
});
