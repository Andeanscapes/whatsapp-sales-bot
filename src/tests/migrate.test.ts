import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAndMigrate, migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';

describe('migrate', () => {
  it('creates followup_consent and followup_events tables on migrate', () => {
    const db = new Database(':memory:');

    expect(() => migrate(db)).not.toThrow();
    const consentTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='followup_consent'").all();
    const eventTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='followup_events'").all();
    expect(consentTables.length).toBe(1);
    expect(eventTables.length).toBe(1);
    const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
    expect(conversationColumns.map(column => column.name)).toContain('collected_date_window');
    expect(conversationColumns.map(column => column.name)).toContain('date_status');
    db.close();
  });

  it('creates the outbound_media replay ledger and the messages.media_id column', () => {
    const db = new Database(':memory:');
    migrate(db);

    const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map(row => row.name);
    expect(tableNames).toContain('outbound_media');

    const ledgerColumns = (db.prepare('PRAGMA table_info(outbound_media)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(ledgerColumns).toEqual(expect.arrayContaining([
      'customer_phone', 'media_url', 'media_id', 'caption', 'carried_reply',
      'flow', 'theme_site_id', 'theme_type', 'turn_inbound_message_id', 'sequence', 'sent_at',
    ]));

    // Inbound photos are attributed on `messages`, not in the outbound ledger.
    const messageColumns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(messageColumns).toContain('media_id');

    // media_sends must stay a pure rate-limit ledger — no url/caption leakage.
    const mediaSendColumns = (db.prepare('PRAGMA table_info(media_sends)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(mediaSendColumns).not.toContain('media_url');
    expect(mediaSendColumns).not.toContain('caption');

    db.close();
  });

  it('adds messages.media_id to a legacy database that predates it', () => {
    const db = new Database(':memory:');
    // Simulate an old DB: the table exists without the column.
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        whatsapp_message_id TEXT UNIQUE,
        customer_phone TEXT NOT NULL,
        direction TEXT NOT NULL,
        message_type TEXT NOT NULL,
        body TEXT,
        created_at TEXT NOT NULL,
        raw_json TEXT
      )
    `);

    expect(() => migrate(db)).not.toThrow();
    const columns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(columns).toContain('media_id');
    expect(columns).toContain('app_version');

    // Idempotent: a second run must not throw on the existing column.
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  it('creates the consent follow-up foundation tables without touching the live one-shot table', () => {
    const db = new Database(':memory:');
    migrate(db);

    const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map(row => row.name);
    expect(tableNames).toContain('followup_subscriptions');
    expect(tableNames).toContain('followup_subscription_events');
    const subscriptionColumns = (db.prepare('PRAGMA table_info(followup_subscriptions)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(subscriptionColumns).toContain('deferred_reask_used');
    expect(subscriptionColumns).toContain('consent_session');

    // The live one-shot table keeps its anchor-based shape; the new ledger is separate.
    const liveColumns = (db.prepare('PRAGMA table_info(followup_events)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(liveColumns).toContain('anchor_at');
    expect(liveColumns).not.toContain('event_kind');

    const ledgerColumns = (db.prepare('PRAGMA table_info(followup_subscription_events)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(ledgerColumns).toEqual(expect.arrayContaining(['event_kind', 'cycle_key', 'scheduled_for', 'claim_token']));

    db.close();
  });

  /**
   * The consent cycle key is derived from `consent_session`. A legacy row would
   * default to 1 and therefore reuse `c1` — a key whose attempts may already be
   * spent, which is exactly the "never asked again" bug. The backfill has to lift
   * the session past every ask already attempted.
   */
  it('backfills consent_session past previously attempted asks on a legacy database', () => {
    const db = new Database(':memory:');
    migrate(db);

    // Simulate a pre-column database: drop the column by rebuilding the table.
    db.exec(`
      ALTER TABLE followup_subscriptions RENAME TO followup_subscriptions_old;
      CREATE TABLE followup_subscriptions (
        customer_phone TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'unasked',
        asked_at TEXT,
        ask_outbound_message_id TEXT,
        ask_attempts INTEGER DEFAULT 0,
        deferred_reask_used INTEGER NOT NULL DEFAULT 0,
        decided_at TEXT,
        decision_inbound_message_id TEXT,
        consent_source TEXT,
        activated_at TEXT,
        revoked_at TEXT,
        revoke_source TEXT,
        updated_at TEXT
      );
      DROP TABLE followup_subscriptions_old;
    `);
    db.prepare("INSERT INTO followup_subscriptions (customer_phone, status) VALUES ('57300111', 'unasked')").run();
    db.prepare("INSERT INTO followup_subscriptions (customer_phone, status) VALUES ('57300222', 'unasked')").run();
    // 57300111 already had two asks reach Meta; 57300222 has none.
    db.prepare(`INSERT INTO followup_subscription_events
      (customer_phone, event_kind, cycle_key, scheduled_for, status, accepted_at, attempts)
      VALUES ('57300111', 'consent_ask', 'c1', datetime('now'), 'accepted', datetime('now'), 1)`).run();
    db.prepare(`INSERT INTO followup_subscription_events
      (customer_phone, event_kind, cycle_key, scheduled_for, status, failed_at, attempts)
      VALUES ('57300111', 'consent_ask', 'c2', datetime('now'), 'failed', datetime('now'), 3)`).run();
    // A recurring event must not count toward the consent session.
    db.prepare(`INSERT INTO followup_subscription_events
      (customer_phone, event_kind, cycle_key, scheduled_for, status, accepted_at, attempts)
      VALUES ('57300222', 'recurring', 'c1-r1', datetime('now'), 'accepted', datetime('now'), 1)`).run();

    expect(() => migrate(db)).not.toThrow();

    const sessionOf = (phone: string): number => (db
      .prepare('SELECT consent_session FROM followup_subscriptions WHERE customer_phone = ?')
      .get(phone) as { consent_session: number }).consent_session;

    // Two attempted asks (c1 accepted, c2 failed) => next free key is c3.
    expect(sessionOf('57300111')).toBe(3);
    // No consent asks at all => stays on the first session.
    expect(sessionOf('57300222')).toBe(1);

    // Idempotent: a second run must not shift the sessions again.
    expect(() => migrate(db)).not.toThrow();
    expect(sessionOf('57300111')).toBe(3);
    expect(sessionOf('57300222')).toBe(1);
    db.close();
  });

  it('enforces one subscription event per (phone, kind, cycle)', () => {
    const db = new Database(':memory:');
    migrate(db);

    const insert = db.prepare(
      `INSERT INTO followup_subscription_events (customer_phone, event_kind, cycle_key, scheduled_for)
       VALUES (?, ?, ?, datetime('now'))`
    );
    insert.run('573000000001', 'recurring', 'r1');
    expect(() => insert.run('573000000001', 'recurring', 'r1')).toThrow();
    // The next cycle index for the same customer is allowed.
    expect(() => insert.run('573000000001', 'recurring', 'r2')).not.toThrow();
    // So is a different phase for the same customer.
    expect(() => insert.run('573000000001', 'consent_ask', 'c1')).not.toThrow();

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
    ).run('2', 't', 't', '15 de agosto de 2027');
    db.prepare(
      'INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, collected_date_window) VALUES (?, ?, ?, ?)'
    ).run('3', 't', 't', 'después de noviembre');

    migrate(db);

    const rows = db.prepare(`
      SELECT customer_phone, collected_date, date_status,
        collected_date_canon_year, collected_date_canon_month, collected_date_canon_day
      FROM conversations ORDER BY customer_phone
    `).all() as Array<{
      customer_phone: string;
      collected_date: string | null;
      date_status: string;
      collected_date_canon_year: number | null;
      collected_date_canon_month: number | null;
      collected_date_canon_day: number | null;
    }>;
    expect(rows[0]).toMatchObject({ customer_phone: '1', collected_date: null, date_status: 'deferred' });
    expect(rows[1]).toMatchObject({ customer_phone: '2', collected_date: '15 de agosto de 2027', date_status: 'selected' });
    expect(rows[1]).toMatchObject({ collected_date_canon_month: 8, collected_date_canon_day: 15 });
    expect(rows[2]).toMatchObject({ customer_phone: '3', date_status: 'window' });
    db.close();
  });

  it('does not invent a migration-year for ambiguous legacy dates', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT NOT NULL UNIQUE,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      collected_date TEXT
    )`);
    db.prepare(
      'INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, collected_date) VALUES (?, ?, ?, ?)'
    ).run('ambiguous', '2025-01-01', '2025-01-01', 'septiembre');

    migrate(db);

    expect(db.prepare(
      'SELECT collected_date_canon_year FROM conversations WHERE customer_phone = ?'
    ).get('ambiguous')).toEqual({ collected_date_canon_year: null });
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

  it('adds the deferred re-ask flag to legacy follow-up subscriptions', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE followup_subscriptions (
      customer_phone TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'unasked',
      asked_at TEXT,
      ask_outbound_message_id TEXT,
      ask_attempts INTEGER DEFAULT 0,
      decided_at TEXT,
      decision_inbound_message_id TEXT,
      consent_source TEXT,
      activated_at TEXT,
      revoked_at TEXT,
      revoke_source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    migrate(db);

    const columns = db.prepare('PRAGMA table_info(followup_subscriptions)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toContain('deferred_reask_used');
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
