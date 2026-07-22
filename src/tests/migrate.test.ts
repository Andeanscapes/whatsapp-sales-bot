import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';

describe('migrate', () => {
  it('upgrades the legacy follow_up_events table before creating its unique index', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE follow_up_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      stage TEXT NOT NULL,
      sent_at TEXT,
      replied_at TEXT,
      score_before INTEGER DEFAULT 0,
      score_after INTEGER,
      detected_pain TEXT,
      status TEXT NOT NULL DEFAULT 'sent'
    )`);

    expect(() => migrate(db)).not.toThrow();
    const columns = db.prepare('PRAGMA table_info(follow_up_events)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(['anchor_inbound_at', 'claimed_at', 'decision_reason']));
    const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
    expect(conversationColumns.map(column => column.name)).toContain('collected_date_window');
    db.close();
  });
});
