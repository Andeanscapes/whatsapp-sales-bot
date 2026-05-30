import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { checkBudget } from '../services/budget-guard.js';
import { loadSkills } from '../services/skill-loader.js';
import type { Repositories } from '../db/repositories/index.js';

let repos: Repositories;

beforeAll(() => {
  loadSkills();
  const db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
});

describe('checkBudget', () => {
  it('returns aiAllowed=false when AI_ENABLED is false', () => {
    const result = checkBudget(repos, '573001112233');
    expect(result.aiAllowed).toBe(false);
    expect(result.reason).toBe('ai_disabled');
  });

  it('returns result with correct shape', () => {
    const result = checkBudget(repos, '573001112233');
    expect(typeof result.aiAllowed).toBe('boolean');
    expect(result.reason === undefined || typeof result.reason === 'string').toBe(true);
  });
});
