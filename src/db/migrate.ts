import Database from 'better-sqlite3';
import { chmodSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(existing => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function migrate(db: Database.Database): void {
  const schemaPath = new URL('./schema.sql', import.meta.url);
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  try {
    db.exec('ALTER TABLE messages ADD COLUMN app_version TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN handed_off_at TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN price_given_at TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN collected_pet TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN soft_closed_at TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN collected_plan TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN sales_phase TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN lead_intent TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN assigned_line_id TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN assigned_agent_chat TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN conversation_mode TEXT DEFAULT 'bot'");
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN converted_at TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN gallery_nudged_at TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN follow_up_sent_at TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN lead_pain TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN lead_pain_detail TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN lead_pain_detected_at TEXT');
  } catch {
    // column already exists — safe to ignore
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN follow_up_reply_count INTEGER DEFAULT 0');
  } catch {
    // column already exists — safe to ignore
  }
  db.exec(`CREATE TABLE IF NOT EXISTS follow_up_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    stage TEXT NOT NULL,
    anchor_inbound_at TEXT,
    claimed_at TEXT,
    decision_reason TEXT,
    sent_at TEXT,
    replied_at TEXT,
    score_before INTEGER DEFAULT 0,
    score_after INTEGER,
    detected_pain TEXT,
    status TEXT NOT NULL DEFAULT 'sent'
  )`);
  addColumnIfMissing(db, 'follow_up_events', 'anchor_inbound_at', 'TEXT');
  addColumnIfMissing(db, 'follow_up_events', 'decision_reason', 'TEXT');
  addColumnIfMissing(db, 'follow_up_events', 'claimed_at', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'collected_date_window', 'TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_follow_up_events_customer_anchor_stage
    ON follow_up_events(customer_phone, anchor_inbound_at, stage)
    WHERE anchor_inbound_at IS NOT NULL`);
  db.exec(`CREATE TABLE IF NOT EXISTS bridge_sessions (
    agent_chat_id TEXT PRIMARY KEY,
    customer_phone TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  )`);
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
