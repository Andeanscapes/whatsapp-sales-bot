import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { galleryMediaId, galleryMediaIdFromUrl, hasShownLlmGallery, markLlmGalleryShown, releaseImageReservation, remainingGalleryImageBudget, REQUESTED_GALLERY_MEDIA_ID_PREFIX, reserveImageSend, reserveRequestedGalleryImageSend, selectBalancedByCategory, selectEligibleGalleryImages, selectGalleryImages } from '../services/media-service.js';

const originalCap = env.MAX_GALLERY_IMAGES_PER_SEND;
const gallery = Array.from({ length: 12 }, (_, index) => ({
  url: `https://cdn.example.com/gallery/${index + 1}.jpg`,
  caption: `Gallery ${index + 1}`,
}));

afterEach(() => {
  env.MAX_GALLERY_IMAGES_PER_SEND = originalCap;
});

describe('initial gallery cap', () => {
  it('limits the first gallery selection to the configured cap', () => {
    env.MAX_GALLERY_IMAGES_PER_SEND = 3;

    const selected = selectGalleryImages(gallery);

    expect(selected).toHaveLength(3);
    expect(new Set(selected.map(image => image.url)).size).toBe(3);
    expect(selected.every(image => gallery.some(candidate => candidate.url === image.url))).toBe(true);
  });

  it('never selects more than the hard cap of five', () => {
    env.MAX_GALLERY_IMAGES_PER_SEND = 10;

    expect(selectGalleryImages(gallery)).toHaveLength(5);
  });

  it('limits a review reminder gallery to three unsent images', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112233';
    repos.mediaSend.recordSend(phone, galleryMediaId(gallery[0]));

    const selected = selectEligibleGalleryImages(repos, phone, gallery, 3);

    expect(selected).toHaveLength(3);
    expect(selected.map(galleryMediaId)).not.toContain(galleryMediaId(gallery[0]));
    db.close();
  });

  it('fills the cap from eligible images when previously sent images appear first', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112233';
    env.MAX_GALLERY_IMAGES_PER_SEND = 3;
    gallery.slice(0, 3).forEach(image => repos.mediaSend.recordSend(phone, galleryMediaId(image)));

    const selected = selectEligibleGalleryImages(repos, phone, gallery, 3);

    expect(selected).toHaveLength(3);
    expect(selected.map(galleryMediaId)).not.toContain(galleryMediaId(gallery[0]));
    expect(selected.map(galleryMediaId)).not.toContain(galleryMediaId(gallery[1]));
    expect(selected.map(galleryMediaId)).not.toContain(galleryMediaId(gallery[2]));
    db.close();
  });

  it('atomically reserves one same-image send and allows a definite-failure release', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112233';

    const first = reserveImageSend(repos, phone, 'plan-image');
    expect(first).not.toBeNull();
    expect(reserveImageSend(repos, phone, 'plan-image')).toBeNull();

    releaseImageReservation(repos, first!);
    expect(reserveImageSend(repos, phone, 'plan-image')).not.toBeNull();
    db.close();
  });
});

describe('reserveRequestedGalleryImageSend', () => {
  it('scopes claims to the inbound message so later requests may repeat a photo', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112255';

    expect(reserveRequestedGalleryImageSend(repos, phone, 'gallery_/a.jpg', 'wamid-1')).not.toBeNull();
    expect(reserveImageSend(repos, phone, 'gallery_/a.jpg')).not.toBeNull();
    expect(reserveRequestedGalleryImageSend(repos, phone, 'gallery_/a.jpg', 'wamid-2')).not.toBeNull();
    db.close();
  });

  // Scope of this claim: the SAME photo cannot ship twice while one inbound is
  // processed. A replayed webhook is not stopped here (it selects other photos and
  // gets other keys) — `repos.dedupe` drops Meta retries before the engine runs.
  it('honours repeated requests but blocks the same photo twice within one inbound', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112266';

    expect(reserveRequestedGalleryImageSend(repos, phone, 'gallery_/a.jpg', 'wamid-1')).not.toBeNull();
    expect(reserveRequestedGalleryImageSend(repos, phone, 'gallery_/a.jpg', 'wamid-1')).toBeNull();
    expect(reserveRequestedGalleryImageSend(repos, phone, 'gallery_/a.jpg', 'wamid-2')).not.toBeNull();
    db.close();
  });

  it('allows an arbitrary number of later requests for the same photo', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112299';
    const claims = [0, 1, 2].map(index => reserveRequestedGalleryImageSend(repos, phone, 'gallery_/a.jpg', `wamid-${index}`));

    expect(claims.filter(id => id != null)).toHaveLength(3);
    db.close();
  });

  it('returns null when image sends are disabled', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const previous = env.SEND_IMAGES_ENABLED;
    try {
      env.SEND_IMAGES_ENABLED = false;
      expect(reserveRequestedGalleryImageSend(repos, '573001112277', 'gallery_/a.jpg')).toBeNull();
    } finally {
      env.SEND_IMAGES_ENABLED = previous;
      db.close();
    }
  });
});

describe('LLM gallery state', () => {
  it('records a delivered gallery once for future prompt turns', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112211';

    expect(hasShownLlmGallery(repos, phone)).toBe(false);
    markLlmGalleryShown(repos, phone);
    markLlmGalleryShown(repos, phone);
    expect(hasShownLlmGallery(repos, phone)).toBe(true);
    db.close();
  });
});

describe('gallery budget', () => {
  it('counts requested and canonical gallery sends independently from text limits', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112212';
    const previousHour = env.MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_HOUR;
    const previousDay = env.MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_DAY;
    try {
      env.MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_HOUR = 3;
      env.MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_DAY = 4;
      repos.mediaSend.recordSend(phone, 'gallery_/mine-1.jpg');
      repos.mediaSend.recordSend(phone, 'requested_gallery_wamid-1_gallery_/mine-2.jpg');
      expect(remainingGalleryImageBudget(repos, phone)).toBe(1);
    } finally {
      env.MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_HOUR = previousHour;
      env.MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_DAY = previousDay;
      db.close();
    }
  });
});

describe('galleryMediaIdFromUrl', () => {
  it('shares the namespace used by galleryMediaId', () => {
    expect(galleryMediaIdFromUrl(gallery[0].url)).toBe(galleryMediaId(gallery[0]));
  });

  it('returns null for a malformed url instead of throwing', () => {
    expect(galleryMediaIdFromUrl('not-a-url')).toBeNull();
  });
});

describe('selectBalancedByCategory', () => {
  it('tops up an explicit request from seen photos of the same category', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112244';
    const typedGallery = gallery.slice(0, 6).map(image => ({
      ...image,
      type: 'hotel',
      experienceId: 'test',
      siteId: 'test',
    }));
    typedGallery.slice(0, 5).forEach(image => repos.mediaSend.recordSend(phone, galleryMediaId(image)));

    const selected = selectBalancedByCategory(
      repos,
      phone,
      typedGallery,
      [{ siteId: 'test', type: 'hotel' }],
      5,
    );

    expect(selected).toHaveLength(5);
    expect(new Set(selected.map(image => image.url)).size).toBe(5);
    expect(selected.every(image => image.type === 'hotel')).toBe(true);
    db.close();
  });

  it('never selects another site that shares the requested type', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const images = [
      { ...gallery[0], type: 'hotel', experienceId: 'test', siteId: 'chivor' },
      { ...gallery[1], type: 'hotel', experienceId: 'test', siteId: 'other' },
    ];

    const selected = selectBalancedByCategory(
      repos,
      '573001112233',
      images,
      [{ siteId: 'chivor', type: 'hotel' }],
      5,
    );

    expect(selected).toEqual([expect.objectContaining({ siteId: 'chivor' })]);
    db.close();
  });

  // '_' is a single-char wildcard in SQL LIKE, and both the namespace prefix and
  // the gallery id are full of them, so a LIKE lookup reports a DIFFERENT photo as
  // already sent and permanently drops it from the unseen pool.
  it('does not treat a similarly-named photo as the same image', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112235';
    const target = { url: 'https://cdn.example.com/a/b.jpg', caption: '', type: 'hotel', experienceId: 'test', siteId: 'test' };
    // Same shape, one character different where LIKE would wildcard-match.
    repos.mediaSend.recordSend(phone, 'requested_gallery_w1_galleryX/a/b.jpg');

    const selected = selectBalancedByCategory(
      repos,
      phone,
      [target],
      [{ siteId: 'test', type: 'hotel' }],
      1,
    );

    expect(selected.map(image => image.url)).toEqual([target.url]);
    expect(repos.mediaSend.getLastSentAtForImage(phone, galleryMediaId(target), REQUESTED_GALLERY_MEDIA_ID_PREFIX)).toBeNull();
    db.close();
  });

  it('treats requested-gallery claims as seen during later rotation', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112234';
    const images = gallery.slice(0, 3).map(image => ({
      ...image,
      type: 'hotel',
      experienceId: 'test',
      siteId: 'test',
    }));
    reserveRequestedGalleryImageSend(repos, phone, galleryMediaId(images[0]), 'wamid-first');

    const selected = selectBalancedByCategory(
      repos,
      phone,
      images,
      [{ siteId: 'test', type: 'hotel' }],
      2,
    );

    expect(selected.map(image => image.url)).not.toContain(images[0].url);
    db.close();
  });
});
