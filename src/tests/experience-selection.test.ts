import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';
import {
  getActiveExperience,
  getExperiences,
  hasMultipleExperiences,
  resolveExperience,
  getGalleryImages,
} from '../services/product-registry.js';

describe('resolveExperience', () => {
  const skills = loadSkills();

  it('falls back to the first experience when no id is given', () => {
    expect(resolveExperience(skills)).toBe(getActiveExperience(skills));
    expect(resolveExperience(skills, null)).toBe(getActiveExperience(skills));
    expect(resolveExperience(skills, '')).toBe(getActiveExperience(skills));
  });

  it('falls back to the first experience for an unknown id', () => {
    expect(resolveExperience(skills, 'does_not_exist')).toBe(getActiveExperience(skills));
  });

  it('returns the experience matching a known id', () => {
    const first = getExperiences(skills)[0];
    expect(resolveExperience(skills, first.id)).toBe(first);
  });

  it('reports single-experience config today', () => {
    expect(hasMultipleExperiences(skills)).toBe(false);
  });

  it('returns only gallery images for the selected experience', () => {
    const first = getExperiences(skills)[0];
    const scopedSkills = {
      ...skills,
      andeanScapes: {
        ...skills.andeanScapes,
        experiences: [first, { ...first, id: 'other_experience' }],
      },
      dynamicMedia: {
        ownerImage: null,
        planImages: [],
        galleryImages: [
          { experienceId: first.id, url: 'https://cdn.andeanscapes.com/first.jpg', caption: '' },
          { experienceId: 'other_experience', url: 'https://cdn.andeanscapes.com/other.jpg', caption: '' },
          { url: 'https://cdn.andeanscapes.com/unscoped.jpg', caption: '' },
        ],
      },
    };

    expect(getGalleryImages(scopedSkills, first.id).map(image => image.url)).toEqual([
      'https://cdn.andeanscapes.com/first.jpg',
    ]);
  });
});

describe('conversation selected_experience_id', () => {
  let repos: Repositories;
  let db: Database.Database;
  const PHONE = '573001112233';

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
  });

  it('defaults to null before any selection', () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    expect(repos.conversation.getSelectedExperienceId(PHONE)).toBeNull();
  });

  it('persists and reads back a selection', () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setSelectedExperienceId(PHONE, 'emerald_mining_tour');
    expect(repos.conversation.getSelectedExperienceId(PHONE)).toBe('emerald_mining_tour');
  });
});
