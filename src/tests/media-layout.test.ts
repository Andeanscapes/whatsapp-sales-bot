import { describe, expect, it } from 'vitest';
import { restructureCatalog } from '../scripts/media-restructure.js';
import {
  LEGACY_OWNER_KEY,
  OWNER_KEY,
  galleryKey,
  legacyPlanCardTier,
  planCardKey,
} from '../scripts/lib/media-layout.js';

const CDN = 'https://cdn.andeanscapes.com';

describe('media layout keys', () => {
  it('names gallery files by their two-digit number inside a type folder', () => {
    expect(galleryKey('emerald_mining_tour', 'chivor', 'mine', 'whatsapp_bot/emerald_mining_chivor/exp/exp_07.jpg')).toBe(
      'whatsapp_bot/media/emerald_mining_tour/chivor/gallery/mine/07.jpg',
    );
  });

  it('keeps a non-standard gallery file name', () => {
    expect(galleryKey('emerald_mining_tour', 'chivor', 'food', 'whatsapp_bot/x/cena.jpg')).toBe(
      'whatsapp_bot/media/emerald_mining_tour/chivor/gallery/food/cena.jpg',
    );
  });

  it('puts plan cards under the tier folder', () => {
    expect(planCardKey('emerald_mining_tour', 'coscuez', 'prime')).toBe(
      'whatsapp_bot/media/emerald_mining_tour/coscuez/plans/prime/card.png',
    );
    expect(OWNER_KEY).toBe('whatsapp_bot/media/brand/owner.jpg');
  });

  it('reads the tier of a legacy card only when its site matches', () => {
    expect(legacyPlanCardTier('whatsapp_bot/details/core_2d1n_chivor_1.png', 'chivor')).toBe('core');
    expect(legacyPlanCardTier('whatsapp_bot/details/prime_2d1n_coscuez.png', 'coscuez')).toBe('prime');
    expect(legacyPlanCardTier('whatsapp_bot/details/prime_2d1n_coscuez.png', 'chivor')).toBeNull();
    expect(legacyPlanCardTier('whatsapp_bot/details/other.png', 'chivor')).toBeNull();
  });
});

const catalog = {
  media: {
    ownerImage: { url: `${CDN}/${LEGACY_OWNER_KEY}`, caption: 'Owner' },
  },
  experiences: {
    emerald_mining_tour: {
      sites: {
        chivor: {
          media: {
            gallery: [
              { url: `${CDN}/whatsapp_bot/emerald_mining_chivor/exp/exp_01.jpg`, caption: 'Mina', type: 'mine' },
              { url: `${CDN}/whatsapp_bot/emerald_mining_chivor/exp/exp_02.jpg`, caption: 'Hotel', type: 'hotel' },
              { url: `${CDN}/whatsapp_bot/emerald_mining_chivor/exp/exp_03.jpg`, caption: 'Sin tipo' },
            ],
          },
          plans: {
            core_2d1n_chivor: {
              media: {
                planImages: [
                  { id: 'core_2d1n_preview', url: `${CDN}/whatsapp_bot/details/core_2d1n_chivor_1.png`, caption: 'Core' },
                ],
              },
            },
          },
        },
      },
    },
  },
};

describe('restructureCatalog', () => {
  const result = restructureCatalog(catalog);
  const out = result.catalog as typeof catalog;

  it('rewrites owner, typed gallery items and plan cards to the new layout', () => {
    expect(out.media.ownerImage.url).toBe(`${CDN}/${OWNER_KEY}`);
    expect(out.experiences.emerald_mining_tour.sites.chivor.media.gallery[0].url).toBe(
      `${CDN}/whatsapp_bot/media/emerald_mining_tour/chivor/gallery/mine/01.jpg`,
    );
    expect(out.experiences.emerald_mining_tour.sites.chivor.plans.core_2d1n_chivor.media.planImages[0].url).toBe(
      `${CDN}/whatsapp_bot/media/emerald_mining_tour/chivor/plans/core/card.png`,
    );
  });

  it('leaves an untyped gallery item in place and reports it', () => {
    expect(out.experiences.emerald_mining_tour.sites.chivor.media.gallery[2].url).toBe(
      `${CDN}/whatsapp_bot/emerald_mining_chivor/exp/exp_03.jpg`,
    );
    expect(result.unmapped).toEqual(['whatsapp_bot/emerald_mining_chivor/exp/exp_03.jpg']);
  });

  it('keeps captions, ids and order unchanged', () => {
    const gallery = out.experiences.emerald_mining_tour.sites.chivor.media.gallery;
    expect(gallery.map((item) => item.caption)).toEqual(['Mina', 'Hotel', 'Sin tipo']);
    expect(out.experiences.emerald_mining_tour.sites.chivor.plans.core_2d1n_chivor.media.planImages[0].id).toBe(
      'core_2d1n_preview',
    );
  });

  it('is idempotent: a second run rewrites nothing', () => {
    const again = restructureCatalog(out);
    expect(again.rewrites).toEqual([]);
    expect(again.catalog).toEqual(out);
  });
});

describe('restructureCatalog key segments', () => {
  it('leaves an item whose type would escape its folder unmapped', () => {
    const legacy = 'whatsapp_bot/emerald_mining_chivor/exp/exp_09.jpg';
    const hostile = {
      experiences: {
        emerald_mining_tour: {
          sites: { chivor: { media: { gallery: [{ url: `${CDN}/${legacy}`, type: '../../../../x' }] } } },
        },
      },
    };
    const result = restructureCatalog(hostile);
    expect(result.rewrites).toEqual([]);
    expect(result.unmapped).toEqual([legacy]);
  });
});
