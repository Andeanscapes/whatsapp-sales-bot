import { afterEach, describe, expect, it, vi } from 'vitest';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { DynamicDataService, shouldStripStaticPricing } from '../services/dynamic-data-service.js';
import { loadSkills, isDynamicDataFresh, setDynamicService, refreshSkills, getSkills } from '../services/skill-loader.js';

describe('dynamic data validation', () => {
  it('rejects unknown fields', () => {
    const data = {
      v: 1,
      updated: '2026-05-30T00:00:00Z',
      extra: true,
      experiences: {},
    };

    expect(() => dynamicDataSchema.parse(data)).toThrow();
  });

  it('strips static pricing only when dynamic URL is configured and unavailable', () => {
    expect(shouldStripStaticPricing('', false)).toBe(false);
    expect(shouldStripStaticPricing('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', false)).toBe(true);
    expect(shouldStripStaticPricing('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', true)).toBe(false);
  });

  it('has no static pricing items when no dynamic service is configured', () => {
    const skills = loadSkills();
    // Static skill JSON intentionally has no pricing items — remote is the sole source.
    expect(skills.andeanScapes.experiences[0].pricing.items.length).toBe(0);
    expect(skills.andeanScapes.experiences[0].pricing.botRules).toContain('PRICING_NOT_AVAILABLE');
  });

  it('accepts valid dynamic media config', () => {
    const parsed = dynamicDataSchema.parse({
      v: 2,
      updated: '2026-05-30T00:00:00Z',
      media: {
        ownerImage: {
          url: 'https://cdn.andeanscapes.com/whatsapp_bot/emerald_mining_chivor/heinneryalexandra.jpg',
          caption: 'Heinner y Alexandra — Andean Scapes',
        },
        planImages: [{
          id: 'emerald_mining_preview_1',
          experienceId: 'emerald_mining_tour',
          planId: '2d1n_mining',
          url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/2d1n_1.png',
          caption: 'Imagen de referencia del plan 2D/1N',
        }],
        galleryImages: [{
          url: 'https://cdn.andeanscapes.com/whatsapp_bot/emerald_mining_chivor/gallery_1.jpg',
          caption: 'Galeria',
        }],
      },
      experiences: {},
    });

    expect(parsed.media?.ownerImage?.url).toContain('heinneryalexandra.jpg');
    expect(parsed.media?.planImages).toHaveLength(1);
    expect(parsed.media?.galleryImages).toHaveLength(1);
  });

  it('rejects invalid dynamic media urls', () => {
    expect(() => dynamicDataSchema.parse({
      v: 2,
      updated: '2026-05-30T00:00:00Z',
      media: {
        ownerImage: { url: 'not-a-url' },
        planImages: [],
      },
      experiences: {},
    })).toThrow();
  });

  it('rejects dynamic media urls outside the Andean Scapes CDN', () => {
    expect(() => dynamicDataSchema.parse({
      v: 3,
      updated: '2026-05-30T00:00:00Z',
      media: {
        galleryImages: [{ url: 'https://evil.example.com/gallery.jpg' }],
      },
      experiences: {},
    })).toThrow();
  });
});

describe('DynamicDataService refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function okResponse(): Response {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ v: 3, updated: '2026-06-06T00:00:00Z', experiences: {} }),
    } as unknown as Response;
  }

  it('refreshIfStale skips refetch within the throttle window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const svc = new DynamicDataService('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', 5000);

    await svc.refreshIfStale();
    await svc.refreshIfStale();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh fetches even within the throttle window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const svc = new DynamicDataService('https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json', 5000);

    await svc.refreshIfStale();
    await svc.forceRefresh();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('DynamicDataService lastFetchOk', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const URL = 'https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json';

  function response(overrides: Partial<Response> & { jsonBody?: unknown }): Response {
    const { jsonBody, ...rest } = overrides;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => jsonBody ?? { v: 3, updated: '2026-06-06T00:00:00Z', experiences: {} },
      ...rest,
    } as unknown as Response;
  }

  it('starts false before any fetch', () => {
    const svc = new DynamicDataService(URL, 5000);
    expect(svc.lastFetchOk).toBe(false);
  });

  it('is true after a successful 200 fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ status: 200 }));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(true);
  });

  it('is true after a 304 not-modified response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ status: 304 }));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(true);
  });

  it('is false after a 500 error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ok: false, status: 500 }));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
  });

  it('is false after a network/fetch throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
  });

  it('is false after invalid JSON (ZodError)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ status: 200, jsonBody: { v: 1, updated: '2026-06-06T00:00:00Z', extra: true, experiences: {} } }),
    );
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
  });

  it('flips back to false when a good fetch is followed by a failed one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ status: 200 }))
      .mockResolvedValueOnce(response({ ok: false, status: 503 }));
    const svc = new DynamicDataService(URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(true);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('isDynamicDataFresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setDynamicService(null);
  });

  it('returns true when no dynamic service is configured', () => {
    setDynamicService(null);
    expect(isDynamicDataFresh()).toBe(true);
  });

  it('mirrors the service lastFetchOk when a service is configured', async () => {
    const url = 'https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ v: 3, updated: '2026-06-06T00:00:00Z', experiences: {} }),
    } as unknown as Response);
    const svc = new DynamicDataService(url, 5000);
    setDynamicService(svc);

    expect(isDynamicDataFresh()).toBe(false);
    await svc.forceRefresh();
    expect(isDynamicDataFresh()).toBe(true);
  });
});

describe('business rules merge with dynamic pricing', () => {
  const URL = 'https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json';

  afterEach(() => {
    vi.restoreAllMocks();
    setDynamicService(null);
    loadSkills(); // reset cached skills to static baseline
  });

  it('applies remote pricing rules ALONGSIDE static business rules and drops the sentinel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({
        v: 3, updated: '2026-06-06T00:00:00Z',
        experiences: {
          emerald_mining_tour: {
            pricing: {
              currency: 'COP',
              plans: { '2d1n_mining': { individual: 550000, couple: 1040000 } },
              rules: 'REMOTE_RULE: 15% deposito via Nequi',
            },
            availability: { tz: 'America/Bogota', dates: [], rule: 'REMOTE_AVAIL_RULE' },
          },
        },
      }),
    } as unknown as Response);

    loadSkills();
    const svc = new DynamicDataService(URL, 5000);
    setDynamicService(svc);
    await svc.forceRefresh();
    await refreshSkills(true);

    const pricing = getSkills().andeanScapes.experiences[0].pricing;
    // Remote numbers present.
    expect(pricing.items.some(i => i.couplePrice === 1040000)).toBe(true);
    // Remote rule applied.
    expect(pricing.botRules).toContain('REMOTE_RULE: 15% deposito via Nequi');
    // Static business rule applied ALONGSIDE remote.
    expect(pricing.botRules.some(r => r.includes('5+ personas'))).toBe(true);
    expect(pricing.botRules.some(r => r.includes('Nunca inventes descuentos'))).toBe(true);
    // Sentinel never leaks once pricing is available.
    expect(pricing.botRules).not.toContain('PRICING_NOT_AVAILABLE');
  });
});
