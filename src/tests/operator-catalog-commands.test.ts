import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import type { CommandContext, OutputBlock } from '../commands/index.js';
import { plansHandler } from '../commands/plans.command.js';
import { datesHandler } from '../commands/dates.command.js';
import { imagesHandler } from '../commands/images.command.js';
import { deleteHandler } from '../commands/delete.command.js';
import { getOperatorCatalog, setDynamicService } from '../services/skill-loader.js';
import { DynamicDataService } from '../services/dynamic-data-service.js';
import { resetRoutingConfigCache } from '../services/lead-routing.js';
import { processUpdate, registerCommands, type TelegramUpdate } from '../services/telegram-bot.js';
import { listFutureDates, listGalleryPhotos, listGalleryThemes, listPlanCards, listOperatorSites, resolveOperatorSite } from '../services/operator-catalog.js';

const OWNER_CHAT = 333;

let repos: Repositories;
let db: Database.Database;
let previousRoutingJson: string;
let previousTelegramChatId: string;
let previousTelegramBotToken: string;

registerCommands();

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  // No live service: operator views read the committed CI catalog (incl. paused Coscuez).
  setDynamicService(null);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  previousTelegramChatId = env.TELEGRAM_CHAT_ID;
  previousTelegramBotToken = env.TELEGRAM_BOT_TOKEN;
  env.LEAD_ROUTING_JSON = '';
  env.TELEGRAM_CHAT_ID = String(OWNER_CHAT);
  env.TELEGRAM_BOT_TOKEN = 'test-token';
  resetRoutingConfigCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  env.TELEGRAM_CHAT_ID = previousTelegramChatId;
  env.TELEGRAM_BOT_TOKEN = previousTelegramBotToken;
  resetRoutingConfigCache();
  vi.restoreAllMocks();
  db.close();
});

function ctx(args: string[], emit?: (block: OutputBlock) => void): CommandContext {
  return { repos, args, chatId: OWNER_CHAT, emit };
}

function photosOf(blocks: OutputBlock[]): { url: string; caption?: string }[] {
  return blocks.flatMap(b => (b.kind === 'photoUrl' ? [{ url: b.url, caption: b.caption }] : []));
}

function sitesOf() {
  const raw = getOperatorCatalog();
  if (!raw) throw new Error('offline catalog missing');
  return listOperatorSites(raw);
}

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

/** Telegram API calls in order, with JSON bodies. */
function captureCalls(): { path: string; body: Record<string, unknown> | null }[] {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ path: url.slice(url.lastIndexOf('/') + 1), body });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  return calls;
}

describe('operator catalog helpers', () => {
  it('lists both sites and marks coscuez as paused', () => {
    const sites = sitesOf();
    expect(sites.find(s => s.id === 'chivor')?.active).toBe(true);
    expect(sites.find(s => s.id === 'coscuez')?.active).toBe(false);
  });

  it('resolves a site by id, name or alias ignoring accents', () => {
    const sites = sitesOf();
    expect(resolveOperatorSite(sites, 'CHIVOR')?.id).toBe('chivor');
    expect(resolveOperatorSite(sites, 'coscuéz')?.id).toBe('coscuez');
    expect(resolveOperatorSite(sites, 'marte')).toBeNull();
  });

  it('returns plan cards for a paused site without dropping its plans', () => {
    const coscuez = sitesOf().find(s => s.id === 'coscuez');
    if (!coscuez) throw new Error('coscuez missing');
    expect(listPlanCards(coscuez.site).length).toBeGreaterThan(0);
  });

  it('keeps only bookable future dates for a given reference day', () => {
    const chivor = sitesOf().find(s => s.id === 'chivor');
    if (!chivor) throw new Error('chivor missing');
    const dates = listFutureDates(chivor.site, '2000-01-01');
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every(d => d.status === 'available' || d.status === 'limited')).toBe(true);
    expect(listFutureDates(chivor.site, '9999-01-01')).toEqual([]);
  });

  it('exposes gallery themes and filters photos by theme', () => {
    const chivor = sitesOf().find(s => s.id === 'chivor');
    if (!chivor) throw new Error('chivor missing');
    expect(listGalleryThemes(chivor.site)).toContain('hotel');
    expect(listGalleryPhotos(chivor.site, 'hotel').length).toBeGreaterThan(0);
    expect(listGalleryPhotos(chivor.site, 'no-such-theme')).toEqual([]);
  });
});

describe('/plans', () => {
  it('emits one captioned card per chivor plan with prices', async () => {
    const blocks: OutputBlock[] = [];
    const text = await plansHandler(ctx(['chivor'], b => blocks.push(b)));
    const photos = photosOf(blocks);
    const chivor = sitesOf().find(s => s.id === 'chivor');
    if (!chivor) throw new Error('chivor missing');
    expect(photos.length).toBe(listPlanCards(chivor.site).filter(p => p.card).length);
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every(p => p.caption?.includes('Individual:'))).toBe(true);
    expect(text).not.toContain('PAUSADO');
  });

  it('labels every paused-site card', async () => {
    const blocks: OutputBlock[] = [];
    const text = await plansHandler(ctx(['coscuez'], b => blocks.push(b)));
    const photos = photosOf(blocks);
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every(p => p.caption?.includes('Sitio PAUSADO'))).toBe(true);
    expect(text).toContain('PAUSADO');
  });

  it('prints the site list and usage when no site is given', async () => {
    const text = await plansHandler(ctx([]));
    expect(text).toContain('Uso: /plans <sitio>');
    expect(text).toContain('chivor');
  });

  it('answers an unknown site without emitting photos', async () => {
    const blocks: OutputBlock[] = [];
    const text = await plansHandler(ctx(['marte'], b => blocks.push(b)));
    expect(text).toContain('no existe');
    expect(blocks).toEqual([]);
  });

  it('returns escaped card urls as text when the command cannot emit media', async () => {
    const text = await plansHandler(ctx(['chivor']));
    expect(text).toContain('whatsapp\\_bot');
    expect(text).not.toMatch(/[^\\]_/);
  });
});

describe('/dates', () => {
  it('lists chivor date lines without the paused label', async () => {
    const text = await datesHandler(ctx(['chivor']));
    expect(text).toContain('Fechas de');
    expect(text).not.toContain('PAUSADO');
  });

  it('labels a paused site when asked for all sites', async () => {
    const text = await datesHandler(ctx([]));
    expect(text).toContain('(PAUSADO)');
  });
});

describe('/images', () => {
  it('caps photos at twenty and captions only the last photo of each site', async () => {
    const blocks: OutputBlock[] = [];
    await imagesHandler(ctx(['hotel'], b => blocks.push(b)));
    const photos = photosOf(blocks);
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.length).toBeLessThanOrEqual(20);
    const captioned = photos.filter(p => p.caption);
    expect(captioned.length).toBeGreaterThanOrEqual(1);
    expect(photos[photos.length - 1].caption).toBeTruthy();
    expect(captioned.length).toBeLessThanOrEqual(2);
  });

  it('lists available themes per site when no theme is given', async () => {
    const text = await imagesHandler(ctx([]));
    expect(text).toContain('Uso: /images <tema> [sitio]');
    expect(text).toContain('hotel');
  });

  it('says so and lists themes for an unknown theme', async () => {
    const blocks: OutputBlock[] = [];
    const text = await imagesHandler(ctx(['spaceship'], b => blocks.push(b)));
    expect(blocks).toEqual([]);
    expect(text).toContain('Sin fotos de "spaceship"');
  });

  it('returns only catalog CDN urls when sent as text', async () => {
    const text = await imagesHandler(ctx(['hotel', 'chivor']));
    const urls = text.split('\n').filter(l => l.startsWith('http'));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(u => u.startsWith('https://cdn.andeanscapes.com/'))).toBe(true);
  });
});

describe('operator views through the Telegram dispatcher', () => {
  it('escapes Markdown in an echoed unknown site so Telegram accepts the reply', async () => {
    const calls = captureCalls();
    await processUpdate(update('/plans chivor_x'), repos);
    const sent = calls.find(c => c.path === 'sendMessage');
    expect(sent?.body?.parse_mode).toBe('Markdown');
    expect(String(sent?.body?.text)).toContain('chivor\\_x');
  });

  it('ships /images hotel as albums, never one photo per call', async () => {
    const calls = captureCalls();
    await processUpdate(update('/images hotel chivor'), repos);
    expect(calls.filter(c => c.path === 'sendMediaGroup').length).toBeGreaterThan(0);
    expect(calls.filter(c => c.path === 'sendPhoto').length).toBe(0);
  });
});

describe('DynamicDataService raw catalog', () => {
  function response(status: number): Response {
    return {
      ok: status === 200,
      status,
      headers: { get: () => (status === 200 ? 'etag-1' : null) },
      json: async () => ({ v: 3, updated: '2026-06-06T00:00:00Z', experiences: {} }),
    } as unknown as Response;
  }

  it('stores the validated payload on 200 and keeps it on 304', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(200));
    const svc = new DynamicDataService('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', 5_000);

    await svc.forceRefresh();
    const first = svc.getRawData();
    expect(first).not.toBeNull();

    fetchSpy.mockResolvedValueOnce(response(304));
    await svc.forceRefresh();
    expect(svc.getRawData()).toBe(first);
  });
});

describe('/delete with a pending payment', () => {
  it('refuses to wipe a customer whose payment reservation is pending', async () => {
    const phone = '573001112233';
    repos.conversation.upsert(phone, { first_seen_at: new Date().toISOString() });
    repos.paymentReservation.createPending({
      externalReference: 'ref-1',
      customerPhone: phone,
      expectedAmountCop: 100000,
      planId: 'core_2d1n_chivor',
      date: '2026-12-01',
      people: 2,
      transportNeed: null,
      depositPercent: 50,
      availabilityConfirmedAt: new Date().toISOString(),
    });

    const text = await deleteHandler(ctx([phone]));

    expect(text).toContain('pago pendiente');
    expect(repos.conversation.getByPhone(phone)).toBeTruthy();
    expect(repos.paymentReservation.getPendingByCustomerPhone(phone)).not.toBeNull();
  });
});
