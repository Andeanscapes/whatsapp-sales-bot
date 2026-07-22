import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { statsHandler } from '../commands/stats.command.js';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'BK', weight: 50, telegramChatId: '111', agentName: 'AgentA' },
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

function seedConversation(phone: string): void {
  repos.conversation.upsert(phone, { language: 'es', lead_score: 90 });
  repos.conversation.setAssignment(phone, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
  repos.conversation.setBooked(phone);
}

function setConvertedAt(phone: string, convertedAt: string): void {
  db.prepare('UPDATE conversations SET converted_at = ? WHERE customer_phone = ?').run(convertedAt, phone);
}

function utcMidday(daysOffset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)).toISOString();
}

describe('/stats command', () => {
  it('defaults to hoy when no period is given', async () => {
    const out = await statsHandler({ repos, args: [], chatId: 111 });

    expect(out).toContain('Estadisticas — Hoy');
    expect(out).toContain('Total conversaciones:');
  });

  it('shows ayer', async () => {
    const out = await statsHandler({ repos, args: ['ayer'], chatId: 111 });

    expect(out).toContain('Estadisticas — Ayer');
  });

  it('shows semana (7 days)', async () => {
    const out = await statsHandler({ repos, args: ['semana'], chatId: 111 });

    expect(out).toContain('Estadisticas — Ultimos 7 dias');
  });

  it('shows todo (all time)', async () => {
    const out = await statsHandler({ repos, args: ['todo'], chatId: 111 });

    expect(out).toContain('Estadisticas — Historico (todo)');
  });

  it('shows reserved counts in the per-line section', async () => {
    seedConversation('573001112233');
    seedConversation('573001112244');

    const out = await statsHandler({ repos, args: ['todo'], chatId: 111 });

    expect(out).toContain('Reservas: 2');
    expect(out).toMatch(/BK \(AgentA\):.*2 reservas/);
  });

  it('for ayer, excludes bookings confirmed today', async () => {
    seedConversation('573001112233');
    setConvertedAt('573001112233', utcMidday(-1));
    seedConversation('573001112244');
    setConvertedAt('573001112244', utcMidday(0));

    const out = await statsHandler({ repos, args: ['ayer'], chatId: 111 });

    expect(out).toContain('Reservas: 1');
    expect(out).toMatch(/BK \(AgentA\):.*1 reservas/);
  });

  it('for hoy, excludes bookings confirmed yesterday', async () => {
    seedConversation('573001112233');
    setConvertedAt('573001112233', utcMidday(-1));
    seedConversation('573001112244');
    setConvertedAt('573001112244', utcMidday(0));

    const out = await statsHandler({ repos, args: ['hoy'], chatId: 111 });

    expect(out).toContain('Reservas: 1');
    expect(out).toMatch(/BK \(AgentA\):.*1 reservas/);
  });

  it('keeps cumulative totals all-time while bounding new conversations by period', async () => {
    // Old lead created before today: cumulative, not "new today".
    db.prepare('INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, lead_score) VALUES (?, ?, ?, ?)')
      .run('old', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 95);
    // New lead created now.
    repos.conversation.upsert('573009998888', { language: 'es', lead_score: 92 });

    const hoy = await statsHandler({ repos, args: ['hoy'], chatId: 111 });
    const todo = await statsHandler({ repos, args: ['todo'], chatId: 111 });

    // Total conversaciones is cumulative (all-time) in both periods.
    expect(hoy).toContain('Total conversaciones: 2');
    expect(todo).toContain('Total conversaciones: 2');
    // Nuevas en periodo is bounded: only the lead created today counts for "hoy".
    expect(hoy).toContain('Nuevas en periodo: 1');
    expect(todo).toContain('Nuevas en periodo: 2');
  });

  it('returns usage for unknown periods', async () => {
    const out = await statsHandler({ repos, args: ['marzo'], chatId: 111 });

    expect(out).toContain('Uso: /stats');
  });
});
