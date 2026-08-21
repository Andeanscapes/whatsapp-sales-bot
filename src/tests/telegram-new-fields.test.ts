import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { customerHandler } from '../commands/customer.command.js';
import { leadsHandler } from '../commands/leads.command.js';
import { recentHandler } from '../commands/recent.command.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache } from '../services/lead-routing.js';

const PHONE = '573001119876';

let db: Database.Database;
let repos: Repositories;
let previousRoutingJson: string;
let previousExcludedPhones: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  previousExcludedPhones = env.REPORT_EXCLUDED_PHONES;
  env.LEAD_ROUTING_JSON = '';
  env.REPORT_EXCLUDED_PHONES = '';
  resetRoutingConfigCache();
  repos.conversation.upsert(PHONE, {
    collected_name: 'Alice',
    lead_score: 95,
    collected_people: 4,
    collected_adults: 2,
    collected_children: 2,
    collected_child_ages_json: '[9,11]',
    collected_travel_origin: 'Medellin',
    entry_marker: 'H01',
    entry_temperature: 'funnel',
    ad_referral_json: JSON.stringify({ headline: 'Tour', source_type: 'ad', source_id: 'campaign-1' }),
  });
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  env.REPORT_EXCLUDED_PHONES = previousExcludedPhones;
  resetRoutingConfigCache();
  db.close();
});

describe('Telegram commands with branch DB fields', () => {
  it('omits invalid child ages from DB qualification context', () => {
    repos.conversation.upsert(PHONE, { collected_child_ages_json: '[-1,18,9.5]' });

    expect(repos.conversation.getCollectedFields(PHONE)).not.toHaveProperty('edadesNinos');
  });

  it('/customer formats qualification and acquisition details', async () => {
    const output = await customerHandler({ repos, args: [PHONE], chatId: 111 });

    expect(output).toContain('Adultos: 2');
    expect(output).toContain('Ninos: 2');
    expect(output).toContain('Edades ninos: 9, 11');
    expect(output).toContain('Origen: Medellin');
    expect(output).toContain('Entrada: H01 (funnel)');
    expect(output).toContain('campaign-1');
    expect(output).not.toContain('[9,11]');
  });

  it('/leads includes group breakdown, origin, and campaign entry', async () => {
    const output = await leadsHandler({ repos, args: ['10'], chatId: 111 });

    expect(output).toContain('2A/2N');
    expect(output).toContain('Medellin');
    expect(output).toContain('H01/funnel');
  });

  it('/leads clamps excessive and negative limits', async () => {
    for (let index = 0; index < 20; index++) {
      repos.conversation.upsert(`${PHONE}${index}`, { collected_name: `Lead${index}`, lead_score: 95 });
    }

    const excessive = await leadsHandler({ repos, args: ['999'], chatId: 111 });
    const negative = await leadsHandler({ repos, args: ['-1'], chatId: 111 });

    expect(excessive).toContain('Top 15 Hot Leads');
    expect(negative).toContain('Top 1 Hot Leads');
  });

  it('/recent includes campaign entry for a real reply', async () => {
    const base = Date.now() - 3_000;
    for (const [index, direction] of (['inbound', 'outbound', 'inbound'] as const).entries()) {
      repos.message.addMessage({
        customer_phone: PHONE,
        direction,
        message_type: 'text',
        body: `message-${index}`,
        created_at: new Date(base + index * 1_000).toISOString(),
      });
    }

    const output = await recentHandler({ repos, args: ['10'], chatId: 111 });

    expect(output).toContain(PHONE);
    expect(output).toContain('H01/funnel');
  });
});
