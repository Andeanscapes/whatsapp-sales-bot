import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache } from '../services/lead-routing.js';
import { statsHandler } from '../commands/stats.command.js';
import { recentHandler } from '../commands/recent.command.js';
import { reportHandler } from '../commands/report.command.js';
import { statusHandler } from '../commands/status.command.js';
import { leadsHandler } from '../commands/leads.command.js';
import { getReportExcludedPhones, normalizePhone } from '../services/report-exclusions.js';

const TEST_PHONE = '573009998888';
const REAL_PHONE = '573001112233';

let repos: Repositories;
let db: Database.Database;
let previousExcluded: string;

function insertMessage(phone: string, direction: 'inbound' | 'outbound', body: string, createdAt: string): void {
  db.prepare(
    'INSERT INTO messages (customer_phone, direction, message_type, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(phone, direction, 'text', body, createdAt);
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousExcluded = env.REPORT_EXCLUDED_PHONES;
  env.LEAD_ROUTING_JSON = '';
  resetRoutingConfigCache();
});

afterEach(() => {
  env.REPORT_EXCLUDED_PHONES = previousExcluded;
  resetRoutingConfigCache();
  db.close();
});

describe('report exclusions parsing', () => {
  it('includes configured phones plus owner phone', () => {
    env.REPORT_EXCLUDED_PHONES = ' +57 300 999 8888 , 573001112233 ,';
    const phones = getReportExcludedPhones();
    expect(phones).toContain('573009998888');
    expect(phones).toContain('573001112233');
    expect(phones).toContain(normalizePhone(env.OWNER_PERSONAL_WHATSAPP_NUMBER));
  });

  it('includes owner phone even when REPORT_EXCLUDED_PHONES unset', () => {
    env.REPORT_EXCLUDED_PHONES = '';
    const phones = getReportExcludedPhones();
    expect(phones).toHaveLength(1);
    expect(phones[0]).toBe(normalizePhone(env.OWNER_PERSONAL_WHATSAPP_NUMBER));
  });

  it('dedupes owner phone when also listed in REPORT_EXCLUDED_PHONES', () => {
    const owner = normalizePhone(env.OWNER_PERSONAL_WHATSAPP_NUMBER);
    env.REPORT_EXCLUDED_PHONES = `${owner}, 573001112233`;
    const phones = getReportExcludedPhones();
    expect(phones.filter(p => p === owner)).toHaveLength(1);
    expect(phones).toContain('573001112233');
  });
});

describe('/stats excludes test numbers (json_each path)', () => {
  it('drops excluded conversations and messages from totals', async () => {
    repos.conversation.upsert(REAL_PHONE, { language: 'es', lead_score: 95 });
    repos.conversation.upsert(TEST_PHONE, { language: 'es', lead_score: 95 });
    insertMessage(REAL_PHONE, 'inbound', 'hola', nowIso());
    insertMessage(TEST_PHONE, 'inbound', 'prueba api', nowIso());

    env.REPORT_EXCLUDED_PHONES = TEST_PHONE;
    const out = await statsHandler({ repos, args: ['todo'], chatId: 111 });

    expect(out).toContain('Total conversaciones: 1');
    expect(out).toContain('Entrantes: 1');
  });

  it('applies the same exclusions to /report and /status, including per-line totals', async () => {
    repos.conversation.upsert(REAL_PHONE, { language: 'es', lead_score: 95 });
    repos.conversation.upsert(TEST_PHONE, { language: 'es', lead_score: 95 });
    insertMessage(REAL_PHONE, 'inbound', 'hola', nowIso());
    insertMessage(TEST_PHONE, 'inbound', 'prueba api', nowIso());
    env.REPORT_EXCLUDED_PHONES = TEST_PHONE;

    const report = await reportHandler({ repos, args: [], chatId: 111 });
    const status = await statusHandler({ repos, args: [], chatId: 111 });

    expect(report).toContain('Total conversaciones: 1');
    expect(report).toMatch(/Sin asignar: 1 total/);
    expect(status).toContain('Conversaciones: 1');
    expect(status).toMatch(/Sin asignar: 1 total/);
  });

  it('excludes test numbers from /leads', async () => {
    repos.conversation.upsert(REAL_PHONE, { collected_name: 'Real', lead_score: 95 });
    repos.conversation.upsert(TEST_PHONE, { collected_name: 'Test', lead_score: 100 });
    env.REPORT_EXCLUDED_PHONES = TEST_PHONE;

    const output = await leadsHandler({ repos, args: ['10'], chatId: 111 });

    expect(output).toContain(REAL_PHONE);
    expect(output).not.toContain(TEST_PHONE);
  });
});

describe('summary projections include branch qualification fields', () => {
  it('returns campaign and group details for /leads and /recent formatters', () => {
    repos.conversation.upsert(REAL_PHONE, {
      collected_name: 'Alice',
      lead_score: 95,
      collected_people: 4,
      collected_adults: 2,
      collected_children: 2,
      collected_child_ages_json: '[9,11]',
      collected_travel_origin: 'Medellin',
      collected_transport_need: 'public_bus',
      entry_marker: 'H01',
      entry_temperature: 'funnel',
    });

    expect(repos.stats.getTopLeads(1, 90)[0]).toMatchObject({
      adults: 2,
      children: 2,
      childAges: [9, 11],
      travelOrigin: 'Medellin',
      transportNeed: 'public_bus',
      entryMarker: 'H01',
      entryTemperature: 'funnel',
    });
  });
});

describe('/recent shows only real user replies after first bot reply', () => {
  it('includes a lead that wrote after the first outbound, excludes reply-less and excluded phones', async () => {
    // REAL_PHONE: inbound, then bot reply, then a genuine user reply.
    repos.conversation.upsert(REAL_PHONE, { language: 'es' });
    insertMessage(REAL_PHONE, 'inbound', 'hola', nowIso(-3000));
    insertMessage(REAL_PHONE, 'outbound', 'bienvenido', nowIso(-2000));
    insertMessage(REAL_PHONE, 'inbound', 'cuanto vale', nowIso(-1000));

    // Only an inbound + bot reply, no further user message -> excluded.
    const silent = '573004445566';
    repos.conversation.upsert(silent, { language: 'es' });
    insertMessage(silent, 'inbound', 'hola', nowIso(-3000));
    insertMessage(silent, 'outbound', 'bienvenido', nowIso(-2000));

    // Excluded test phone, even with a post-reply message.
    repos.conversation.upsert(TEST_PHONE, { language: 'es' });
    insertMessage(TEST_PHONE, 'inbound', 'hola', nowIso(-3000));
    insertMessage(TEST_PHONE, 'outbound', 'bienvenido', nowIso(-2000));
    insertMessage(TEST_PHONE, 'inbound', 'prueba', nowIso(-1000));

    env.REPORT_EXCLUDED_PHONES = TEST_PHONE;
    const out = await recentHandler({ repos, args: ['10'], chatId: 111 });

    expect(out).toContain(REAL_PHONE);
    expect(out).not.toContain(silent);
    expect(out).not.toContain(TEST_PHONE);
  });
});
