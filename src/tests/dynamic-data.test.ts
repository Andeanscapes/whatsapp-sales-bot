import { describe, expect, it } from 'vitest';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { shouldStripStaticPricing } from '../services/dynamic-data-service.js';
import { loadSkills } from '../services/skill-loader.js';

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
    expect(shouldStripStaticPricing('https://cdn.andeanscapes.com/bot/bot-dynamic.json', false)).toBe(true);
    expect(shouldStripStaticPricing('https://cdn.andeanscapes.com/bot/bot-dynamic.json', true)).toBe(false);
  });

  it('keeps static pricing when no dynamic service is configured', () => {
    const skills = loadSkills();
    expect(skills.andeanScapes.experiences[0].pricing.items.length).toBeGreaterThan(0);
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
          url: 'https://cdn.andeanscapes.com/whatsapp_bot/2d1n_1.png',
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
