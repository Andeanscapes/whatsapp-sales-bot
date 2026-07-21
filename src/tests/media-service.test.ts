import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { galleryMediaId, selectEligibleGalleryImages, selectGalleryImages } from '../services/media-service.js';

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
});
