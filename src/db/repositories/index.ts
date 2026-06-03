import type Database from 'better-sqlite3';
import type { Repositories } from './types.js';
import {
  SqliteConversationRepo,
  SqliteMessageRepo,
  SqliteDedupeRepo,
  SqliteOptOutRepo,
  SqliteAiCacheRepo,
  SqliteAiUsageRepo,
  SqliteOwnerAlertRepo,
  SqliteMediaSendRepo,
  SqliteBridgeSessionRepo,
  SqliteStatsRepo,
} from './sqlite-repos.js';

export function createRepositories(db: Database.Database): Repositories {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS bot_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  } catch {
    // table already exists — safe to ignore
  }

  return {
    conversation: new SqliteConversationRepo(db),
    message: new SqliteMessageRepo(db),
    dedupe: new SqliteDedupeRepo(db),
    optOut: new SqliteOptOutRepo(db),
    aiCache: new SqliteAiCacheRepo(db),
    aiUsage: new SqliteAiUsageRepo(db),
    ownerAlert: new SqliteOwnerAlertRepo(db),
    mediaSend: new SqliteMediaSendRepo(db),
    bridgeSession: new SqliteBridgeSessionRepo(db),
    stats: new SqliteStatsRepo(db),
    isPaused(): boolean {
      const row = db.prepare("SELECT value FROM bot_config WHERE key = 'paused'").get() as { value: string } | undefined;
      return row?.value === 'true';
    },
    setPaused(paused: boolean): void {
      db.prepare(
        "INSERT INTO bot_config (key, value, updated_at) VALUES ('paused', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
      ).run(paused ? 'true' : 'false', paused ? 'true' : 'false');
    },
    ping(): boolean {
      try {
        db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type { Repositories };
export type * from './types.js';
