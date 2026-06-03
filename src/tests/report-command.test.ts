import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { reportHandler } from '../commands/report.command.js';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'BK', weight: 50, telegramChatId: '111', agentName: 'Heinner' },
  ],
};

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

function insertConversation(phone: string, firstSeenAt: string, leadScore: number): void {
  db.prepare(
    'INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, lead_score) VALUES (?, ?, ?, ?)'
  ).run(phone, firstSeenAt, firstSeenAt, leadScore);
}

describe('/report cumulative totals', () => {
  it('counts leads created before today in total/active/hot (all-time semantics)', async () => {
    // Lead created long before today — must still appear in cumulative totals.
    insertConversation('old-hot', '2020-01-01T00:00:00.000Z', 95);
    insertConversation('old-cold', '2020-01-02T00:00:00.000Z', 10);

    const out = await reportHandler({ repos, args: [], chatId: 111 });

    expect(out).toContain('Total conversaciones: 2');
    expect(out).toContain('Activas: 2');
    // Hot threshold is 90 by default in env.
    expect(out).toMatch(/Leads calientes.*: 1/);
  });

  it('excludes opted-out leads from active totals', async () => {
    insertConversation('opted', '2020-01-01T00:00:00.000Z', 95);
    repos.optOut.setOptOut('opted');

    const out = await reportHandler({ repos, args: [], chatId: 111 });

    expect(out).toContain('Total conversaciones: 1');
    expect(out).toContain('Activas: 0');
  });
});
