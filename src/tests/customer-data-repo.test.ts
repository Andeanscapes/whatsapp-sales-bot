import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';

let repos: Repositories;
let db: Database.Database;

function seedCustomer(phone: string, messageId: string): void {
  repos.conversation.upsert(phone, { lead_score: 50 });
  repos.message.addMessage({
    whatsapp_message_id: messageId,
    customer_phone: phone,
    direction: 'inbound',
    message_type: 'text',
    body: 'Hola',
    created_at: new Date().toISOString(),
    raw_json: null,
  });
  repos.dedupe.markProcessed(messageId);
  repos.aiUsage.recordUsage({ phone, model: 'deepseek', promptTokens: 100, completionTokens: 50, cachedTokens: 0, estimatedCost: 0.001, purpose: 'reply', success: true });
  repos.ownerAlert.insert(phone, 'telegram', 90, 'hot', 'body');
  repos.mediaSend.recordSend(phone, 'media-1');
  repos.bridgeSession.open(`chat-${phone}`, phone);
  repos.followupConsent.grantConsent(phone, 'test');
  repos.followupConsentGrant.record({
    customer_phone: phone,
    decision: 'grant',
    decided_at: new Date().toISOString(),
    source: 'operator_grant',
  });
  repos.followupSubscription.ensureExists(phone);
  repos.followupSubscription.markAsked(phone, `${messageId}.ask`);
  repos.followupSubscription.affirm(phone, `${messageId}.yes`, 'test');
  repos.followupEvent.claim(phone, '2026-08-12T00:00:00.000Z', 3, 10);
  repos.followupSubscriptionEvent.claim(phone, 'recurring', 'r1', 3, 10);
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
});

describe('CustomerDataRepository.deleteCustomer', () => {
  it('removes all rows for the target phone across every table', () => {
    const phone = '573001112233';
    seedCustomer(phone, 'wamid.AAA');

    const result = repos.customerData.deleteCustomer(phone);

    expect(result).toEqual({
      conversations: 1,
      messages: 1,
      processedMessages: 1,
      aiUsage: 1,
      ownerAlerts: 1,
      mediaSends: 1,
      bridgeSessions: 1,
      followupConsent: 1,
      followupConsentGrants: 1,
      followupEvents: 1,
      followupSubscriptions: 1,
      followupSubscriptionEvents: 1,
    });

    expect(repos.conversation.getByPhone(phone)).toBeUndefined();
    expect(repos.dedupe.isProcessed('wamid.AAA')).toBe(false);
    expect(repos.bridgeSession.getByCustomer(phone)).toBeNull();
    expect(repos.followupConsentGrant.listByPhone(phone)).toEqual([]);
  });

  it('does not touch an unrelated customer', () => {
    const target = '573001112233';
    const other = '573009998877';
    seedCustomer(target, 'wamid.TARGET');
    seedCustomer(other, 'wamid.OTHER');

    repos.customerData.deleteCustomer(target);

    expect(repos.conversation.getByPhone(other)).toBeDefined();
    expect(repos.dedupe.isProcessed('wamid.OTHER')).toBe(true);
    expect(repos.bridgeSession.getByCustomer(other)).not.toBeNull();
  });

  it('returns zero counts for an unknown phone', () => {
    const result = repos.customerData.deleteCustomer('570000000000');
    expect(result).toEqual({
      conversations: 0,
      messages: 0,
      processedMessages: 0,
      aiUsage: 0,
      ownerAlerts: 0,
      mediaSends: 0,
      bridgeSessions: 0,
      followupConsent: 0,
      followupConsentGrants: 0,
      followupEvents: 0,
      followupSubscriptions: 0,
      followupSubscriptionEvents: 0,
    });
  });
});
