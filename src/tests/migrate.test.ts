import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAndMigrate, migrate } from '../db/migrate.js';

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

  it('restricts runtime database directory and file permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'andean-db-'));
    const dataDir = join(root, 'data');
    const dbPath = join(dataDir, 'bot.sqlite');

    const db = createAndMigrate(dbPath);
    db.close();

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    rmSync(root, { recursive: true, force: true });
  });
});
