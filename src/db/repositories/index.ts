import type Database from 'better-sqlite3';
import type { Repositories } from './types.js';
import {
  SqliteConversationRepo,
  SqliteMessageRepo,
  SqliteOutboundMediaRepo,
  SqliteDedupeRepo,
  SqliteOptOutRepo,
  SqliteAiCacheRepo,
  SqliteAiUsageRepo,
  SqliteOwnerAlertRepo,
  SqliteMediaSendRepo,
  SqliteBridgeSessionRepo,
  SqliteStatsRepo,
  SqliteSystemErrorRepo,
  SqliteCustomerDataRepo,
  SqliteTranscriptRepo,
  SqlitePaymentReservationRepo,
  SqliteFollowupConsentRepo,
  SqliteFollowupConsentGrantRepo,
  SqliteFollowupSubscriptionRepo,
  SqliteFollowupEventRepo,
  SqliteFollowupSubscriptionEventRepo,
} from './sqlite-repos.js';

export function createRepositories(db: Database.Database): Repositories {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS bot_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  } catch {
    // table already exists — safe to ignore
  }

  return {
    followupConsent: new SqliteFollowupConsentRepo(db),
    followupConsentGrant: new SqliteFollowupConsentGrantRepo(db),
    followupSubscription: new SqliteFollowupSubscriptionRepo(db),
    followupEvent: new SqliteFollowupEventRepo(db), // LIVE: one-shot post-24h template
    followupSubscriptionEvent: new SqliteFollowupSubscriptionEventRepo(db),
    conversation: new SqliteConversationRepo(db),
    message: new SqliteMessageRepo(db),
    outboundMedia: new SqliteOutboundMediaRepo(db),
    dedupe: new SqliteDedupeRepo(db),
    optOut: new SqliteOptOutRepo(db),
    aiCache: new SqliteAiCacheRepo(db),
    aiUsage: new SqliteAiUsageRepo(db),
    ownerAlert: new SqliteOwnerAlertRepo(db),
    mediaSend: new SqliteMediaSendRepo(db),
    paymentReservation: new SqlitePaymentReservationRepo(db),
    bridgeSession: new SqliteBridgeSessionRepo(db),
    stats: new SqliteStatsRepo(db),
    systemErrors: new SqliteSystemErrorRepo(db),
    customerData: new SqliteCustomerDataRepo(db),
    transcripts: new SqliteTranscriptRepo(db),
    runInTransaction(operation: () => void): void {
      db.transaction(operation)();
    },
    isPaused(): boolean {
      const row = db.prepare("SELECT value FROM bot_config WHERE key = 'paused'").get() as { value: string } | undefined;
      return row?.value === 'true';
    },
    setPaused(paused: boolean): void {
      db.prepare(
        "INSERT INTO bot_config (key, value, updated_at) VALUES ('paused', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
      ).run(paused ? 'true' : 'false', paused ? 'true' : 'false');
    },
    claimPeriodicJob(jobKey: string, periodKey: string): boolean {
      // The WHERE on the upsert is what makes this a claim: `changes` reports
      // whether THIS caller moved the row. A read-then-write would let two ticks
      // both pass.
      //
      // `<` and not `!=`: the claim must be monotonic. Inequality also accepts an
      // EARLIER period, which would rewind the marker and let an already-delivered
      // period be claimed a second time. Period keys must therefore sort
      // lexicographically in chronological order (`YYYY-MM-DD` does).
      const info = db.prepare(
        `INSERT INTO bot_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
         WHERE bot_config.value < excluded.value`
      ).run(jobKey, periodKey);
      return info.changes > 0;
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
