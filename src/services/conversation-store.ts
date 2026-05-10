import type Database from 'better-sqlite3';

const ALLOWED_CONVERSATION_COLUMNS = new Set([
  'language', 'lead_score', 'last_seen_at', 'opt_out_at', 'handed_off_at',
  'collected_name', 'collected_date', 'collected_people',
  'collected_transport_need', 'collected_lodging_need',
  'free_entry_detected', 'ad_referral_json',
  'hot_alert_sent_at', 'urgent_alert_sent_at',
]);

export interface StoredMessage {
  id?: number;
  whatsapp_message_id?: string;
  customer_phone: string;
  direction: string;
  message_type: string;
  body?: string;
  created_at: string;
  raw_json?: string | null;
}

export function addMessage(db: Database.Database, msg: StoredMessage): void {
  db.prepare(
    `INSERT OR IGNORE INTO messages (whatsapp_message_id, customer_phone, direction, message_type, body, created_at, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(msg.whatsapp_message_id ?? null, msg.customer_phone, msg.direction, msg.message_type, msg.body ?? null, msg.created_at, msg.raw_json ?? null);
}

export function upsertConversation(db: Database.Database, phone: string, data: Record<string, unknown>): void {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM conversations WHERE customer_phone = ?').get(phone);

  if (existing) {
    const updates: string[] = ['last_seen_at = ?'];
    const values: unknown[] = [now];
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined && val !== null && ALLOWED_CONVERSATION_COLUMNS.has(key)) {
        updates.push(`${key} = ?`);
        values.push(val);
      }
    }
    values.push(phone);
    db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE customer_phone = ?`).run(...values);
  } else {
    const cols: string[] = ['customer_phone', 'first_seen_at', 'last_seen_at'];
    const vals: unknown[] = [phone, now, now];
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined && val !== null && ALLOWED_CONVERSATION_COLUMNS.has(key)) {
        cols.push(key);
        vals.push(val);
      }
    }
    const placeholders = cols.map(() => '?').join(', ');
    db.prepare(`INSERT INTO conversations (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals);
  }
}

export function getConversation(db: Database.Database, phone: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM conversations WHERE customer_phone = ?').get(phone);
  return row ? (row as Record<string, unknown>) : null;
}

export function getLastOutboundBody(db: Database.Database, phone: string): string | null {
  const row = db.prepare(
    "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'outbound' ORDER BY created_at DESC, id DESC LIMIT 1"
  ).get(phone) as { body: string | null } | undefined;
  return row?.body ?? null;
}

export interface RecentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function getRecentMessages(db: Database.Database, phone: string, limit: number = 12): RecentMessage[] {
  const rows = db.prepare(
    "SELECT direction, body FROM messages WHERE customer_phone = ? ORDER BY created_at DESC, id DESC LIMIT ?"
  ).all(phone, limit) as { direction: string; body: string | null }[];
  return rows.reverse().map(r => ({
    role: r.direction === 'inbound' ? 'user' as const : 'assistant' as const,
    content: r.body ?? '',
  }));
}
