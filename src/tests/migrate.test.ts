import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAndMigrate, migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';

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
    expect(conversationColumns.map(column => column.name)).toContain('date_status');
    db.close();
  });

  it('backfills date_status from legacy tentative_unknown and real dates', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT NOT NULL UNIQUE,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      collected_date TEXT,
      collected_date_window TEXT
    )`);
    db.prepare(
      'INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, collected_date) VALUES (?, ?, ?, ?)'
    ).run('1', 't', 't', 'tentative_unknown');
    db.prepare(
      'INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, collected_date) VALUES (?, ?, ?, ?)'
    ).run('2', 't', 't', '15 de agosto');
    db.prepare(
      'INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, collected_date_window) VALUES (?, ?, ?, ?)'
    ).run('3', 't', 't', 'después de noviembre');

    migrate(db);

    const rows = db.prepare('SELECT customer_phone, collected_date, date_status FROM conversations ORDER BY customer_phone').all() as Array<{
      customer_phone: string;
      collected_date: string | null;
      date_status: string;
    }>;
    expect(rows[0]).toMatchObject({ customer_phone: '1', collected_date: null, date_status: 'deferred' });
    expect(rows[1]).toMatchObject({ customer_phone: '2', collected_date: '15 de agosto', date_status: 'selected' });
    expect(rows[2]).toMatchObject({ customer_phone: '3', date_status: 'window' });
    db.close();
  });

  it('does not discard a selected date or date window when options are offered', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);

    repos.conversation.setSelectedDate('selected', '29 de agosto');
    repos.conversation.setDateOptionsOffered('selected');
    expect(repos.conversation.getDateStatus('selected')).toBe('selected');
    expect(repos.conversation.getByPhone('selected')?.collected_date).toBe('29 de agosto');

    repos.conversation.setCollectedDateWindow('window', 'después de noviembre');
    repos.conversation.setDateOptionsOffered('window');
    expect(repos.conversation.getDateStatus('window')).toBe('window');
    expect(repos.conversation.getCollectedDateWindow('window')).toBe('después de noviembre');

    db.close();
  });

  it('rolls back outbound persistence and date state together', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    repos.conversation.upsert('transaction', {});

    expect(() => repos.runInTransaction(() => {
      repos.message.addMessage({
        customer_phone: 'transaction',
        direction: 'outbound',
        message_type: 'text',
        body: 'Pregunta de fecha',
        created_at: new Date().toISOString(),
      });
      repos.conversation.setDateAsked('transaction');
      throw new Error('state persistence failed');
    })).toThrow('state persistence failed');

    expect(repos.message.getLastOutboundBody('transaction')).toBeNull();
    expect(repos.conversation.getDateStatus('transaction')).toBe('unasked');
    db.close();
  });

  it('adds immutable booking snapshot fields to legacy payment reservations', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE payment_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_reference TEXT NOT NULL UNIQUE,
      customer_phone TEXT NOT NULL,
      preference_id TEXT UNIQUE,
      expected_amount_cop INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_at TEXT,
      mercado_pago_payment_id TEXT UNIQUE
    )`);

    migrate(db);

    const columns = db.prepare('PRAGMA table_info(payment_reservations)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'plan_id',
      'payment_url',
      'booking_date',
      'people',
      'transport_need',
      'deposit_percent',
      'availability_confirmed_at',
    ]));
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
