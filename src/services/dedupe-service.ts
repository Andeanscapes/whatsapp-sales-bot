import type Database from 'better-sqlite3';

export function isProcessed(db: Database.Database, messageId: string): boolean {
  const row = db.prepare('SELECT 1 FROM processed_webhook_messages WHERE whatsapp_message_id = ?').get(messageId);
  return !!row;
}

export function markProcessed(db: Database.Database, messageId: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO processed_webhook_messages (whatsapp_message_id, processed_at) VALUES (?, ?)'
  ).run(messageId, new Date().toISOString());
}
