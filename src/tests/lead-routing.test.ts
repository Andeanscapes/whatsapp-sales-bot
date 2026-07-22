import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { assignLine, getRoutingConfig, pickSalesLineFromConfig, resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';

const config: RoutingConfig = {
  salesLines: [
    { id: 'bridge', type: 'bridge', label: 'Bridge', weight: 30, telegramChatId: '1', agentName: 'AgentA' },
    { id: 'agentb_phone', type: 'referral', label: 'AgentB', weight: 70, telegramChatId: '2', agentName: 'AgentB', displayNumber: '+57000' },
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
        { id: 'dup', type: 'bridge', label: 'Bridge', weight: 30, telegramChatId: '1', agentName: 'AgentA' },
        { id: 'dup', type: 'referral', label: 'AgentB', weight: 70, telegramChatId: '2', agentName: 'AgentB', displayNumber: '+57000' },
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
        { id: 'bridge', type: 'bridge', label: 'Bridge', weight: 30, telegramChatId: 'same', agentName: 'AgentA' },
        { id: 'agentb_phone', type: 'referral', label: 'AgentB', weight: 70, telegramChatId: 'same', agentName: 'AgentB', displayNumber: '+57000' },
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

describe('BRIDGE_FLOW env override', () => {
  let previousBridgeFlow: number;
  let previousRawBridgeFlow: string | undefined;

  beforeEach(() => {
    previousBridgeFlow = env.BRIDGE_FLOW;
    previousRawBridgeFlow = process.env.BRIDGE_FLOW;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    env.BRIDGE_FLOW = previousBridgeFlow;
    if (previousRawBridgeFlow === undefined) delete process.env.BRIDGE_FLOW;
    else process.env.BRIDGE_FLOW = previousRawBridgeFlow;
    resetRoutingConfigCache();
  });

  it('BRIDGE_FLOW=70 routes ~70% to bridge lines', () => {
    env.LEAD_ROUTING_JSON = JSON.stringify(config);
    env.BRIDGE_FLOW = 70;
    resetRoutingConfigCache();

    const routing = getRoutingConfig();
    expect(routing).not.toBeNull();

    let bridgeCount = 0;
    const samples = 1000;
    for (let i = 0; i < samples; i += 1) {
      const line = pickSalesLineFromConfig(routing!, `57300${i}`);
      if (line?.type === 'bridge') bridgeCount += 1;
    }

    const pct = (bridgeCount / samples) * 100;
    expect(pct).toBeGreaterThan(63);
    expect(pct).toBeLessThan(77);
  });

  it('BRIDGE_FLOW=0 never routes to bridge', () => {
    env.LEAD_ROUTING_JSON = JSON.stringify(config);
    env.BRIDGE_FLOW = 0;
    resetRoutingConfigCache();

    const routing = getRoutingConfig();
    expect(routing).not.toBeNull();

    for (let i = 0; i < 200; i += 1) {
      const line = pickSalesLineFromConfig(routing!, `57300${i}`);
      expect(line?.type).not.toBe('bridge');
    }
  });

  it('BRIDGE_FLOW=100 never routes to referral', () => {
    env.LEAD_ROUTING_JSON = JSON.stringify(config);
    env.BRIDGE_FLOW = 100;
    resetRoutingConfigCache();

    const routing = getRoutingConfig();
    expect(routing).not.toBeNull();

    for (let i = 0; i < 200; i += 1) {
      const line = pickSalesLineFromConfig(routing!, `57300${i}`);
      expect(line?.type).toBe('bridge');
    }
  });

  it('BRIDGE_FLOW=-1 uses raw weights (no override)', () => {
    env.LEAD_ROUTING_JSON = JSON.stringify(config);
    env.BRIDGE_FLOW = -1;
    resetRoutingConfigCache();

    const routing = getRoutingConfig();
    const bridgeLine = routing?.salesLines.find(l => l.id === 'bridge');
    const referralLine = routing?.salesLines.find(l => l.id === 'agentb_phone');

    expect(bridgeLine?.weight).toBe(30);
    expect(referralLine?.weight).toBe(70);
  });

  it('preserves relative proportions between multiple bridge lines', () => {
    env.LEAD_ROUTING_JSON = JSON.stringify({
      salesLines: [
        { id: 'br1', type: 'bridge' as const, label: 'B1', weight: 60, telegramChatId: '1', agentName: 'A' },
        { id: 'br2', type: 'bridge' as const, label: 'B2', weight: 40, telegramChatId: '2', agentName: 'B' },
        { id: 'ref1', type: 'referral' as const, label: 'R1', weight: 70, telegramChatId: '3', agentName: 'C', displayNumber: '+57000' },
        { id: 'ref2', type: 'referral' as const, label: 'R2', weight: 30, telegramChatId: '4', agentName: 'D', displayNumber: '+57001' },
      ],
    });
    env.BRIDGE_FLOW = 50;
    resetRoutingConfigCache();

    const routing = getRoutingConfig();
    expect(routing).not.toBeNull();
    const b1 = routing!.salesLines.find(l => l.id === 'br1')!;
    const b2 = routing!.salesLines.find(l => l.id === 'br2')!;
    const r1 = routing!.salesLines.find(l => l.id === 'ref1')!;
    const r2 = routing!.salesLines.find(l => l.id === 'ref2')!;

    // bridge group: 60/40 split of 50 => 30/20
    expect(b1.weight).toBeCloseTo(30, 5);
    expect(b2.weight).toBeCloseTo(20, 5);
    // referral group: 70/30 split of 50 => 35/15
    expect(r1.weight).toBeCloseTo(35, 5);
    expect(r2.weight).toBeCloseTo(15, 5);
  });

  it('ignores BRIDGE_FLOW when only bridge lines configured', () => {
    env.LEAD_ROUTING_JSON = JSON.stringify({
      salesLines: [
        { id: 'br1', type: 'bridge' as const, label: 'B1', weight: 50, telegramChatId: '1', agentName: 'A' },
        { id: 'br2', type: 'bridge' as const, label: 'B2', weight: 50, telegramChatId: '2', agentName: 'B' },
      ],
    });
    env.BRIDGE_FLOW = 70;
    resetRoutingConfigCache();

    const routing = getRoutingConfig();
    expect(routing?.salesLines[0].weight).toBe(50);
    expect(routing?.salesLines[1].weight).toBe(50);
  });

  it('sticky assignment is preserved when BRIDGE_FLOW changes', () => {
    env.LEAD_ROUTING_JSON = JSON.stringify(config);
    env.BRIDGE_FLOW = 70;
    resetRoutingConfigCache();

    const db2 = new Database(':memory:');
    migrate(db2);
    const repos2 = createRepositories(db2);
    const phone = '573001112244';

    const first = assignLine(repos2, phone);
    expect(first).not.toBeNull();

    env.BRIDGE_FLOW = 30;
    resetRoutingConfigCache();

    const second = assignLine(repos2, phone);
    expect(second?.id).toBe(first?.id);

    db2.close();
  });

  it('BRIDGE_FLOW=50 distributes equally with equal weights', () => {
    env.LEAD_ROUTING_JSON = JSON.stringify({
      salesLines: [
        { id: 'br', type: 'bridge' as const, label: 'B', weight: 50, telegramChatId: '1', agentName: 'A' },
        { id: 'ref', type: 'referral' as const, label: 'R', weight: 50, telegramChatId: '2', agentName: 'B', displayNumber: '+57000' },
      ],
    });
    env.BRIDGE_FLOW = 50;
    resetRoutingConfigCache();

    const routing = getRoutingConfig();
    expect(routing).not.toBeNull();
    const br = routing!.salesLines.find(l => l.id === 'br')!;
    const ref = routing!.salesLines.find(l => l.id === 'ref')!;

    expect(br.weight).toBe(50);
    expect(ref.weight).toBe(50);
  });

  it('invalid BRIDGE_FLOW (coerced to -1) falls back to raw weights and warns once', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    env.LEAD_ROUTING_JSON = JSON.stringify(config);
    env.BRIDGE_FLOW = -1;
    process.env.BRIDGE_FLOW = '150';
    resetRoutingConfigCache();

    const routing = getRoutingConfig();
    const bridgeLine = routing?.salesLines.find(l => l.id === 'bridge');
    const referralLine = routing?.salesLines.find(l => l.id === 'agentb_phone');

    expect(bridgeLine?.weight).toBe(30);
    expect(referralLine?.weight).toBe(70);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ raw: '150' }),
      expect.stringContaining('BRIDGE_FLOW invalid'),
    );
  });

  it('does not warn when BRIDGE_FLOW is intentionally disabled (-1)', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    env.LEAD_ROUTING_JSON = JSON.stringify(config);
    env.BRIDGE_FLOW = -1;
    process.env.BRIDGE_FLOW = '-1';
    resetRoutingConfigCache();

    getRoutingConfig();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
