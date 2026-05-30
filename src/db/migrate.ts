import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function migrate(db: Database.Database): void {
  const schemaPath = new URL('./schema.sql', import.meta.url);
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
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
}

export function createAndMigrate(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  migrate(db);
  db.pragma('journal_mode = WAL');
  return db;
}
