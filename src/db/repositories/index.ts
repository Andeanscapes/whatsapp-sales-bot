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
} from './sqlite-repos.js';

export function createRepositories(db: Database.Database): Repositories {
  return {
    conversation: new SqliteConversationRepo(db),
    message: new SqliteMessageRepo(db),
    dedupe: new SqliteDedupeRepo(db),
    optOut: new SqliteOptOutRepo(db),
    aiCache: new SqliteAiCacheRepo(db),
    aiUsage: new SqliteAiUsageRepo(db),
    ownerAlert: new SqliteOwnerAlertRepo(db),
    mediaSend: new SqliteMediaSendRepo(db),
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
