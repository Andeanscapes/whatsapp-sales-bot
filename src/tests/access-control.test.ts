import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { canAccessConversation, resolveCallerLineId } from '../services/access-control.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Booking', weight: 30, telegramChatId: '111', agentName: 'Heinner' },
    { id: 'line2_referral', type: 'referral', label: 'Booking', weight: 70, telegramChatId: '222', agentName: 'Zaret', displayNumber: '+57000' },
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
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
  db.close();
});

function enableRouting(): void {
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  resetRoutingConfigCache();
}

function disableRouting(): void {
  env.LEAD_ROUTING_JSON = '';
  resetRoutingConfigCache();
}

describe('access control — single-line mode', () => {
  it('grants full access when routing is not configured', () => {
    disableRouting();
    repos.conversation.setAssignment('573000000001', { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    expect(resolveCallerLineId('999')).toBeNull();
    expect(canAccessConversation(repos, '999', '573000000001')).toBe(true);
  });
});

describe('access control — multi-line mode', () => {
  it('maps a telegram chat to its line', () => {
    enableRouting();
    expect(resolveCallerLineId('111')).toBe('line1_bridge');
    expect(resolveCallerLineId('222')).toBe('line2_referral');
    expect(resolveCallerLineId('999')).toBeNull();
  });

  it('allows the owning line and blocks other agents', () => {
    enableRouting();
    repos.conversation.setAssignment('573000000001', { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    expect(canAccessConversation(repos, '111', '573000000001')).toBe(true);
    expect(canAccessConversation(repos, '222', '573000000001')).toBe(false);
  });

  it('allows any agent to see unassigned (pre-handoff) leads', () => {
    enableRouting();
    repos.conversation.upsert('573000000002', { language: 'es' });
    expect(canAccessConversation(repos, '111', '573000000002')).toBe(true);
    expect(canAccessConversation(repos, '222', '573000000002')).toBe(true);
  });
});

describe('per-line lead counts (global report)', () => {
  it('aggregates totals and hot counts per assigned line', () => {
    repos.conversation.upsert('573000000001', { lead_score: 90, assigned_line_id: 'line1_bridge', assigned_agent_chat: '111' });
    repos.conversation.upsert('573000000002', { lead_score: 10, assigned_line_id: 'line2_referral', assigned_agent_chat: '222' });
    repos.conversation.upsert('573000000003', { lead_score: 95, assigned_line_id: 'line2_referral', assigned_agent_chat: '222' });
    repos.conversation.upsert('573000000004', { lead_score: 5 });

    const counts = repos.stats.getLeadCountsByLine(env.HOT_LEAD_THRESHOLD);
    const byId = Object.fromEntries(counts.map(c => [c.lineId, c]));

    expect(byId['line1_bridge']).toMatchObject({ total: 1, hot: 1 });
    expect(byId['line2_referral']).toMatchObject({ total: 2, hot: 1 });
    expect(byId['unassigned']).toMatchObject({ total: 1, hot: 0 });
  });

  it('scopes getTopLeads to the owning line plus unassigned', () => {
    repos.conversation.upsert('573000000001', { lead_score: 90, assigned_line_id: 'line1_bridge', assigned_agent_chat: '111' });
    repos.conversation.upsert('573000000002', { lead_score: 92, assigned_line_id: 'line2_referral', assigned_agent_chat: '222' });
    repos.conversation.upsert('573000000003', { lead_score: 91 });

    const line1 = repos.stats.getTopLeads(10, env.HOT_LEAD_THRESHOLD, 'line1_bridge').map(l => l.customerPhone);
    expect(line1).toContain('573000000001');
    expect(line1).toContain('573000000003');
    expect(line1).not.toContain('573000000002');
  });
});
