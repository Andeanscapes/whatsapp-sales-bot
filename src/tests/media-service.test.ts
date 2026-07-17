import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { selectGalleryImages } from '../services/media-service.js';

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
});
