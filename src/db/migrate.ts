import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

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
    sent_at TEXT,
    replied_at TEXT,
    score_before INTEGER DEFAULT 0,
    score_after INTEGER,
    detected_pain TEXT,
    status TEXT NOT NULL DEFAULT 'sent'
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS bridge_sessions (
    agent_chat_id TEXT PRIMARY KEY,
    customer_phone TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  )`);
}

export function createAndMigrate(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  migrate(db);
  db.pragma('journal_mode = WAL');
  return db;
}
