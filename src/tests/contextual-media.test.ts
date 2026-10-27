import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env.js';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadSkills, type Skills } from '../services/skill-loader.js';
import { getActiveExperience, getSiteFallbackGalleryTheme, getTypeKeywords, isGalleryImageForPlan, scopeGalleryToPlan } from '../services/product-registry.js';
import { resolveMediaThemes } from '../services/media-marker.js';
import { followupGalleryMediaId, galleryMediaId } from '../services/media-service.js';
import { detectMediaType, detectRequestedGalleryThemes, selectContextualImage, selectThemedImage } from '../services/contextual-media.js';
import { parseEntryMarker } from '../services/entry-marker.js';
import { insertMediaSendAt } from './helpers/db-test-helpers.js';
import { useAllSitesActive } from './helpers/all-sites-catalog.js';

// The multi-site regression net runs with every destination active, as the CI
// fixture had before destinations could be paused.
beforeEach(() => {
  useAllSitesActive();
});

const ORIGINAL_ENV = {
  CONTEXTUAL_IMAGES_ENABLED: env.CONTEXTUAL_IMAGES_ENABLED,
  CONTEXTUAL_IMAGES_MIN_GAP_MINUTES: env.CONTEXTUAL_IMAGES_MIN_GAP_MINUTES,
  CONTEXTUAL_IMAGES_MAX_PER_72H: env.CONTEXTUAL_IMAGES_MAX_PER_72H,
  CONTEXTUAL_IMAGES_PROBABILITY: env.CONTEXTUAL_IMAGES_PROBABILITY,
};

describe('generic and recovery gallery themes', () => {
  it.each([
    ['chivor', 'prime_2d1n_chivor', 'mine'],
    ['coscuez', 'core_2d1n_coscuez', 'mine'],
    ['coscuez', 'prime_2d1n_coscuez', 'furaytena'],
  ])('uses the eligible catalog theme for %s / %s', (siteId, planId, theme) => {
    const skills = loadSkills();
    const experienceId = getActiveExperience(skills).id;
    expect(detectRequestedGalleryThemes(skills, 'tienes fotos de la experiencia?', experienceId, siteId, planId)).toEqual([theme]);
    expect(detectRequestedGalleryThemes(skills, 'esas no son de aca', experienceId, siteId, planId, true)).toEqual([theme]);
  });

  it('keeps unknown subjects, unchosen destinations and restricted excursions unresolved', () => {
    const skills = loadSkills();
    const experienceId = getActiveExperience(skills).id;
    expect(detectRequestedGalleryThemes(skills, 'tienes fotos del helicoptero?', experienceId, 'chivor', 'prime_2d1n_chivor')).toEqual([]);
    expect(detectRequestedGalleryThemes(skills, 'tienes fotos de la experiencia?', experienceId)).toEqual([]);
    expect(detectRequestedGalleryThemes(skills, 'esas son de otro lado', experienceId, null, null, true)).toEqual([]);
    expect(detectRequestedGalleryThemes(skills, 'fotos de Fura y Tena', experienceId, 'coscuez', 'core_2d1n_coscuez')).toEqual([]);
    expect(detectRequestedGalleryThemes(skills, 'fotos de la experiencia', experienceId, 'coscuez')).toEqual(['mine']);
  });

  it('does not invent a theme when the selected destination has no eligible photos', () => {
    const skills = loadSkills();
    const experienceId = getActiveExperience(skills).id;
    const withoutPhotos: Skills = {
      ...skills,
      dynamicMedia: { ...skills.dynamicMedia!, galleryImages: skills.dynamicMedia!.galleryImages.filter(image => image.siteId !== 'coscuez') },
    };
    expect(detectRequestedGalleryThemes(withoutPhotos, 'fotos de la experiencia', experienceId, 'coscuez', 'core_2d1n_coscuez')).toEqual([]);
  });
});

function buildSkills(): Skills {
  const base = loadSkills();
  const experienceId = getActiveExperience(base).id;
  return {
    ...base,
    andeanScapes: base.andeanScapes,
    dynamicMedia: {
      ownerImage: null,
      planImages: [],
      galleryImages: [
        { experienceId, siteId: 'chivor', url: 'https://cdn.andeanscapes.com/mine1.jpg', caption: '', type: 'mine' },
        { experienceId, siteId: 'chivor', url: 'https://cdn.andeanscapes.com/mine2.jpg', caption: '', type: 'mine' },
        { experienceId, siteId: 'chivor', url: 'https://cdn.andeanscapes.com/bike1.jpg', caption: '', type: 'bike' },
        { experienceId, siteId: 'chivor', url: 'https://cdn.andeanscapes.com/car1.jpg', caption: '', type: 'car' },
        { experienceId, siteId: 'chivor', url: 'https://cdn.andeanscapes.com/kids1.jpg', caption: '', type: 'kids' },
      ],
      siteTypes: { [`${experienceId}/chivor`]: ['mine', 'bike', 'car', 'kids', 'hotel'] },
      typeKeywords: {
        [`${experienceId}/chivor`]: {
          mine: ['mina', 'esmeraldas'],
          bike: ['moto', 'ubala'],
          car: ['4x4', 'camioneta'],
          kids: ['niños'],
        },
      },
    },
  };
}

function freshRepos(): { db: Database.Database; repos: Repositories } {
  const db = new Database(':memory:');
  migrate(db);
  return { db, repos: createRepositories(db) };
}

afterEach(() => {
  vi.restoreAllMocks();
  env.CONTEXTUAL_IMAGES_ENABLED = ORIGINAL_ENV.CONTEXTUAL_IMAGES_ENABLED;
  env.CONTEXTUAL_IMAGES_MIN_GAP_MINUTES = ORIGINAL_ENV.CONTEXTUAL_IMAGES_MIN_GAP_MINUTES;
  env.CONTEXTUAL_IMAGES_MAX_PER_72H = ORIGINAL_ENV.CONTEXTUAL_IMAGES_MAX_PER_72H;
  env.CONTEXTUAL_IMAGES_PROBABILITY = ORIGINAL_ENV.CONTEXTUAL_IMAGES_PROBABILITY;
});

beforeEach(() => {
  // Probability pinned to 1 so the random gate never makes these tests flaky.
  env.CONTEXTUAL_IMAGES_PROBABILITY = 1;
});

describe('detectMediaType', () => {
  const keywords = {
    mine: ['mina', 'esmeraldas'],
    bike: ['moto', 'ubala'],
    car: ['4x4', 'camioneta'],
  };

  it('returns null when no keyword matches', () => {
    expect(detectMediaType('¿Cuánto vale el tour?', keywords)).toBeNull();
  });

  it('matches accent-insensitive and case-insensitive keywords', () => {
    expect(detectMediaType('Quiero ir en Moto', keywords)).toBe('bike');
    expect(detectMediaType('¿Vamos por Ubalá?', keywords)).toBe('bike');
    expect(detectMediaType('Mira la mina', keywords)).toBe('mine');
  });

  it('classifies the live mine reply without a generic adventure keyword tie', () => {
    const skills = loadSkills();
    const experience = getActiveExperience(skills);
    const siteId = experience.plans[0]?.siteId;
    expect(siteId).toBeDefined();
    const keywords = getTypeKeywords(skills, experience.id, siteId);

    expect(detectMediaType(
      'El plan de la mina es ideal. Se siente la aventura de verdad, no un tour montado.',
      keywords,
    )).toBe('mine');
  });

  // The fixture's `nature` type was dropped with its only photo, which was never
  // published (404). A theme with no photos must not resolve: a cue for it promises
  // a photo the engine cannot send.
  it('resolves no theme for a route-photo request when the site has no nature gallery', () => {
    const skills = loadSkills();
    const experience = getActiveExperience(skills);
    const siteId = experience.plans[0]?.siteId;
    expect(siteId).toBeDefined();

    expect(detectRequestedGalleryThemes(
      skills,
      'Super, alguna foto de la ruta porfa',
      experience.id,
      siteId,
    )).toEqual([]);
  });

  it('matches normalized 4x4 keyword', () => {
    expect(detectMediaType('Tengo un 4x4', keywords)).toBe('car');
  });

  it('picks the type with the most distinct matched keywords', () => {
    expect(detectMediaType('Quiero ir en moto hasta Ubala por la mina', keywords)).toBe('bike');
  });

  it('returns null for equal-score ties instead of guessing a theme', () => {
    expect(detectMediaType('moto mina', keywords)).toBeNull();
  });

  it('returns null for empty or blank text', () => {
    expect(detectMediaType('', keywords)).toBeNull();
    expect(detectMediaType('   ', keywords)).toBeNull();
  });
});

describe('site-scoped contextual selection', () => {
  it('rejects an ambiguous cross-site theme and honors an explicit site', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const skills = buildSkills();
    const experienceId = getActiveExperience(skills).id;
    skills.dynamicMedia!.galleryImages.push({
      experienceId,
      siteId: 'other',
      url: 'https://cdn.andeanscapes.com/other-mine.jpg',
      caption: '',
      type: 'mine',
    });
    skills.dynamicMedia!.siteTypes[`${experienceId}/other`] = ['mine'];
    skills.dynamicMedia!.typeKeywords[`${experienceId}/other`] = { mine: ['mina'] };
    const { db, repos } = freshRepos();

    expect(selectContextualImage(skills, repos, '573001110001', 'La mina', experienceId).image).toBeNull();
    expect(selectContextualImage(
      skills,
      repos,
      '573001110001',
      'La mina',
      experienceId,
      'chivor',
    ).image?.siteId).toBe('chivor');
    expect(selectThemedImage(skills, repos, '573001110001', 'mine', experienceId)).toBeNull();
    expect(selectThemedImage(
      skills,
      repos,
      '573001110001',
      'mine',
      experienceId,
      'other',
    )?.siteId).toBe('other');
    db.close();
  });
});

describe('selectContextualImage', () => {
  const phone = '573001112233';
  const skills = buildSkills();

  it('returns nothing when the feature is disabled', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = false;
    const { db, repos } = freshRepos();
    const result = selectContextualImage(skills, repos, phone, 'Quiero ir en moto', undefined);
    expect(result.image).toBeNull();
    expect(result.type).toBeNull();
    db.close();
  });

  it('returns nothing when the probability gate is zero', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    env.CONTEXTUAL_IMAGES_PROBABILITY = 0;
    const { db, repos } = freshRepos();
    const result = selectContextualImage(skills, repos, phone, 'Quiero ir en moto hasta Ubala', undefined);
    expect(result.image).toBeNull();
    expect(result.type).toBeNull();
    db.close();
  });

  it('returns nothing while inside the minimum gap between photos', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const { db, repos } = freshRepos();
    const bike = skills.dynamicMedia!.galleryImages.find(image => image.type === 'bike')!;
    repos.mediaSend.recordSend(phone, galleryMediaId(bike));
    const result = selectContextualImage(skills, repos, phone, 'Quiero ir en moto hasta Ubala', undefined);
    expect(result.image).toBeNull();
    db.close();
  });

  // Regression: a plan image on the price turn used to suppress contextual
  // images for the whole conversation, which killed the feature in practice.
  it('is not suppressed by a plan image send', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const { db, repos } = freshRepos();
    repos.mediaSend.recordSend(phone, 'plan_core_2d1n_chivor');
    const result = selectContextualImage(skills, repos, phone, 'Quiero ir en moto hasta Ubala', undefined);
    expect(result.type).toBe('bike');
    expect(result.image).not.toBeNull();
    db.close();
  });

  // A requested gallery is stored per inbound (`requested_gallery_<id>_…`), so a
  // canonical-only eligibility check reports those photos as never sent and the
  // automatic photo repeats one the customer just asked for and received.
  it('does not repeat a photo already delivered as a requested gallery', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const { db, repos } = freshRepos();
    const bikes = skills.dynamicMedia!.galleryImages.filter(image => image.type === 'bike');
    expect(bikes.length).toBeGreaterThan(0);
    for (const bike of bikes) {
      repos.mediaSend.recordSend(phone, `requested_gallery_wamid-earlier_${galleryMediaId(bike)}`);
    }

    const result = selectContextualImage(skills, repos, phone, 'Quiero ir en moto hasta Ubala', undefined);

    expect(result.image).toBeNull();
    db.close();
  });

  it('returns nothing once the 72h volume cap of contextual sends is reached', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    env.CONTEXTUAL_IMAGES_MAX_PER_72H = 3;
    const { db, repos } = freshRepos();
    for (let index = 0; index < 3; index += 1) {
      insertMediaSendAt(db, phone, `gallery_/img${index}.jpg`, new Date(Date.now() - (40 + index) * 60 * 60 * 1000).toISOString());
    }
    const result = selectContextualImage(skills, repos, phone, 'Quiero ir en moto hasta Ubala', undefined);
    expect(result.image).toBeNull();
    db.close();
  });

  it('returns nothing for an unknown theme', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const { db, repos } = freshRepos();
    const result = selectContextualImage(skills, repos, phone, '¿Cuánto cuesta el hotel?', undefined);
    expect(result.image).toBeNull();
    expect(result.type).toBeNull();
    db.close();
  });

  it('returns exactly one image of the detected type', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const { db, repos } = freshRepos();
    const result = selectContextualImage(skills, repos, phone, 'Quiero ir en moto hasta Ubala', undefined);
    expect(result.type).toBe('bike');
    expect(result.image?.type).toBe('bike');
    db.close();
  });

  it('skips images already sent in the last 72h', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const { db, repos } = freshRepos();
    const mine1 = skills.dynamicMedia!.galleryImages.find(image => image.type === 'mine')!;
    insertMediaSendAt(db, phone, galleryMediaId(mine1), new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    const result = selectContextualImage(skills, repos, phone, 'Cuéntame de la mina y las esmeraldas', undefined);
    expect(result.type).toBe('mine');
    expect(result.image).not.toBeNull();
    expect(result.image?.url).not.toBe(mine1.url);
    db.close();
  });

  it('still sends the last allowed image when the 72h budget has room for one', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    env.CONTEXTUAL_IMAGES_MAX_PER_72H = 3;
    const { db, repos } = freshRepos();
    // 2 of the 3 allowed contextual sends are already spent and outside the
    // cooldown, so exactly one send remains.
    insertMediaSendAt(db, phone, 'gallery_/img_a.jpg', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    insertMediaSendAt(db, phone, 'gallery_/img_b.jpg', new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString());
    const result = selectContextualImage(skills, repos, phone, 'Cuéntame de la mina y las esmeraldas', undefined);
    expect(result.type).toBe('mine');
    expect(result.image).not.toBeNull();
    db.close();
  });

  it('is unaffected by the probability gate via selectThemedImage', () => {
    env.CONTEXTUAL_IMAGES_PROBABILITY = 0;
    const { db, repos } = freshRepos();
    expect(selectThemedImage(skills, repos, phone, 'mine', undefined, 'chivor')).not.toBeNull();
    db.close();
  });

  it('returns nothing when the feed has no images for the detected type', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const { db, repos } = freshRepos();
    const noHotelImages = buildSkills();
    noHotelImages.dynamicMedia = {
      ...noHotelImages.dynamicMedia!,
      typeKeywords: { chivor: { hotel: ['hotel'] } },
    };
    const result = selectContextualImage(noHotelImages, repos, phone, 'Me interesa el hotel', undefined);
    expect(result.image).toBeNull();
    db.close();
  });
});

describe('selectThemedImage', () => {
  const phone = '573004445566';
  const skills = buildSkills();

  it('returns an image of the requested type', () => {
    const { db, repos } = freshRepos();
    expect(selectThemedImage(skills, repos, phone, 'bike', undefined, 'chivor')?.type).toBe('bike');
    db.close();
  });

  // Restored original contract: without the opt-in, a theme the site has no photo
  // of returns null rather than another theme (the template header relies on it to
  // fall through to the plan card).
  it('returns null for an empty or unknown type instead of a wrong-theme image', () => {
    const { db, repos } = freshRepos();
    expect(selectThemedImage(skills, repos, phone, '', undefined, 'chivor')).toBeNull();
    expect(selectThemedImage(skills, repos, phone, 'hotel', undefined, 'chivor')).toBeNull();
    db.close();
  });

  // Opt-in (consent ask): the site has no hotel photos, so its plans' catalog
  // galleryTheme (mine) stands in, from the same site.
  it('with siteFallback, uses the site plan gallery theme when the site has no photo of the type', () => {
    const { db, repos } = freshRepos();
    const picked = selectThemedImage(skills, repos, phone, 'hotel', undefined, 'chivor', {});
    expect(picked?.type).toBe('mine');
    expect(picked?.siteId).toBe('chivor');
    expect(selectThemedImage(skills, repos, phone, 'hotle_typo', undefined, 'chivor', {})).toBeNull();
    db.close();
  });

  // The consent ask must always carry a photo, so an exhausted 72h budget reuses a
  // seen image rather than degrading the ask to plain text.
  it('reuses an already-sent image rather than returning null', () => {
    const { db, repos } = freshRepos();
    const bike = skills.dynamicMedia!.galleryImages.find(image => image.type === 'bike')!;
    repos.mediaSend.recordSend(phone, galleryMediaId(bike));
    expect(selectThemedImage(skills, repos, phone, 'bike', undefined, 'chivor')?.url).toBe(bike.url);
    db.close();
  });

  it('prefers a photo unseen in both conversation and follow-up namespaces', () => {
    const { db, repos } = freshRepos();
    const mineImages = skills.dynamicMedia!.galleryImages.filter(image => image.type === 'mine');
    const thirdMine = { ...mineImages[0], url: 'https://cdn.andeanscapes.com/mine3.jpg' };
    const threeMineSkills: Skills = {
      ...skills,
      dynamicMedia: {
        ...skills.dynamicMedia!,
        galleryImages: [...skills.dynamicMedia!.galleryImages, thirdMine],
      },
    };
    repos.mediaSend.recordSend(phone, galleryMediaId(mineImages[0]));
    repos.mediaSend.recordSend(phone, followupGalleryMediaId(mineImages[1]));

    const picked = selectThemedImage(threeMineSkills, repos, phone, 'mine', undefined, 'chivor');

    expect(picked?.url).toBe(thirdMine.url);
    db.close();
  });

  // Regression: recording follow-up photos in the `gallery_` namespace would let a
  // consent ask or template header eat the in-conversation photo budget.
  it('does not consume the contextual-image cadence or 72h budget', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    env.CONTEXTUAL_IMAGES_MAX_PER_72H = 1;
    const { db, repos } = freshRepos();

    const picked = selectThemedImage(skills, repos, phone, 'mine', undefined, 'chivor');
    expect(picked).not.toBeNull();
    repos.mediaSend.recordSend(phone, followupGalleryMediaId(picked!));

    // The in-conversation selector must still be free to send a photo.
    const contextual = selectContextualImage(skills, repos, phone, 'Cuéntame de la mina', undefined);
    expect(contextual.image).not.toBeNull();
    db.close();
  });

  // Live 2026-10-14: a Coscuez lead with no stored plan got a Chivor consent-ask
  // photo, because Coscuez had no gallery and Chivor was the only candidate site.
  it('returns null with several destinations and no known site, even when one site has photos', () => {
    const skills = buildSkills();
    const { db, repos } = freshRepos();
    expect(selectThemedImage(skills, repos, phone, 'mine', undefined)).toBeNull();
    expect(selectThemedImage(skills, repos, phone, 'mine', undefined, 'coscuez')).toBeNull();
    expect(selectThemedImage(skills, repos, phone, 'mine', undefined, 'chivor')?.siteId).toBe('chivor');
    db.close();
  });

  it('returns null when image sending is disabled', () => {
    const previous = env.SEND_IMAGES_ENABLED;
    env.SEND_IMAGES_ENABLED = false;
    const { db, repos } = freshRepos();
    expect(selectThemedImage(skills, repos, phone, 'bike', undefined, 'chivor')).toBeNull();
    env.SEND_IMAGES_ENABLED = previous;
    db.close();
  });
});

describe('selectContextualImage with entry marker filtering', () => {
  const phone = '573004445566';
  const experienceId = getActiveExperience(loadSkills()).id;

  it.each([
    ['C01', 'mine', 'La mina'], ['C02', 'car', 'La camioneta'], ['C03', 'bike', 'La moto'], ['C04', 'kids', 'Los niños'],
    ['H01', 'mine', 'La mina'], ['H02', 'car', 'La camioneta'], ['H03', 'bike', 'La moto'], ['H04', 'kids', 'Los niños'],
    ['R01', 'mine', 'La mina'], ['R02', 'car', 'La camioneta'], ['R03', 'bike', 'La moto'], ['R04', 'kids', 'Los niños'],
  ])('uses the %s mapping before plan selection when the reply matches', (code, expectedType, replyText) => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const skills = buildSkills();
    const { db, repos } = freshRepos();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = selectContextualImage(
      skills,
      repos,
      phone,
      replyText,
      experienceId,
      undefined,
      parseEntryMarker(code),
    );
    expect(result.image?.type).toBe(expectedType);
    db.close();
  });

  it('selects the strongest configured reply match and rejects a tie', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const skills = buildSkills();
    const marker = parseEntryMarker('C02');
    const first = freshRepos();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(selectContextualImage(
      skills, first.repos, phone, 'La camioneta llega a la mina de esmeraldas', experienceId, 'chivor', marker,
    ).type).toBe('mine');
    first.db.close();

    const second = freshRepos();
    expect(selectContextualImage(
      skills, second.repos, phone, 'La camioneta llega a la mina', experienceId, 'chivor', marker,
    )).toEqual({ image: null, type: null });
    second.db.close();
  });

  it('does not substitute a weaker configured theme when the strongest has no unseen photos', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const skills = buildSkills();
    const { db, repos } = freshRepos();
    const car = skills.dynamicMedia!.galleryImages.find(image => image.type === 'car')!;
    repos.mediaSend.recordSend(phone, `requested_gallery_earlier_${galleryMediaId(car)}`);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = selectContextualImage(
      skills, repos, phone, 'La camioneta 4x4 llega a la mina', experienceId, 'chivor', parseEntryMarker('C02'),
    );

    expect(result).toEqual({ image: null, type: null });
    db.close();
  });

  it('does not caption a segment image with unrelated reply text', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const skills = buildSkills();
    const { db, repos } = freshRepos();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = selectContextualImage(
      skills, repos, phone, 'Listo, cuéntame más', experienceId, undefined, parseEntryMarker('C04'),
    );

    expect(result).toEqual({ image: null, type: null });
    db.close();
  });

  it('uses reply-keyword detection when the marker has no configured segment', () => {
    env.CONTEXTUAL_IMAGES_ENABLED = true;
    const skills = buildSkills();
    const { db, repos } = freshRepos();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = selectContextualImage(
      skills, repos, phone, 'Voy en moto', experienceId, undefined, parseEntryMarker('C99'),
    );

    expect(result.image?.type).toBe('bike');
    db.close();
  });
});

// Coscuez has mine/hotel photos only; kids/bike/car/beekeeping are not shot yet.
// A request the site cannot honour must still ship that site's own photos.
describe('site gallery fallback (site missing a photo category)', () => {
  const phone = '573004445599';

  function coscuezSkills(planTheme: string | undefined): Skills {
    const base = loadSkills();
    const experience = getActiveExperience(base);
    const experiences = base.andeanScapes.experiences.map(exp => exp.id !== experience.id ? exp : {
      ...exp,
      plans: exp.plans.map(plan => plan.siteId === 'coscuez' ? { ...plan, galleryTheme: planTheme } : plan),
    });
    const coscuezImage = (file: string, type: string) => ({
      experienceId: experience.id, siteId: 'coscuez', url: `https://cdn.andeanscapes.com/${file}`, caption: '', type,
    });
    return {
      ...base,
      andeanScapes: { ...base.andeanScapes, experiences },
      dynamicMedia: {
        ownerImage: null,
        planImages: [],
        galleryImages: [
          { experienceId: experience.id, siteId: 'chivor', url: 'https://cdn.andeanscapes.com/chivor-kids.jpg', caption: '', type: 'kids' },
          { experienceId: experience.id, siteId: 'chivor', url: 'https://cdn.andeanscapes.com/chivor-mine.jpg', caption: '', type: 'mine' },
          coscuezImage('coscuez-mine.jpg', 'mine'),
          coscuezImage('coscuez-hotel.jpg', 'hotel'),
        ],
        siteTypes: {
          [`${experience.id}/chivor`]: ['mine', 'kids'],
          [`${experience.id}/coscuez`]: ['mine', 'hotel'],
        },
        typeKeywords: {},
      },
    };
  }

  const experienceId = (skills: Skills): string => getActiveExperience(skills).id;
  const coscuezPlanId = (skills: Skills): string =>
    getActiveExperience(skills).plans.find(plan => plan.siteId === 'coscuez')!.id;

  it('derives the fallback from the site plans, only when that theme has photos there', () => {
    const skills = coscuezSkills('mine');
    expect(getSiteFallbackGalleryTheme(skills, experienceId(skills), 'coscuez')).toBe('mine');
    expect(getSiteFallbackGalleryTheme(skills, experienceId(skills), 'coscuez', coscuezPlanId(skills))).toBe('mine');
    expect(getSiteFallbackGalleryTheme(coscuezSkills('kids'), experienceId(skills), 'coscuez')).toBeNull();
    expect(getSiteFallbackGalleryTheme(coscuezSkills(undefined), experienceId(skills), 'coscuez')).toBeNull();
    expect(getSiteFallbackGalleryTheme(skills, experienceId(skills), null)).toBeNull();
  });

  it('a [[FOTOS:kids]] marker for Coscuez ships Coscuez mine photos, never Chivor kids', () => {
    const skills = coscuezSkills('mine');
    const fallback = getSiteFallbackGalleryTheme(skills, experienceId(skills), 'coscuez');
    expect(resolveMediaThemes(skills, ['kids'], experienceId(skills), 'coscuez', fallback))
      .toEqual([{ siteId: 'coscuez', type: 'mine' }]);
  });

  it('keeps a theme the site does have, and leaves Chivor untouched', () => {
    const skills = coscuezSkills('mine');
    const fallback = getSiteFallbackGalleryTheme(skills, experienceId(skills), 'coscuez');
    expect(resolveMediaThemes(skills, ['hotel'], experienceId(skills), 'coscuez', fallback))
      .toEqual([{ siteId: 'coscuez', type: 'hotel' }]);
    expect(resolveMediaThemes(skills, ['kids'], experienceId(skills), 'chivor', null))
      .toEqual([{ siteId: 'chivor', type: 'kids' }]);
  });

  it('without a plan gallery theme the old behaviour stands: nothing resolves', () => {
    const skills = coscuezSkills(undefined);
    const fallback = getSiteFallbackGalleryTheme(skills, experienceId(skills), 'coscuez');
    expect(resolveMediaThemes(skills, ['kids'], experienceId(skills), 'coscuez', fallback)).toEqual([]);
  });

  it('never falls back for an invented theme, so the unhonoured-marker alert still fires', () => {
    const skills = coscuezSkills('mine');
    const fallback = getSiteFallbackGalleryTheme(skills, experienceId(skills), 'coscuez');
    expect(resolveMediaThemes(skills, ['no_such_theme'], experienceId(skills), 'coscuez', fallback)).toEqual([]);
  });

  // Two destinations, none chosen: a theme only Chivor has must not ship Chivor's
  // photos to this lead, nor be cued to the model.
  it('resolves and cues nothing on a multi-site experience with no destination chosen', () => {
    const skills = coscuezSkills('mine');
    expect(resolveMediaThemes(skills, ['kids'], experienceId(skills), null, null)).toEqual([]);
    expect(resolveMediaThemes(skills, ['mine'], experienceId(skills), null, null)).toEqual([]);
    expect(detectRequestedGalleryThemes(skills, 'fotos de los ninos', experienceId(skills), null)).toEqual([]);
    expect(resolveMediaThemes(skills, ['kids'], experienceId(skills), 'chivor', null))
      .toEqual([{ siteId: 'chivor', type: 'kids' }]);
  });

  it('never falls back without a known site', () => {
    const skills = coscuezSkills('mine');
    expect(resolveMediaThemes(skills, ['bike'], experienceId(skills), null, 'mine')).toEqual([]);
  });

  it('the consent-ask photo for a Coscuez lead uses Coscuez mine photos when kids is configured', () => {
    const { db, repos } = freshRepos();
    const skills = coscuezSkills('mine');
    const picked = selectThemedImage(skills, repos, phone, 'kids', undefined, 'coscuez', { planId: coscuezPlanId(skills) });
    expect(picked?.url).toBe('https://cdn.andeanscapes.com/coscuez-mine.jpg');
    // Template header path (no opt-in) keeps null so the plan card wins.
    expect(selectThemedImage(skills, repos, phone, 'kids', undefined, 'coscuez')).toBeNull();
    db.close();
  });
});

// Fura y Tena is a PRIME-only Coscuez excursion: photos tagged planIds reach only
// that plan, and the site fallback never substitutes a plan-specific theme.
describe('plan-restricted gallery photos', () => {
  const phone = '573004445588';

  function primeExcursionSkills(): { skills: Skills; core: string; prime: string } {
    const base = loadSkills();
    const experience = getActiveExperience(base);
    const coscuezPlans = experience.plans.filter(plan => plan.siteId === 'coscuez');
    const prime = coscuezPlans.find(plan => plan.id.startsWith('prime'))!.id;
    const core = coscuezPlans.find(plan => plan.id.startsWith('core'))!.id;
    const experiences = base.andeanScapes.experiences.map(exp => exp.id !== experience.id ? exp : {
      ...exp,
      plans: exp.plans.map(plan => plan.siteId !== 'coscuez' ? plan : { ...plan, galleryTheme: plan.id === prime ? 'furaytena' : 'mine' }),
    });
    const image = (file: string, type: string, planIds?: string[]) => ({
      experienceId: experience.id, siteId: 'coscuez', url: `https://cdn.andeanscapes.com/${file}`, caption: '', type,
      ...(planIds ? { planIds } : {}),
    });
    const skills: Skills = {
      ...base,
      andeanScapes: { ...base.andeanScapes, experiences },
      dynamicMedia: {
        ownerImage: null,
        planImages: [],
        galleryImages: [image('mine.jpg', 'mine'), image('fura.jpg', 'furaytena', [prime])],
        siteTypes: { [`${experience.id}/coscuez`]: ['mine', 'furaytena'] },
        typeKeywords: { [`${experience.id}/coscuez`]: { mine: ['mina'], furaytena: ['fura'] } },
      },
    };
    return { skills, core, prime };
  }

  it('isGalleryImageForPlan: unrestricted for everyone, restricted only for listed plans', () => {
    const open = { url: 'u', caption: '' };
    const prime = { url: 'u', caption: '', planIds: ['prime'] };
    expect(isGalleryImageForPlan(open, null)).toBe(true);
    expect(isGalleryImageForPlan(prime, 'prime')).toBe(true);
    expect(isGalleryImageForPlan(prime, 'core')).toBe(false);
    expect(isGalleryImageForPlan(prime, null)).toBe(false);
  });

  it('scopeGalleryToPlan drops the excursion for CORE and keeps it for PRIME', () => {
    const { skills, core, prime } = primeExcursionSkills();
    const types = (scoped: Skills) => scoped.dynamicMedia!.galleryImages.map(image => image.type);
    expect(types(scopeGalleryToPlan(skills, core))).toEqual(['mine']);
    expect(types(scopeGalleryToPlan(skills, null))).toEqual(['mine']);
    expect(types(scopeGalleryToPlan(skills, prime))).toEqual(['mine', 'furaytena']);
  });

  it('the fallback is never the plan-only theme: PRIME falls back to mine', () => {
    const { skills, core, prime } = primeExcursionSkills();
    const experienceId = getActiveExperience(skills).id;
    expect(getSiteFallbackGalleryTheme(skills, experienceId, 'coscuez', prime)).toBe('mine');
    expect(getSiteFallbackGalleryTheme(skills, experienceId, 'coscuez', core)).toBe('mine');
    expect(getSiteFallbackGalleryTheme(skills, experienceId, 'coscuez')).toBe('mine');
  });

  it('a CORE consent-ask photo configured as furaytena falls back to mine, never the excursion', () => {
    const { skills, core } = primeExcursionSkills();
    const { db, repos } = freshRepos();
    const picked = selectThemedImage(scopeGalleryToPlan(skills, core), repos, phone, 'furaytena', undefined, 'coscuez', { planId: core });
    expect(picked?.url).toBe('https://cdn.andeanscapes.com/mine.jpg');
    db.close();
  });
});
