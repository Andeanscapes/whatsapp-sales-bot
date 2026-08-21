import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import type { Repositories } from '../db/repositories/index.js';
import type { OutboundMediaRow } from '../db/repositories/types.js';

const PHONE = '573001112233';
const OTHER = '573004445566';

function row(overrides: Partial<OutboundMediaRow> = {}): OutboundMediaRow {
  return {
    customer_phone: PHONE,
    media_url: 'https://cdn.example.com/a.jpg',
    media_id: 'gallery_/a.jpg',
    caption: '',
    carried_reply: 0,
    flow: 'requested_gallery',
    sent_at: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('outbound media ledger repository', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
  });

  afterEach(() => db.close());

  it('persists every replay field, including an empty caption', () => {
    repos.outboundMedia.record(row({
      caption: '',
      carried_reply: 1,
      theme_site_id: 'chivor',
      theme_type: 'mine',
      turn_inbound_message_id: 'wamid.IN1',
      sequence: 2,
    }));

    const [stored] = repos.outboundMedia.listByPhone(PHONE);
    expect(stored.media_url).toBe('https://cdn.example.com/a.jpg');
    expect(stored.media_id).toBe('gallery_/a.jpg');
    // Empty string must survive as empty, not become null-ish: it means
    // "delivered with no caption", which is different from unknown.
    expect(stored.caption).toBe('');
    expect(stored.carried_reply).toBe(1);
    expect(stored.theme_site_id).toBe('chivor');
    expect(stored.theme_type).toBe('mine');
    expect(stored.turn_inbound_message_id).toBe('wamid.IN1');
    expect(stored.sequence).toBe(2);
  });

  it('scopes listByPhone to the conversation and returns newest first', () => {
    repos.outboundMedia.record(row({ sent_at: '2026-08-20T10:00:00.000Z', media_url: 'https://cdn.example.com/old.jpg' }));
    repos.outboundMedia.record(row({ sent_at: '2026-08-20T12:00:00.000Z', media_url: 'https://cdn.example.com/new.jpg' }));
    repos.outboundMedia.record(row({ customer_phone: OTHER, media_url: 'https://cdn.example.com/other.jpg' }));

    const mine = repos.outboundMedia.listByPhone(PHONE);
    expect(mine).toHaveLength(2);
    expect(mine[0].media_url).toBe('https://cdn.example.com/new.jpg');
    expect(mine.map(r => r.media_url)).not.toContain('https://cdn.example.com/other.jpg');
  });






  it('keeps media_sends untouched — the rate-limit ledger must not gain replay data', () => {
    repos.outboundMedia.record(row());
    const mediaSends = db.prepare('SELECT COUNT(*) as cnt FROM media_sends').get() as { cnt: number };
    expect(mediaSends.cnt).toBe(0);
  });
});
