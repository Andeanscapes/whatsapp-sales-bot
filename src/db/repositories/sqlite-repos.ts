import type Database from 'better-sqlite3';
import type {
  ConversationRepository,
  ConversationRow,
  MessageRepository,
  DedupeRepository,
  OptOutRepository,
  AiCacheRepository,
  AiUsageRepository,
  OwnerAlertRepository,
  MediaSendRepository,
  StatsRepository,
  DailyStats,
  ConversationSummary,
  PhaseBreakdown,
  StoredMessage,
  RecentMessage,
} from './types.js';

const ALLOWED_CONVERSATION_COLUMNS = new Set([
  'language', 'lead_score', 'last_seen_at', 'opt_out_at', 'handed_off_at',
  'collected_name', 'collected_date', 'collected_people',
  'collected_transport_need', 'collected_lodging_need',
  'collected_pet', 'collected_plan',
  'free_entry_detected', 'ad_referral_json',
  'hot_alert_sent_at', 'urgent_alert_sent_at',
  'price_given_at', 'soft_closed_at',
  'sales_phase', 'lead_intent',
]);

export class SqliteConversationRepo implements ConversationRepository {
  constructor(private db: Database.Database) {}

  getByPhone(phone: string): ConversationRow | undefined {
    return this.db.prepare(
      'SELECT * FROM conversations WHERE customer_phone = ?'
    ).get(phone) as ConversationRow | undefined;
  }

  upsert(phone: string, data: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM conversations WHERE customer_phone = ?').get(phone);

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
      this.db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE customer_phone = ?`).run(...values);
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
      this.db.prepare(`INSERT INTO conversations (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals);
    }
  }

  getHandedOffAt(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT handed_off_at FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { handed_off_at: string | null } | undefined;
    return row?.handed_off_at ?? null;
  }

  setHandedOff(phone: string): void {
    this.db.prepare(
      'UPDATE conversations SET handed_off_at = ? WHERE customer_phone = ?'
    ).run(new Date().toISOString(), phone);
  }

  getSoftClosedAt(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT soft_closed_at FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { soft_closed_at: string | null } | undefined;
    return row?.soft_closed_at ?? null;
  }

  setSoftClosed(phone: string): void {
    this.upsert(phone, { soft_closed_at: new Date().toISOString() });
  }

  clearSoftClosed(phone: string): void {
    this.db.prepare(
      'UPDATE conversations SET soft_closed_at = NULL WHERE customer_phone = ?'
    ).run(phone);
  }

  getPriceGivenAt(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT price_given_at FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { price_given_at: string | null } | undefined;
    return row?.price_given_at ?? null;
  }

  setPriceGiven(phone: string): void {
    this.upsert(phone, { price_given_at: new Date().toISOString() });
  }

  getLeadScore(phone: string): number {
    const row = this.db.prepare(
      'SELECT lead_score FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { lead_score: number } | undefined;
    return row?.lead_score ?? 0;
  }

  updateLeadScore(phone: string, score: number): void {
    this.db.prepare(
      'UPDATE conversations SET lead_score = ? WHERE customer_phone = ?'
    ).run(score, phone);
  }

  getCollectedFields(phone: string): Record<string, unknown> {
    const row = this.db.prepare(
      'SELECT collected_name, collected_date, collected_people, collected_transport_need, collected_lodging_need, collected_pet, collected_plan, language FROM conversations WHERE customer_phone = ?'
    ).get(phone) as Record<string, unknown> | undefined;
    if (!row) return {};
    const fields: Record<string, unknown> = {};
    if (row.collected_name) fields.nombre = row.collected_name;
    if (row.collected_date) fields.fecha = row.collected_date;
    if (row.collected_people) fields.personas = row.collected_people;
    if (row.collected_transport_need) fields.transporte = row.collected_transport_need;
    if (row.collected_lodging_need) fields.hospedaje = row.collected_lodging_need;
    if (row.collected_pet) fields.mascota = row.collected_pet;
    if (row.collected_plan) fields.plan = row.collected_plan;
    if (row.language) fields.idioma = row.language;
    return fields;
  }

  getCollectedPlan(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT collected_plan FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { collected_plan: string | null } | undefined;
    return row?.collected_plan ?? null;
  }

  getLanguage(phone: string): 'es' | 'en' | null {
    const row = this.db.prepare(
      'SELECT language FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { language: 'es' | 'en' | null } | undefined;
    return row?.language ?? null;
  }

  getSalesPhase(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT sales_phase FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { sales_phase: string | null } | undefined;
    return row?.sales_phase ?? null;
  }

  setSalesPhase(phone: string, phase: string): void {
    this.upsert(phone, { sales_phase: phase });
  }

  getLeadIntent(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT lead_intent FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { lead_intent: string | null } | undefined;
    return row?.lead_intent ?? null;
  }

  setLeadIntent(phone: string, intent: string): void {
    this.upsert(phone, { lead_intent: intent });
  }
}

export class SqliteMessageRepo implements MessageRepository {
  constructor(private db: Database.Database) {}

  addMessage(msg: StoredMessage): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO messages (whatsapp_message_id, customer_phone, direction, message_type, body, created_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(msg.whatsapp_message_id ?? null, msg.customer_phone, msg.direction, msg.message_type, msg.body ?? null, msg.created_at, msg.raw_json ?? null);
  }

  getLastOutboundBody(phone: string): string | null {
    const row = this.db.prepare(
      "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'outbound' ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(phone) as { body: string | null } | undefined;
    return row?.body ?? null;
  }

  getRecentMessages(phone: string, limit: number = 12): RecentMessage[] {
    const rows = this.db.prepare(
      "SELECT direction, body FROM messages WHERE customer_phone = ? ORDER BY created_at DESC, id DESC LIMIT ?"
    ).all(phone, limit) as { direction: string; body: string | null }[];
    return rows.reverse().map(r => ({
      role: r.direction === 'inbound' ? 'user' as const : 'assistant' as const,
      content: r.body ?? '',
    }));
  }

  getLastInboundBodies(phone: string, limit: number = 20): { body: string | null }[] {
    return this.db.prepare(
      "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT ?"
    ).all(phone, limit) as { body: string | null }[];
  }

  countOutboundSince(phone: string, sinceIso: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE customer_phone = ? AND direction = 'outbound' AND created_at >= ?"
    ).get(phone, sinceIso) as { cnt: number };
    return row.cnt;
  }
}

export class SqliteDedupeRepo implements DedupeRepository {
  constructor(private db: Database.Database) {}

  isProcessed(messageId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM processed_webhook_messages WHERE whatsapp_message_id = ?'
    ).get(messageId);
    return !!row;
  }

  markProcessed(messageId: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO processed_webhook_messages (whatsapp_message_id, processed_at) VALUES (?, ?)'
    ).run(messageId, new Date().toISOString());
  }
}

export class SqliteOptOutRepo implements OptOutRepository {
  constructor(private db: Database.Database) {}

  isOptedOut(phone: string): boolean {
    const row = this.db.prepare(
      'SELECT opt_out_at FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { opt_out_at: string | null } | undefined;
    return row?.opt_out_at != null;
  }

  setOptOut(phone: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO conversations (customer_phone, opt_out_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(customer_phone) DO UPDATE SET opt_out_at = ?'
    ).run(phone, now, now, now, now);
  }
}

export class SqliteAiCacheRepo implements AiCacheRepository {
  constructor(private db: Database.Database) {}

  get(key: string): unknown | null {
    const row = this.db.prepare(
      'SELECT response_json FROM ai_cache WHERE cache_key = ? AND expires_at > ?'
    ).get(key, new Date().toISOString()) as { response_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.response_json) as unknown;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (ttlSeconds * 1000)).toISOString();
    this.db.prepare(
      'INSERT OR REPLACE INTO ai_cache (cache_key, response_json, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(key, JSON.stringify(value), now.toISOString(), expiresAt);
  }
}

export class SqliteAiUsageRepo implements AiUsageRepository {
  constructor(private db: Database.Database) {}

  getDailyCost(todayStart: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(estimated_cost_usd), 0) as cost FROM ai_usage WHERE created_at >= ?"
    ).get(todayStart) as { cost: number };
    return row.cost;
  }

  getMonthlyCost(monthStart: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(estimated_cost_usd), 0) as cost FROM ai_usage WHERE created_at >= ?"
    ).get(monthStart) as { cost: number };
    return row.cost;
  }

  countCustomerDaily(phone: string, todayStart: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM ai_usage WHERE customer_phone = ? AND created_at >= ?"
    ).get(phone, todayStart) as { cnt: number };
    return row.cnt;
  }

  countGlobalDaily(todayStart: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM ai_usage WHERE created_at >= ?"
    ).get(todayStart) as { cnt: number };
    return row.cnt;
  }

  recordUsage(phone: string, model: string, promptTokens: number, completionTokens: number, cachedTokens: number, estimatedCost: number): void {
    this.db.prepare(
      'INSERT INTO ai_usage (customer_phone, model, prompt_tokens, completion_tokens, cached_tokens, estimated_cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(phone, model, promptTokens, completionTokens, cachedTokens, estimatedCost, new Date().toISOString());
  }
}

export class SqliteOwnerAlertRepo implements OwnerAlertRepository {
  constructor(private db: Database.Database) {}

  wasAlertedToday(phone: string, alertType: string): boolean {
    const now = new Date();
    const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const row = this.db.prepare(
      'SELECT 1 FROM owner_alerts WHERE customer_phone = ? AND alert_type = ? AND sent_at >= ?'
    ).get(phone, alertType, todayUtcMidnight);
    return !!row;
  }

  insert(phone: string, channel: string, score: number, alertType: string, body: string): void {
    this.db.prepare(
      'INSERT INTO owner_alerts (customer_phone, channel, score, alert_type, sent_at, body) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(phone, channel, score, alertType, new Date().toISOString(), body);
  }
}

export class SqliteMediaSendRepo implements MediaSendRepository {
  constructor(private db: Database.Database) {}

  countRecentImages(phone: string, cutoffIso: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM media_sends WHERE customer_phone = ? AND sent_at >= ?'
    ).get(phone, cutoffIso) as { cnt: number };
    return row.cnt;
  }

  hasRecentSameImage(phone: string, imageId: string, cutoffIso: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM media_sends WHERE customer_phone = ? AND media_id = ? AND sent_at >= ? LIMIT 1'
    ).get(phone, imageId, cutoffIso);
    return !!row;
  }

  recordSend(phone: string, mediaId: string): void {
    this.db.prepare(
      'INSERT INTO media_sends (customer_phone, media_id, sent_at) VALUES (?, ?, ?)'
    ).run(phone, mediaId, new Date().toISOString());
  }
}

type SummaryDbRow = {
  customer_phone: string; collected_name: string | null; lead_score: number;
  sales_phase: string | null; collected_plan: string | null;
  collected_people: number | null; collected_date: string | null;
  last_seen_at: string;
};

export class SqliteStatsRepo implements StatsRepository {
  constructor(private db: Database.Database) {}

  private static mapRowToSummary(r: SummaryDbRow): ConversationSummary {
    return {
      customerPhone: r.customer_phone,
      name: r.collected_name,
      score: r.lead_score,
      phase: r.sales_phase,
      plan: r.collected_plan,
      people: r.collected_people,
      date: r.collected_date,
      lastSeenAt: r.last_seen_at,
    };
  }

  getDailyStats(todayStart: string, hotLeadThreshold: number): DailyStats {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations) as total_conversations,
        (SELECT COUNT(*) FROM conversations WHERE first_seen_at >= ?) as new_conversations,
        (SELECT COUNT(*) FROM conversations WHERE opt_out_at IS NULL) as active_conversations,
        (SELECT COUNT(*) FROM messages WHERE direction = 'inbound' AND created_at >= ?) as messages_inbound,
        (SELECT COUNT(*) FROM messages WHERE direction = 'outbound' AND created_at >= ?) as messages_outbound,
        (SELECT COUNT(*) FROM conversations WHERE lead_score >= ? AND opt_out_at IS NULL) as hot_leads,
        (SELECT COUNT(*) FROM conversations WHERE opt_out_at >= ?) as opted_out,
        (SELECT COUNT(*) FROM conversations WHERE handed_off_at >= ?) as handed_off,
        (SELECT COUNT(*) FROM conversations WHERE soft_closed_at >= ?) as soft_closed,
        (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM ai_usage WHERE created_at >= ?) as ai_spent_usd
    `).get(todayStart, todayStart, todayStart, hotLeadThreshold, todayStart, todayStart, todayStart, todayStart) as {
      total_conversations: number;
      new_conversations: number;
      active_conversations: number;
      messages_inbound: number;
      messages_outbound: number;
      hot_leads: number;
      opted_out: number;
      handed_off: number;
      soft_closed: number;
      ai_spent_usd: number;
    };

    const today = new Date().toISOString().slice(0, 10);

    return {
      date: today,
      totalConversations: row.total_conversations,
      newConversations: row.new_conversations,
      activeConversations: row.active_conversations,
      messagesInbound: row.messages_inbound,
      messagesOutbound: row.messages_outbound,
      hotLeads: row.hot_leads,
      hotLeadPercentage: row.active_conversations > 0
        ? Math.round((row.hot_leads / row.active_conversations) * 1000) / 10
        : 0,
      optedOut: row.opted_out,
      handedOff: row.handed_off,
      softClosed: row.soft_closed,
      aiSpentUsd: Math.round(row.ai_spent_usd * 10000) / 10000,
    };
  }

  getRecentConversations(limit: number): ConversationSummary[] {
    const stmt = this.db.prepare(`
      SELECT customer_phone, collected_name, lead_score, sales_phase,
             collected_plan, collected_people, collected_date, last_seen_at
      FROM conversations
      WHERE opt_out_at IS NULL
      ORDER BY last_seen_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as SummaryDbRow[];
    return rows.map(SqliteStatsRepo.mapRowToSummary);
  }

  getTopLeads(limit: number, threshold: number): ConversationSummary[] {
    const stmt = this.db.prepare(`
      SELECT customer_phone, collected_name, lead_score, sales_phase,
             collected_plan, collected_people, collected_date, last_seen_at
      FROM conversations
      WHERE opt_out_at IS NULL AND lead_score >= ?
      ORDER BY lead_score DESC
      LIMIT ?
    `);
    const rows = stmt.all(threshold, limit) as SummaryDbRow[];
    return rows.map(SqliteStatsRepo.mapRowToSummary);
  }

  getPhaseBreakdown(): PhaseBreakdown[] {
    const rows = this.db.prepare(`
      SELECT COALESCE(sales_phase, 'unknown') as phase, COUNT(*) as count
      FROM conversations
      WHERE opt_out_at IS NULL
      GROUP BY phase
      ORDER BY count DESC
    `).all() as { phase: string; count: number }[];

    return rows.map(r => ({ phase: r.phase, count: r.count }));
  }
}
