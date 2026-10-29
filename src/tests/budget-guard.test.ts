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

  it('counts only reply calls toward the per-customer daily limit', () => {
    const phone = '573007710904';
    const base = { phone, model: 'm', promptTokens: 1, completionTokens: 1, cachedTokens: 0, estimatedCost: 0, success: true };
    repos.aiUsage.recordUsage({ ...base, purpose: 'reply' });
    repos.aiUsage.recordUsage({ ...base, purpose: 'lead_analysis' });
    repos.aiUsage.recordUsage({ ...base, purpose: 'follow_up' });
    const todayStart = new Date().toISOString().split('T')[0];
    expect(repos.aiUsage.countCustomerDailyReplies(phone, todayStart)).toBe(1);
    expect(repos.aiUsage.countCustomerDaily(phone, todayStart)).toBe(3);
  });

  it('returns result with correct shape', () => {
    const result = checkBudget(repos, '573001112233');
    expect(typeof result.aiAllowed).toBe('boolean');
    expect(result.reason === undefined || typeof result.reason === 'string').toBe(true);
  });
});
