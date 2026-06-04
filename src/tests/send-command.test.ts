import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import * as whatsappClient from '../services/whatsapp-client.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { sendHandler } from '../commands/send.command.js';

const PHONE = '573001112233';

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
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  resetRoutingConfigCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
  db.close();
});

function recordInbound(): void {
  repos.message.addMessage({
    whatsapp_message_id: 'in-1',
    customer_phone: PHONE,
    direction: 'inbound',
    message_type: 'text',
    body: 'hola',
    created_at: new Date().toISOString(),
  });
}

describe('/send command routing guard', () => {
  it('blocks referral agents from sending through the API line', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line2_referral', assignedAgentChat: '222' });
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    const reply = await sendHandler({ repos, chatId: 222, args: [PHONE, 'hola'] });

    expect(reply).toContain('referral');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('allows bridge agents through guarded bridge send path', async () => {
    recordInbound();
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    const reply = await sendHandler({ repos, chatId: 111, args: [PHONE, 'hola'] });

    expect(reply).toContain('Enviado');
    expect(sendSpy).toHaveBeenCalledWith(PHONE, 'hola');
    expect(repos.message.getLastOutboundBody(PHONE)).toBe('hola');
  });

  it('blocks a bridge agent from sending to an unassigned/arbitrary number', async () => {
    recordInbound();
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    const reply = await sendHandler({ repos, chatId: 111, args: [PHONE, 'hola'] });

    expect(reply).toBe(bridgeMessages.leadNotAssigned);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('blocks a bridge agent from sending to a lead assigned to another line', async () => {
    recordInbound();
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '999' });
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    const reply = await sendHandler({ repos, chatId: 111, args: [PHONE, 'hola'] });

    expect(reply).toBe(bridgeMessages.leadAssignedToOther);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
