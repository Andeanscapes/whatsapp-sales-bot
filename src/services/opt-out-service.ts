import type Database from 'better-sqlite3';

export function isOptedOut(db: Database.Database, phone: string): boolean {
  const row = db.prepare('SELECT opt_out_at FROM conversations WHERE customer_phone = ?').get(phone) as { opt_out_at: string | null } | undefined;
  return row?.opt_out_at != null;
}

export function setOptOut(db: Database.Database, phone: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO conversations (customer_phone, opt_out_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(customer_phone) DO UPDATE SET opt_out_at = ?'
  ).run(phone, now, now, now, now);
}
