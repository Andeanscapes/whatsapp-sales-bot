import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadSkills, getSkills } from '../services/skill-loader.js';
import { getActiveExperience, getPlans } from '../services/product-registry.js';
import { useAllSitesActive } from './helpers/all-sites-catalog.js';
import { env } from '../config/env.js';

const { mockSendTemplate } = vi.hoisted(() => ({
  mockSendTemplate: vi.fn<(...args: unknown[]) => Promise<{ whatsappMessageId: string }>>(
    () => Promise.resolve({ whatsappMessageId: 'wamid.OK' }),
  ),
}));

vi.mock('../services/whatsapp-client.js', () => ({
  sendTemplate: mockSendTemplate,
  sendTextWithId: vi.fn(() => Promise.resolve({ whatsappMessageId: 'wamid.TEXT' })),
  sendImageUrlWithId: vi.fn(() => Promise.resolve({ whatsappMessageId: 'wamid.IMAGE' })),
  MAX_IMAGE_CAPTION_CHARS: 1024,
  WhatsAppSendError: class WhatsAppSendError extends Error {
    constructor(message: string, readonly deliveryUncertain: boolean, readonly retryable = false, readonly metaCode?: string) {
      super(message);
      this.name = 'WhatsAppSendError';
    }
  },
}));

import { runFollowupCycle } from '../services/followup-service.js';

const PHONE = '573001112299';
const CORE = 'core_2d1n_chivor';
let db: Database.Database;
let repos: Repositories;

/** A consented, dormant, answered lead whose stored plan id is `storedPlan`. */
function seedDormantLead(storedPlan: string): void {
  const inboundAt = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const outboundAt = new Date(Date.now() - 47.5 * 3_600_000).toISOString();
  repos.conversation.upsert(PHONE, { language: 'es', collected_plan: storedPlan, collected_people: 2 });
  repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'hola', created_at: inboundAt });
  repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'respuesta', created_at: outboundAt });
  repos.followupConsent.grantConsent(PHONE, 'telegram:1');
}

beforeEach(() => {
  useAllSitesActive();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  loadSkills();
  mockSendTemplate.mockClear();
  vi.spyOn(env, 'ALLOW_FOLLOWUP_TEMPLATE', 'get').mockReturnValue(true);
  vi.spyOn(env, 'FOLLOWUP_TEMPLATE_HEADER', 'get').mockReturnValue('none');
  vi.spyOn(env, 'FOLLOWUP_DEV_MINUTES', 'get').mockReturnValue(0);
  vi.spyOn(env, 'FOLLOWUP_DEV_ALLOWLIST_PHONES', 'get').mockReturnValue('');
  vi.spyOn(env, 'FOLLOWUP_TEMPLATE_SEND_START_HOUR_BOGOTA', 'get').mockReturnValue(0);
  vi.spyOn(env, 'FOLLOWUP_TEMPLATE_SEND_END_HOUR_BOGOTA', 'get').mockReturnValue(24);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('one-shot template for a returning lead on a retired plan', () => {
  it('names the successor plan, not the retired id', async () => {
    seedDormantLead('2d1n_mining');
    const coreName = getPlans(getActiveExperience(getSkills())).find(plan => plan.id === CORE)?.name;

    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][3]).toEqual([coreName]);
  });

  it('names the experience when the retired plan has no successor', async () => {
    seedDormantLead('plan_that_never_existed');
    const experienceName = getActiveExperience(getSkills()).name;

    await runFollowupCycle(repos);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][3]).toEqual([experienceName]);
  });
});
