import Database from 'better-sqlite3';
import { chmodSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { canonicalizeDateText } from '../services/date-canonicalizer.js';

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(existing => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

export function migrate(db: Database.Database): void {
  const schemaPath = new URL('./schema.sql', import.meta.url);
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // DESTROYING: drops the retired multi-track follow-up audit table. The current
  // one-shot template feature uses the separate `followup_events` /
  // `followup_consent` tables created in schema.sql — it does NOT read this one,
  // and its columns are incompatible. Export `follow_up_events` before deploy if
  // the old history is still needed. Orphan `conversations` columns from the
  // removed feature (follow_up_*, consent_*, template_*) are left in place;
  // SQLite cannot cheaply DROP COLUMN and code ignores them.
  db.exec('DROP TABLE IF EXISTS follow_up_events');
  db.exec('DROP INDEX IF EXISTS idx_follow_up_events_customer_anchor_stage');

  addColumnIfMissing(db, 'messages', 'app_version', 'TEXT');
  addColumnIfMissing(db, 'messages', 'media_id', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'handed_off_at', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'price_given_at', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'collected_pet', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'soft_closed_at', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'collected_plan', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'sales_phase', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'lead_intent', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'assigned_line_id', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'assigned_agent_chat', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'conversation_mode', "TEXT DEFAULT 'bot'");
  addColumnIfMissing(db, 'conversations', 'converted_at', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'gallery_nudged_at', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'lead_pain', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'lead_pain_detail', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'lead_pain_detected_at', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'selected_experience_id', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'ad_referral_json', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'entry_marker', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'entry_temperature', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'entry_marker_at', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'collected_adults', 'INTEGER');
  addColumnIfMissing(db, 'conversations', 'collected_children', 'INTEGER');
  addColumnIfMissing(db, 'conversations', 'collected_child_ages_json', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'collected_travel_origin', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'collected_date_canon_year', 'INTEGER');
  addColumnIfMissing(db, 'conversations', 'collected_date_canon_month', 'INTEGER');
  addColumnIfMissing(db, 'conversations', 'collected_date_canon_day', 'INTEGER');
  addColumnIfMissing(db, 'conversations', 'collected_date_window', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'date_status', "TEXT NOT NULL DEFAULT 'unasked'");
  // `opt_out_at` predates schema.sql in some very old DBs; ensure it before the
  // backfill reads it (same ensure-then-backfill pattern as date_status below).
   addColumnIfMissing(db, 'conversations', 'opt_out_at', 'TEXT');
   addColumnIfMissing(db, 'conversations', 'last_opt_out_at', 'TEXT');
   addColumnIfMissing(db, 'followup_subscriptions', 'deferred_reask_used', 'INTEGER NOT NULL DEFAULT 0');
   addColumnIfMissing(db, 'followup_consent_grants', 'actor_id', 'TEXT');
   // Backfill the compliance record for leads who opted out before the column existed.
   db.exec('UPDATE conversations SET last_opt_out_at = opt_out_at WHERE last_opt_out_at IS NULL AND opt_out_at IS NOT NULL');
   // Add consent session tracking so cycle keys survive a dead cycle (c1, c2, ... per session).
   // Backfill: count attempted consent_ask events (status != 'due') to derive the session.
   if (addColumnIfMissing(db, 'followup_subscriptions', 'consent_session', 'INTEGER NOT NULL DEFAULT 1')) {
     db.exec(`
       UPDATE followup_subscriptions
       SET consent_session = 1 + COALESCE((
         SELECT COUNT(*)
         FROM followup_subscription_events
         WHERE customer_phone = followup_subscriptions.customer_phone
           AND event_kind = 'consent_ask'
           AND status IN ('claimed', 'accepted', 'delivered', 'uncertain', 'failed')
       ), 0)
       WHERE consent_session = 1
     `);
   }

  // Backfill date_status from legacy collected_date / window sentinels.
  db.exec(`
    UPDATE conversations
    SET date_status = CASE
      WHEN collected_date_window IS NOT NULL AND TRIM(collected_date_window) != '' THEN 'window'
      WHEN collected_date IS NOT NULL
        AND collected_date != 'tentative_unknown'
        AND collected_date NOT LIKE '\\_%' ESCAPE '\\' THEN 'selected'
      WHEN collected_date = 'tentative_unknown'
        OR collected_date LIKE '\\_%' ESCAPE '\\' THEN 'deferred'
      ELSE COALESCE(NULLIF(date_status, ''), 'unasked')
    END
  `);
  const legacyDates = db.prepare(`
    SELECT customer_phone, collected_date
    FROM conversations
    WHERE collected_date IS NOT NULL
      AND collected_date_canon_year IS NULL
  `).all() as Array<{ customer_phone: string; collected_date: string }>;
  const backfillCanonicalDate = db.prepare(`
    UPDATE conversations
    SET collected_date_canon_year = ?, collected_date_canon_month = ?, collected_date_canon_day = ?
    WHERE customer_phone = ?
  `);
  const backfill = db.transaction(() => {
    for (const row of legacyDates) {
      if (!/\b20\d{2}\b/.test(row.collected_date)) continue;
      const canonical = canonicalizeDateText(row.collected_date);
      if (canonical) {
        backfillCanonicalDate.run(canonical.year, canonical.month, canonical.day, row.customer_phone);
      }
    }
  });
  backfill();
  db.exec(`
    UPDATE conversations
    SET collected_date = NULL
    WHERE collected_date = 'tentative_unknown'
       OR collected_date LIKE '\\_%' ESCAPE '\\'
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS bridge_sessions (
    agent_chat_id TEXT PRIMARY KEY,
    customer_phone TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    return_mode TEXT NOT NULL DEFAULT 'bot'
  )`);
  addColumnIfMissing(db, 'bridge_sessions', 'return_mode', "TEXT NOT NULL DEFAULT 'bot'");
  db.exec(`CREATE TABLE IF NOT EXISTS payment_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_reference TEXT NOT NULL UNIQUE,
    customer_phone TEXT NOT NULL,
    preference_id TEXT UNIQUE,
    payment_url TEXT,
    expected_amount_cop INTEGER NOT NULL,
    plan_id TEXT,
    booking_date TEXT,
    people INTEGER,
    transport_need TEXT,
    deposit_percent INTEGER,
    availability_confirmed_at TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    mercado_pago_payment_id TEXT UNIQUE
  )`);
  addColumnIfMissing(db, 'payment_reservations', 'payment_url', 'TEXT');
  addColumnIfMissing(db, 'payment_reservations', 'plan_id', 'TEXT');
  addColumnIfMissing(db, 'payment_reservations', 'booking_date', 'TEXT');
  addColumnIfMissing(db, 'payment_reservations', 'people', 'INTEGER');
  addColumnIfMissing(db, 'payment_reservations', 'transport_need', 'TEXT');
  addColumnIfMissing(db, 'payment_reservations', 'deposit_percent', 'INTEGER');
  addColumnIfMissing(db, 'payment_reservations', 'availability_confirmed_at', 'TEXT');
  try {
    db.exec('ALTER TABLE ai_usage ADD COLUMN purpose TEXT DEFAULT \'reply\'');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE ai_usage ADD COLUMN success INTEGER DEFAULT 1');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE ai_usage ADD COLUMN error_type TEXT');
  } catch {
    // column already exists — safe to ignore
  }
}

export function createAndMigrate(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(dbPath), 0o700);
  }
  const db = new Database(dbPath);
  migrate(db);
  db.pragma('journal_mode = WAL');
  if (dbPath !== ':memory:') {
    chmodSync(dbPath, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      const runtimePath = `${dbPath}${suffix}`;
      if (existsSync(runtimePath)) chmodSync(runtimePath, 0o600);
    }
  }
  return db;
}
