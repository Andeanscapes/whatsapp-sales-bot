import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';

const PHONE = '573001112233';

/**
 * Phase B behaviour lock.
 *
 * A customer photo in the plain bot path used to be dropped without a row, so it
 * could never be replayed. Storing it advances `getLastInboundAt`, which is the
 * anchor for the 24h service window AND for all three follow-up schedules. That
 * shift is intentional and more correct (Meta measures the window from ANY
 * customer message), but it must only ever move follow-ups LATER, never earlier,
 * and it must never consume outbound rate budget.
 */
describe('inbound media persistence', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    repos.conversation.upsert(PHONE, { language: 'es' });
  });

  afterEach(() => db.close());

  function storeInboundPhoto(at: string, caption = '', mediaId = 'wamid.MEDIA1'): void {
    repos.message.addMessage({
      whatsapp_message_id: `in-${at}`,
      customer_phone: PHONE,
      direction: 'inbound',
      message_type: 'image',
      body: caption,
      created_at: at,
      media_id: mediaId,
    });
  }

  it('round-trips the WhatsApp media id so a replay can re-download it', () => {
    storeInboundPhoto('2026-08-20T10:00:00.000Z', 'miren', 'wamid.ABC');

    const [message] = repos.message.getRecentMessages(PHONE, 5);
    expect(message.mediaId).toBe('wamid.ABC');
    expect(message.messageType).toBe('image');
    expect(message.role).toBe('user');
  });

  it('keeps the WhatsApp caption as the body, matching the other inbound sites', () => {
    storeInboundPhoto('2026-08-20T10:00:00.000Z', 'esta es la foto');
    expect(repos.message.getLastInboundBody(PHONE)).toBe('esta es la foto');
  });

  it('advances getLastInboundAt — the 24h window follows any customer message', () => {
    repos.message.addMessage({
      whatsapp_message_id: 'in-text',
      customer_phone: PHONE,
      direction: 'inbound',
      message_type: 'text',
      body: 'hola',
      created_at: '2026-08-20T08:00:00.000Z',
    });
    expect(repos.message.getLastInboundAt(PHONE)).toBe('2026-08-20T08:00:00.000Z');

    storeInboundPhoto('2026-08-20T09:00:00.000Z');

    // Later, never earlier: follow-ups anchored here can only be postponed.
    expect(repos.message.getLastInboundAt(PHONE)).toBe('2026-08-20T09:00:00.000Z');
  });

  it('does not consume the outbound message rate budget', () => {
    storeInboundPhoto('2026-08-20T10:00:00.000Z');
    expect(repos.message.countOutboundSince(PHONE, '2026-08-20T00:00:00.000Z')).toBe(0);
    expect(repos.message.countOutboundSince(PHONE, '2026-08-20T00:00:00.000Z', 'text')).toBe(0);
  });

  it('does not write anything to the outbound media ledger', () => {
    storeInboundPhoto('2026-08-20T10:00:00.000Z');
    // Inbound attribution lives on messages.media_id; the ledger is outbound-only.
    expect(repos.outboundMedia.listByPhone(PHONE)).toEqual([]);
  });

  it('is deduped by whatsapp_message_id so a webhook retry cannot double-store', () => {
    storeInboundPhoto('2026-08-20T10:00:00.000Z');
    storeInboundPhoto('2026-08-20T10:00:00.000Z');

    const rows = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE customer_phone = ?').get(PHONE) as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('makes a photo the last message direction, so recurring templates see an active customer', () => {
    repos.message.addMessage({
      customer_phone: PHONE,
      direction: 'outbound',
      message_type: 'text',
      body: 'te escribo luego',
      created_at: '2026-08-20T09:00:00.000Z',
    });
    expect(repos.message.getLastMessageDirection(PHONE)).toBe('outbound');

    storeInboundPhoto('2026-08-20T10:00:00.000Z');

    // Recurring templates require the last message to be OURS, so this
    // suppresses a send rather than triggering one.
    expect(repos.message.getLastMessageDirection(PHONE)).toBe('inbound');
  });

  it('leaves a text-only history byte-identical (no behaviour drift for the common path)', () => {
    repos.message.addMessage({
      whatsapp_message_id: 'in-1',
      customer_phone: PHONE,
      direction: 'inbound',
      message_type: 'text',
      body: 'hola',
      created_at: '2026-08-20T10:00:00.000Z',
    });
    repos.message.addMessage({
      customer_phone: PHONE,
      direction: 'outbound',
      message_type: 'text',
      body: 'hola, como estas?',
      created_at: '2026-08-20T10:00:01.000Z',
    });

    expect(repos.message.getRecentMessages(PHONE, 21).map(m => ({ role: m.role, content: m.content, messageType: m.messageType }))).toEqual([
      { role: 'user', content: 'hola', messageType: 'text' },
      { role: 'assistant', content: 'hola, como estas?', messageType: 'text' },
    ]);
  });
});
