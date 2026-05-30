import type Database from 'better-sqlite3';

/**
 * Test-only direct DB helpers. NEVER use these in production code.
 * Production code must go through src/db/repositories/.
 */

export function insertMediaSendAt(db: Database.Database, phone: string, mediaId: string, sentAtIso: string): void {
  db.prepare(
    'INSERT INTO media_sends (customer_phone, media_id, sent_at) VALUES (?, ?, ?)'
  ).run(phone, mediaId, sentAtIso);
}

export function getLatestOwnerAlertBody(db: Database.Database, phone: string): string | undefined {
  const row = db.prepare(
    'SELECT body FROM owner_alerts WHERE customer_phone = ? ORDER BY sent_at DESC LIMIT 1'
  ).get(phone) as { body: string } | undefined;
  return row?.body;
}
