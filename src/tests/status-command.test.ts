import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { statusHandler } from '../commands/status.command.js';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'BK', weight: 50, telegramChatId: '111', agentName: 'AgentA' },
    { id: 'line2_referral', type: 'referral', label: 'BK', weight: 50, telegramChatId: '222', agentName: 'AgentB', displayNumber: '+57000' },
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

describe('/status', () => {
  it('shows active state and uptime when the bot is running', async () => {
    const out = await statusHandler({ repos, args: [], chatId: 111 });

    expect(out).toContain('Estado del Bot');
    expect(out).toContain('Activo');
    expect(out).toContain('Uptime:');
    expect(out).toContain('Lineas configuradas: 2');
    expect(out).not.toContain('PAUSADO');
  });

  it('shows paused state when the bot is paused', async () => {
    repos.setPaused(true);

    const out = await statusHandler({ repos, args: [], chatId: 111 });

    expect(out).toContain('PAUSADO');
    expect(out).not.toContain('✅ Estado: Activo');
  });

  it('shows daily stats section with the report hint', async () => {
    repos.conversation.upsert('573001112233', { language: 'es', lead_score: 90 });
    repos.conversation.setAssignment('573001112233', { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });

    const out = await statusHandler({ repos, args: [], chatId: 111 });

    expect(out).toContain('Hoy');
    expect(out).toContain('Conversaciones:');
    expect(out).toContain('Entrantes:');
    expect(out).toContain('Leads calientes:');
    expect(out).toContain('Transferidos:');
    expect(out).toContain('IA gastada:');
    expect(out).toContain('Conversaciones por linea');
    expect(out).toContain('_Usa /report para detalle completo._');
  });

  it('shows leads by line section with agent names', async () => {
    repos.conversation.upsert('573001112233', { language: 'es', lead_score: 88 });
    repos.conversation.setAssignment('573001112233', { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.upsert('573001112244', { language: 'es', lead_score: 70 });
    repos.conversation.setAssignment('573001112244', { assignedLineId: 'line2_referral', assignedAgentChat: '222' });

    const out = await statusHandler({ repos, args: [], chatId: 111 });

    expect(out).toContain('AgentA');
    expect(out).toContain('AgentB');
  });

  it('reflects confirmed bookings in daily total and per-line counts', async () => {
    repos.conversation.upsert('573001112233', { language: 'es', lead_score: 88 });
    repos.conversation.setAssignment('573001112233', { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setBooked('573001112233');

    const out = await statusHandler({ repos, args: [], chatId: 111 });

    expect(out).toContain('Reservas hoy: 1');
    // Per-line section shows the booking count for the owning line.
    expect(out).toMatch(/AgentA:.*1 reservas/);
  });
});
