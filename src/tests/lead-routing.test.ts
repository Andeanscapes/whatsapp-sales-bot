import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { assignLine, getRoutingConfig, pickSalesLineFromConfig, resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';

const config: RoutingConfig = {
  salesLines: [
    { id: 'bridge', type: 'bridge', label: 'Bridge', weight: 30, telegramChatId: '1', agentName: 'Heinner' },
    { id: 'zaret_phone', type: 'referral', label: 'Zaret', weight: 70, telegramChatId: '2', agentName: 'Zaret', displayNumber: '+57000' },
  ],
};

describe('lead routing', () => {
  it('keeps assignment deterministic for the same customer', () => {
    const first = pickSalesLineFromConfig(config, '573001112233');
    const second = pickSalesLineFromConfig(config, '573001112233');
    expect(first?.id).toBe(second?.id);
  });

  it('routes every sampled customer to one configured line', () => {
    const ids = new Set(config.salesLines.map(line => line.id));
    for (let i = 0; i < 100; i += 1) {
      const line = pickSalesLineFromConfig(config, `57300${i}`);
      expect(line).not.toBeNull();
      expect(ids.has(line?.id ?? '')).toBe(true);
    }
  });

  it('rejects duplicate line ids', () => {
    const previous = env.LEAD_ROUTING_JSON;
    env.LEAD_ROUTING_JSON = JSON.stringify({
      salesLines: [
        { id: 'dup', type: 'bridge', label: 'Bridge', weight: 30, telegramChatId: '1', agentName: 'Heinner' },
        { id: 'dup', type: 'referral', label: 'Zaret', weight: 70, telegramChatId: '2', agentName: 'Zaret', displayNumber: '+57000' },
      ],
    });
    resetRoutingConfigCache();

    expect(() => getRoutingConfig()).toThrow();

    env.LEAD_ROUTING_JSON = previous;
    resetRoutingConfigCache();
  });

  it('rejects duplicate telegram chat ids', () => {
    const previous = env.LEAD_ROUTING_JSON;
    env.LEAD_ROUTING_JSON = JSON.stringify({
      salesLines: [
        { id: 'bridge', type: 'bridge', label: 'Bridge', weight: 30, telegramChatId: 'same', agentName: 'Heinner' },
        { id: 'zaret_phone', type: 'referral', label: 'Zaret', weight: 70, telegramChatId: 'same', agentName: 'Zaret', displayNumber: '+57000' },
      ],
    });
    resetRoutingConfigCache();

    expect(() => getRoutingConfig()).toThrow();

    env.LEAD_ROUTING_JSON = previous;
    resetRoutingConfigCache();
  });
});

describe('assignLine idempotency', () => {
  let repos: Repositories;
  let db: Database.Database;

  let previousRoutingJson: string;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    previousRoutingJson = env.LEAD_ROUTING_JSON;
    env.LEAD_ROUTING_JSON = JSON.stringify(config);
    resetRoutingConfigCache();
  });

  afterEach(() => {
    env.LEAD_ROUTING_JSON = previousRoutingJson;
    resetRoutingConfigCache();
    db.close();
  });

  it('persists once and never reassigns the same customer', () => {
    const phone = '573001112233';
    const first = assignLine(repos, phone);
    const stored = repos.conversation.getAssignment(phone);
    const second = assignLine(repos, phone);

    expect(first?.id).toBeDefined();
    expect(second?.id).toBe(first?.id);
    expect(stored?.assignedLineId).toBe(first?.id);
    expect(stored?.assignedAgentChat).toBe(first?.telegramChatId);
  });
});
