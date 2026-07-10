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
  BridgeSessionRepository,
  BridgeSessionRow,
  ConversationAssignment,
  ConversationMode,
  StatsRepository,
  DailyStats,
  ConversationSummary,
  FollowUpCandidate,
  PhaseBreakdown,
  LineLeadCount,
  StoredMessage,
  RecentMessage,
  SystemErrorRepository,
  CustomerDataRepository,
  TranscriptRepository,
  TranscriptRecord,
  TranscriptTurn,
  DayActivityResult,
  DayConversationSummary,
  DayMessage,
  FollowUpEvent,
  FollowUpEventRepository,
  FollowUpStage,
  FollowUpStatus,
  LeadPain,
  AiUsageRecordInput,
  AiUsageBreakdown,
  TokenBreakdown,
} from './types.js';
import { env } from '../../config/env.js';

const ALLOWED_CONVERSATION_COLUMNS = new Set([
  'language', 'lead_score', 'last_seen_at', 'opt_out_at', 'handed_off_at',
  'collected_name', 'collected_date', 'collected_people',
  'collected_transport_need', 'collected_lodging_need',
  'collected_pet', 'collected_plan',
  'free_entry_detected', 'ad_referral_json',
  'hot_alert_sent_at', 'urgent_alert_sent_at',
  'price_given_at', 'soft_closed_at',
  'sales_phase', 'lead_intent',
  'assigned_line_id', 'assigned_agent_chat', 'conversation_mode',
  'converted_at', 'gallery_nudged_at', 'follow_up_sent_at',
  'lead_pain', 'lead_pain_detail', 'lead_pain_detected_at', 'follow_up_reply_count'
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

  clearHandoff(phone: string): void {
    this.db.prepare(
      "UPDATE conversations SET handed_off_at = NULL, assigned_line_id = NULL, assigned_agent_chat = NULL, conversation_mode = 'bot' WHERE customer_phone = ?"
    ).run(phone);
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

  getAssignment(phone: string): ConversationAssignment | null {
    const row = this.db.prepare(
      'SELECT assigned_line_id, assigned_agent_chat FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { assigned_line_id: string | null; assigned_agent_chat: string | null } | undefined;
    if (!row?.assigned_line_id || !row.assigned_agent_chat) return null;
    return { assignedLineId: row.assigned_line_id, assignedAgentChat: row.assigned_agent_chat };
  }

  setAssignment(phone: string, assignment: ConversationAssignment): void {
    this.upsert(phone, {
      assigned_line_id: assignment.assignedLineId,
      assigned_agent_chat: assignment.assignedAgentChat,
    });
  }

  getMode(phone: string): ConversationMode {
    const row = this.db.prepare(
      'SELECT conversation_mode FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { conversation_mode: ConversationMode | null } | undefined;
    return row?.conversation_mode ?? 'bot';
  }

  setMode(phone: string, mode: ConversationMode): void {
    this.upsert(phone, { conversation_mode: mode });
  }

  getBookedAt(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT converted_at FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { converted_at: string | null } | undefined;
    return row?.converted_at ?? null;
  }

  setBooked(phone: string): void {
    this.upsert(phone, { converted_at: new Date().toISOString() });
  }

  getFollowUpCandidates(cutoffIso: string, serviceWindowStartIso: string, limit: number): FollowUpCandidate[] {
    const rows = this.db.prepare(`
      SELECT c.customer_phone, c.language
      FROM conversations c
      WHERE c.opt_out_at IS NULL
        AND c.handed_off_at IS NULL
        AND c.soft_closed_at IS NULL
        AND c.converted_at IS NULL
        AND c.follow_up_sent_at IS NULL
        AND COALESCE(c.conversation_mode, 'bot') = 'bot'
        AND COALESCE(c.sales_phase, '') != 'closing'
        AND (
          SELECT m.direction FROM messages m
          WHERE m.customer_phone = c.customer_phone
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) = 'outbound'
        AND (
          SELECT MAX(m.created_at) FROM messages m
          WHERE m.customer_phone = c.customer_phone AND m.direction = 'outbound'
        ) <= ?
        AND (
          SELECT MAX(m.created_at) FROM messages m
          WHERE m.customer_phone = c.customer_phone AND m.direction = 'inbound'
        ) >= ?
      ORDER BY c.last_seen_at ASC
      LIMIT ?
    `).all(cutoffIso, serviceWindowStartIso, limit) as Array<{ customer_phone: string; language: 'es' | 'en' | null }>;
    return rows.map(r => ({ customerPhone: r.customer_phone, language: r.language }));
  }

  getPainQuestionCandidates(serviceWindowStartIso: string, limit: number, firstNudgeRepliedBefore: string): FollowUpCandidate[] {
    // Returns leads where:
    //  - first_nudge was sent AND replied (status='replied')
    //  - first_nudge reply is old enough (>= TIME_PAIN_FOLLOW_HOURS ago)
    //  - no pain_question event exists yet for them
    //  - last customer inbound is within 24h service window
    //  - not opted out, not handed off
    const rows = this.db.prepare(`
      SELECT DISTINCT c.customer_phone, c.language
      FROM conversations c
      INNER JOIN follow_up_events fe
        ON fe.customer_phone = c.customer_phone
        AND fe.stage = 'first_nudge'
        AND fe.status = 'replied'
        AND fe.replied_at <= ?
      WHERE c.opt_out_at IS NULL
        AND c.handed_off_at IS NULL
        AND c.soft_closed_at IS NULL
        AND c.converted_at IS NULL
        AND COALESCE(c.conversation_mode, 'bot') = 'bot'
        AND COALESCE(c.sales_phase, '') != 'closing'
        AND (
          SELECT MAX(m.created_at) FROM messages m
          WHERE m.customer_phone = c.customer_phone AND m.direction = 'inbound'
        ) >= ?
        AND NOT EXISTS (
          SELECT 1 FROM follow_up_events fe2
          WHERE fe2.customer_phone = c.customer_phone
          AND fe2.stage = 'pain_question'
        )
      LIMIT ?
    `).all(firstNudgeRepliedBefore, serviceWindowStartIso, limit) as Array<{ customer_phone: string; language: 'es' | 'en' | null }>;
    return rows.map(r => ({ customerPhone: r.customer_phone, language: r.language }));
  }

  markFollowUpSent(phone: string): void {
    this.upsert(phone, { follow_up_sent_at: new Date().toISOString() });
  }

  setLeadPain(phone: string, pain: LeadPain, detail?: string): void {
    this.upsert(phone, {
      lead_pain: pain,
      lead_pain_detail: detail ?? null,
      lead_pain_detected_at: new Date().toISOString(),
    });
  }

  getLeadPain(phone: string): LeadPain | null {
    const row = this.db.prepare(
      'SELECT lead_pain FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { lead_pain: LeadPain | null } | undefined;
    return row?.lead_pain ?? null;
  }

  incrementFollowUpReplyCount(phone: string): void {
    this.db.prepare(
      `UPDATE conversations
       SET follow_up_reply_count = COALESCE(follow_up_reply_count, 0) + 1
       WHERE customer_phone = ?`
    ).run(phone);
  }
}

export class SqliteFollowUpEventRepo implements FollowUpEventRepository {
  constructor(private db: Database.Database) {}

  insert(event: Omit<FollowUpEvent, 'id'>): void {
    this.db.prepare(`
      INSERT INTO follow_up_events
        (customer_phone, sequence_number, stage, sent_at, replied_at, score_before, score_after, detected_pain, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.customerPhone,
      event.sequenceNumber,
      event.stage,
      event.sentAt,
      event.repliedAt,
      event.scoreBefore,
      event.scoreAfter ?? null,
      event.detectedPain ?? null,
      event.status,
    );
  }

  getLatestByPhone(phone: string): FollowUpEvent | null {
    const row = this.db.prepare(`
      SELECT * FROM follow_up_events
      WHERE customer_phone = ?
      ORDER BY sequence_number DESC, id DESC
      LIMIT 1
    `).get(phone) as {
      id: number; customer_phone: string; sequence_number: number; stage: FollowUpStage;
      sent_at: string | null; replied_at: string | null; score_before: number;
      score_after: number | null; detected_pain: LeadPain | null; status: FollowUpStatus;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      customerPhone: row.customer_phone,
      sequenceNumber: row.sequence_number,
      stage: row.stage,
      sentAt: row.sent_at,
      repliedAt: row.replied_at,
      scoreBefore: row.score_before,
      scoreAfter: row.score_after,
      detectedPain: row.detected_pain,
      status: row.status,
    };
  }

  markReplied(phone: string, sequenceNumber: number, scoreAfter: number, detectedPain: LeadPain | null): void {
    this.db.prepare(`
      UPDATE follow_up_events
      SET replied_at = ?, score_after = ?, detected_pain = ?, status = 'replied'
      WHERE customer_phone = ? AND sequence_number = ?
    `).run(new Date().toISOString(), scoreAfter, detectedPain ?? null, phone, sequenceNumber);
  }

  countByPhone(phone: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM follow_up_events WHERE customer_phone = ?'
    ).get(phone) as { cnt: number };
    return row.cnt;
  }
}

export class SqliteBridgeSessionRepo implements BridgeSessionRepository {
  constructor(private db: Database.Database) {}

  open(agentChatId: string, customerPhone: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO bridge_sessions (agent_chat_id, customer_phone, opened_at, last_activity_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_chat_id) DO UPDATE SET customer_phone = ?, last_activity_at = ?`
    ).run(agentChatId, customerPhone, now, now, customerPhone, now);
  }

  close(agentChatId: string): void {
    this.db.prepare('DELETE FROM bridge_sessions WHERE agent_chat_id = ?').run(agentChatId);
  }

  getByAgentChat(agentChatId: string): BridgeSessionRow | null {
    const row = this.db.prepare(
      'SELECT agent_chat_id, customer_phone, opened_at, last_activity_at FROM bridge_sessions WHERE agent_chat_id = ?'
    ).get(agentChatId) as { agent_chat_id: string; customer_phone: string; opened_at: string; last_activity_at: string } | undefined;
    if (!row) return null;
    return { agentChatId: row.agent_chat_id, customerPhone: row.customer_phone, openedAt: row.opened_at, lastActivityAt: row.last_activity_at };
  }

  getByCustomer(customerPhone: string): BridgeSessionRow | null {
    const row = this.db.prepare(
      'SELECT agent_chat_id, customer_phone, opened_at, last_activity_at FROM bridge_sessions WHERE customer_phone = ? ORDER BY last_activity_at DESC LIMIT 1'
    ).get(customerPhone) as { agent_chat_id: string; customer_phone: string; opened_at: string; last_activity_at: string } | undefined;
    if (!row) return null;
    return { agentChatId: row.agent_chat_id, customerPhone: row.customer_phone, openedAt: row.opened_at, lastActivityAt: row.last_activity_at };
  }

  touch(agentChatId: string): void {
    this.db.prepare(
      'UPDATE bridge_sessions SET last_activity_at = ? WHERE agent_chat_id = ?'
    ).run(new Date().toISOString(), agentChatId);
  }
}

export class SqliteMessageRepo implements MessageRepository {
  constructor(private db: Database.Database) {}

  addMessage(msg: StoredMessage): void {
    // Repo reads env only to stamp the deployed app version onto bot-generated
    // (outbound) messages, so reports can trace which release produced a reply.
    // Centralized here to avoid threading env.APP_VERSION through every caller.
    const appVersion = msg.app_version ?? (msg.direction === 'outbound' ? env.APP_VERSION : null);
    this.db.prepare(
      `INSERT OR IGNORE INTO messages (whatsapp_message_id, customer_phone, direction, message_type, body, created_at, raw_json, app_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(msg.whatsapp_message_id ?? null, msg.customer_phone, msg.direction, msg.message_type, msg.body ?? null, msg.created_at, msg.raw_json ?? null, appVersion);
  }

  getLastOutboundBody(phone: string): string | null {
    const row = this.db.prepare(
      "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'outbound' ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(phone) as { body: string | null } | undefined;
    return row?.body ?? null;
  }

  getRecentMessages(phone: string, limit: number = 12): RecentMessage[] {
    const rows = this.db.prepare(
      "SELECT direction, body, message_type FROM messages WHERE customer_phone = ? ORDER BY created_at DESC, id DESC LIMIT ?"
    ).all(phone, limit) as { direction: string; body: string | null; message_type: string | null }[];
    return rows.reverse().map(r => ({
      role: r.direction === 'inbound' ? 'user' as const : 'assistant' as const,
      content: r.body ?? '',
      messageType: r.message_type ?? undefined,
    }));
  }

  getLastInboundBodies(phone: string, limit: number = 20): { body: string | null }[] {
    return this.db.prepare(
      "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT ?"
    ).all(phone, limit) as { body: string | null }[];
  }

  getLastInboundBody(phone: string): string | null {
    const row = this.db.prepare(
      "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'inbound' ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(phone) as { body: string | null } | undefined;
    return row?.body ?? null;
  }

  getLastInboundAt(phone: string): string | null {
    const row = this.db.prepare(
      "SELECT created_at FROM messages WHERE customer_phone = ? AND direction = 'inbound' ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(phone) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  getLastMessageDirection(phone: string): 'inbound' | 'outbound' | null {
    const row = this.db.prepare(
      "SELECT direction FROM messages WHERE customer_phone = ? ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(phone) as { direction: 'inbound' | 'outbound' } | undefined;
    return row?.direction ?? null;
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

  recordUsage(input: AiUsageRecordInput): void {
    this.db.prepare(
      'INSERT INTO ai_usage (customer_phone, model, prompt_tokens, completion_tokens, cached_tokens, estimated_cost_usd, created_at, purpose, success, error_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(input.phone, input.model, input.promptTokens, input.completionTokens, input.cachedTokens, input.estimatedCost, new Date().toISOString(), input.purpose, input.success ? 1 : 0, input.errorType ?? null);
  }

  getUsageByPurpose(phone: string, sinceIso: string, untilIso: string | null): AiUsageBreakdown {
    return this.queryUsageByPurpose('WHERE customer_phone = ? AND created_at >= ? AND (? IS NULL OR created_at < ?)', [phone, sinceIso, untilIso, untilIso]);
  }

  getGlobalUsageByPurpose(sinceIso: string, untilIso: string | null): AiUsageBreakdown {
    return this.queryUsageByPurpose('WHERE created_at >= ? AND (? IS NULL OR created_at < ?)', [sinceIso, untilIso, untilIso]);
  }

  private queryUsageByPurpose(whereClause: string, params: unknown[]): AiUsageBreakdown {
    const safeWhere = `COALESCE(purpose, 'reply')`;
    const base = `SELECT ${safeWhere} as purpose, COUNT(*) as calls, COALESCE(SUM(prompt_tokens), 0) as prompt_tokens, COALESCE(SUM(completion_tokens), 0) as completion_tokens, COALESCE(SUM(estimated_cost_usd), 0) as cost_usd FROM ai_usage ${whereClause} GROUP BY ${safeWhere}`;
    const rows = this.db.prepare(base).all(...params) as Array<{ purpose: string; calls: number; prompt_tokens: number; completion_tokens: number; cost_usd: number }>;

    const zero = (): TokenBreakdown => ({ calls: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 });
    const breakdown: AiUsageBreakdown = { reply: zero(), lead_analysis: zero(), follow_up: zero(), totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalCostUsd: 0 };

    for (const r of rows) {
      const tb: TokenBreakdown = { calls: r.calls, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens, estimatedCostUsd: r.cost_usd };
      if (r.purpose === 'reply') breakdown.reply = tb;
      else if (r.purpose === 'lead_analysis') breakdown.lead_analysis = tb;
      else if (r.purpose === 'follow_up') breakdown.follow_up = tb;
      breakdown.totalCalls += r.calls;
      breakdown.totalPromptTokens += r.prompt_tokens;
      breakdown.totalCompletionTokens += r.completion_tokens;
      breakdown.totalCostUsd += r.cost_usd;
    }

    return breakdown;
  }
}

export class SqliteOwnerAlertRepo implements OwnerAlertRepository {
  constructor(private db: Database.Database) {}

  wasAlertedToday(phone: string, alertType: string): boolean {
    const now = new Date();
    const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    return this.wasAlertedSince(phone, alertType, todayUtcMidnight);
  }

  wasAlertedSince(phone: string, alertType: string, sinceIso: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM owner_alerts WHERE customer_phone = ? AND alert_type = ? AND sent_at >= ?'
    ).get(phone, alertType, sinceIso);
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

  getDailyStats(todayStart: string, hotLeadThreshold: number, excludedPhones: string[] = []): DailyStats {
    const today = new Date().toISOString().slice(0, 10);
    return this.getPeriodStats(today, todayStart, null, hotLeadThreshold, excludedPhones);
  }

  getPeriodStats(label: string, sinceIso: string, untilIso: string | null, hotLeadThreshold: number, excludedPhones: string[] = []): DailyStats {
    const params = { threshold: hotLeadThreshold, since: sinceIso, until: untilIso, excludedJson: JSON.stringify(excludedPhones) };
    // Cumulative-state snapshot (all-time): represents where the funnel stands
    // now, not flow within the period. /report and /status rely on these totals.
    // The `period` ('hoy'|'todo'|...) does not bound these.
    const cumulative = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson))) as total_conversations,
        (SELECT COUNT(*) FROM conversations WHERE opt_out_at IS NULL AND customer_phone NOT IN (SELECT value FROM json_each(@excludedJson))) as active_conversations,
        (SELECT COUNT(*) FROM conversations WHERE lead_score >= @threshold AND opt_out_at IS NULL AND customer_phone NOT IN (SELECT value FROM json_each(@excludedJson))) as hot_leads
    `).get(params) as {
      total_conversations: number;
      active_conversations: number;
      hot_leads: number;
    };

    // Flow metrics bounded to [since, until): what happened during the period.
    const flow = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND first_seen_at >= @since AND (@until IS NULL OR first_seen_at < @until)) as new_conversations,
        (SELECT COUNT(*) FROM messages WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND direction = 'inbound' AND created_at >= @since AND (@until IS NULL OR created_at < @until)) as messages_inbound,
        (SELECT COUNT(*) FROM messages WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND direction = 'outbound' AND created_at >= @since AND (@until IS NULL OR created_at < @until)) as messages_outbound,
        (SELECT COUNT(*) FROM conversations WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND opt_out_at >= @since AND (@until IS NULL OR opt_out_at < @until)) as opted_out,
        (SELECT COUNT(*) FROM conversations WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND handed_off_at >= @since AND (@until IS NULL OR handed_off_at < @until)) as handed_off,
        (SELECT COUNT(*) FROM conversations WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND soft_closed_at >= @since AND (@until IS NULL OR soft_closed_at < @until)) as soft_closed,
        (SELECT COUNT(*) FROM conversations WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND converted_at >= @since AND (@until IS NULL OR converted_at < @until)) as booked_today,
        (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM ai_usage WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND created_at >= @since AND (@until IS NULL OR created_at < @until)) as ai_spent_usd,
        (SELECT COUNT(*) FROM ai_usage WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND created_at >= @since AND (@until IS NULL OR created_at < @until)) as ai_calls,
        (SELECT COALESCE(SUM(prompt_tokens), 0) FROM ai_usage WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND created_at >= @since AND (@until IS NULL OR created_at < @until)) as ai_prompt_tokens,
        (SELECT COALESCE(SUM(completion_tokens), 0) FROM ai_usage WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND created_at >= @since AND (@until IS NULL OR created_at < @until)) as ai_completion_tokens,
        (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM ai_usage WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND created_at >= @since AND (@until IS NULL OR created_at < @until) AND COALESCE(purpose, 'reply') = 'reply') as ai_reply_cost,
        (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM ai_usage WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND created_at >= @since AND (@until IS NULL OR created_at < @until) AND COALESCE(purpose, 'reply') = 'lead_analysis') as ai_analysis_cost,
        (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM ai_usage WHERE customer_phone NOT IN (SELECT value FROM json_each(@excludedJson)) AND created_at >= @since AND (@until IS NULL OR created_at < @until) AND COALESCE(purpose, 'reply') = 'follow_up') as ai_follow_up_cost
    `).get(params) as {
      new_conversations: number;
      messages_inbound: number;
      messages_outbound: number;
      opted_out: number;
      handed_off: number;
      soft_closed: number;
      booked_today: number;
      ai_spent_usd: number;
      ai_calls: number;
      ai_prompt_tokens: number;
      ai_completion_tokens: number;
      ai_reply_cost: number;
      ai_analysis_cost: number;
      ai_follow_up_cost: number;
    };

    return {
      label,
      totalConversations: cumulative.total_conversations,
      newConversations: flow.new_conversations,
      activeConversations: cumulative.active_conversations,
      messagesInbound: flow.messages_inbound,
      messagesOutbound: flow.messages_outbound,
      hotLeads: cumulative.hot_leads,
      hotLeadPercentage: cumulative.active_conversations > 0
        ? Math.round((cumulative.hot_leads / cumulative.active_conversations) * 1000) / 10
        : 0,
      optedOut: flow.opted_out,
      handedOff: flow.handed_off,
      softClosed: flow.soft_closed,
      bookedToday: flow.booked_today,
      aiSpentUsd: Math.round(flow.ai_spent_usd * 10000) / 10000,
      aiCalls: flow.ai_calls,
      aiPromptTokens: flow.ai_prompt_tokens,
      aiCompletionTokens: flow.ai_completion_tokens,
      aiReplyCost: Math.round(flow.ai_reply_cost * 10000) / 10000,
      aiAnalysisCost: Math.round(flow.ai_analysis_cost * 10000) / 10000,
      aiFollowUpCost: Math.round(flow.ai_follow_up_cost * 10000) / 10000,
    };
  }

  getRecentConversations(limit: number, lineId?: string | null): ConversationSummary[] {
    // When a lineId is given, restrict to that line's leads PLUS not-yet-assigned
    // (pre-handoff) leads, which have no owner yet.
    const lineFilter = lineId ? 'AND (assigned_line_id = ? OR assigned_line_id IS NULL)' : '';
    const stmt = this.db.prepare(`
      SELECT customer_phone, collected_name, lead_score, sales_phase,
             collected_plan, collected_people, collected_date, last_seen_at
      FROM conversations
      WHERE opt_out_at IS NULL ${lineFilter}
      ORDER BY last_seen_at DESC
      LIMIT ?
    `);
    const rows = (lineId ? stmt.all(lineId, limit) : stmt.all(limit)) as SummaryDbRow[];
    return rows.map(SqliteStatsRepo.mapRowToSummary);
  }

  getRecentInboundAfterFirstReply(limit: number, lineId?: string | null, excludedPhones: string[] = []): ConversationSummary[] {
    const lineFilter = lineId ? 'AND (c.assigned_line_id = @lineId OR c.assigned_line_id IS NULL)' : '';
    const rows = this.db.prepare(`
      SELECT c.customer_phone, c.collected_name, c.lead_score, c.sales_phase,
             c.collected_plan, c.collected_people, c.collected_date, MAX(m.created_at) AS last_seen_at
      FROM conversations c
      JOIN messages m ON m.customer_phone = c.customer_phone
      WHERE c.opt_out_at IS NULL
        ${lineFilter}
        AND c.customer_phone NOT IN (SELECT value FROM json_each(@excludedJson))
        AND m.direction = 'inbound'
        AND m.created_at > COALESCE((
          SELECT MIN(created_at) FROM messages
          WHERE customer_phone = c.customer_phone AND direction = 'outbound'
        ), '9999-12-31T00:00:00.000Z')
      GROUP BY c.customer_phone
      ORDER BY last_seen_at DESC
      LIMIT @limit
    `).all({ lineId: lineId ?? null, excludedJson: JSON.stringify(excludedPhones), limit }) as SummaryDbRow[];
    return rows.map(SqliteStatsRepo.mapRowToSummary);
  }

  getTopLeads(limit: number, threshold: number, lineId?: string | null): ConversationSummary[] {
    const lineFilter = lineId ? 'AND (assigned_line_id = ? OR assigned_line_id IS NULL)' : '';
    const stmt = this.db.prepare(`
      SELECT customer_phone, collected_name, lead_score, sales_phase,
             collected_plan, collected_people, collected_date, last_seen_at
      FROM conversations
      WHERE opt_out_at IS NULL AND lead_score >= ? ${lineFilter}
      ORDER BY lead_score DESC
      LIMIT ?
    `);
    const rows = (lineId ? stmt.all(threshold, lineId, limit) : stmt.all(threshold, limit)) as SummaryDbRow[];
    return rows.map(SqliteStatsRepo.mapRowToSummary);
  }

  getLeadCountsByLine(hotLeadThreshold: number): LineLeadCount[] {
    const rows = this.db.prepare(`
      SELECT COALESCE(assigned_line_id, 'unassigned') as line_id,
             COUNT(*) as total,
             SUM(CASE WHEN lead_score >= ? THEN 1 ELSE 0 END) as hot,
             SUM(CASE WHEN converted_at IS NOT NULL THEN 1 ELSE 0 END) as booked
      FROM conversations
      WHERE opt_out_at IS NULL
      GROUP BY line_id
      ORDER BY total DESC
    `).all(hotLeadThreshold) as { line_id: string; total: number; hot: number; booked: number }[];
    return rows.map(r => ({ lineId: r.line_id, total: r.total, hot: r.hot, booked: r.booked }));
  }

  getLeadCountsByLineForPeriod(sinceIso: string, untilIso: string | null, hotLeadThreshold: number, excludedPhones: string[] = []): LineLeadCount[] {
    const rows = this.db.prepare(`
      SELECT COALESCE(assigned_line_id, 'unassigned') as line_id,
             SUM(CASE WHEN first_seen_at >= ? AND (? IS NULL OR first_seen_at < ?) THEN 1 ELSE 0 END) as total,
             SUM(CASE WHEN lead_score >= ? AND first_seen_at >= ? AND (? IS NULL OR first_seen_at < ?) THEN 1 ELSE 0 END) as hot,
             SUM(CASE WHEN converted_at >= ? AND (? IS NULL OR converted_at < ?) THEN 1 ELSE 0 END) as booked
      FROM conversations
      WHERE opt_out_at IS NULL
        AND customer_phone NOT IN (SELECT value FROM json_each(?))
        AND (
          (first_seen_at >= ? AND (? IS NULL OR first_seen_at < ?))
          OR (converted_at >= ? AND (? IS NULL OR converted_at < ?))
        )
      GROUP BY line_id
      ORDER BY total DESC, booked DESC
    `).all(
      sinceIso, untilIso, untilIso,
      hotLeadThreshold, sinceIso, untilIso, untilIso,
      sinceIso, untilIso, untilIso,
      JSON.stringify(excludedPhones),
      sinceIso, untilIso, untilIso,
      sinceIso, untilIso, untilIso,
    ) as { line_id: string; total: number; hot: number; booked: number }[];
    return rows.map(r => ({ lineId: r.line_id, total: r.total, hot: r.hot, booked: r.booked }));
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

export class SqliteSystemErrorRepo implements SystemErrorRepository {
  private insertStmt: Database.Statement;
  private pruneStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(
      'INSERT INTO system_errors (error_type, severity, message, stack, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.pruneStmt = db.prepare(
      'DELETE FROM system_errors WHERE created_at < ?'
    );
  }

  insert(type: string, severity: string, message: string, stack?: string, context?: Record<string, unknown>): void {
    const contextJson = context ? JSON.stringify(context) : null;
    this.insertStmt.run(type, severity, message, stack ?? null, contextJson, new Date().toISOString());
  }

  pruneOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.pruneStmt.run(cutoff);
    return result.changes;
  }
}

export class SqliteCustomerDataRepo implements CustomerDataRepository {
  constructor(private db: Database.Database) {}

  deleteCustomer(phone: string): ReturnType<CustomerDataRepository['deleteCustomer']> {
    return this.db.transaction((customerPhone: string) => {
      const messageIds = this.db.prepare(
        'SELECT whatsapp_message_id FROM messages WHERE customer_phone = ? AND whatsapp_message_id IS NOT NULL'
      ).all(customerPhone) as Array<{ whatsapp_message_id: string }>;

      let processedMessages = 0;
      for (const row of messageIds) {
        processedMessages += this.db.prepare('DELETE FROM processed_webhook_messages WHERE whatsapp_message_id = ?').run(row.whatsapp_message_id).changes;
      }

      const bridgeSessions = this.db.prepare('DELETE FROM bridge_sessions WHERE customer_phone = ?').run(customerPhone).changes;
      const mediaSends = this.db.prepare('DELETE FROM media_sends WHERE customer_phone = ?').run(customerPhone).changes;
      const ownerAlerts = this.db.prepare('DELETE FROM owner_alerts WHERE customer_phone = ?').run(customerPhone).changes;
      const aiUsage = this.db.prepare('DELETE FROM ai_usage WHERE customer_phone = ?').run(customerPhone).changes;
      const followUpEvents = this.db.prepare('DELETE FROM follow_up_events WHERE customer_phone = ?').run(customerPhone).changes;
      const messages = this.db.prepare('DELETE FROM messages WHERE customer_phone = ?').run(customerPhone).changes;
      const conversations = this.db.prepare('DELETE FROM conversations WHERE customer_phone = ?').run(customerPhone).changes;

      return { conversations, messages, processedMessages, aiUsage, ownerAlerts, mediaSends, bridgeSessions, followUpEvents };
    })(phone);
  }
}

interface TranscriptConversationRow {
  customer_phone: string;
  language: 'es' | 'en' | null;
  first_seen_at: string;
  last_seen_at: string;
  lead_score: number | null;
  collected_name: string | null;
  collected_date: string | null;
  collected_people: number | null;
  collected_transport_need: string | null;
  collected_lodging_need: string | null;
  collected_pet: string | null;
  collected_plan: string | null;
  handed_off_at: string | null;
  converted_at: string | null;
  conversation_mode: ConversationMode | null;
}

interface TranscriptMessageRow {
  direction: string;
  message_type: string;
  body: string | null;
  created_at: string;
  app_version: string | null;
}

interface TranscriptUsageRow {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated_cost_usd: number | null;
}

export class SqliteTranscriptRepo implements TranscriptRepository {
  constructor(private db: Database.Database) {}

  getAllTranscripts(): TranscriptRecord[] {
    const conversations = this.db.prepare(`
      SELECT customer_phone, language, first_seen_at, last_seen_at, lead_score,
        collected_name, collected_date, collected_people, collected_transport_need,
        collected_lodging_need, collected_pet, collected_plan, handed_off_at,
        converted_at, conversation_mode
      FROM conversations
      ORDER BY last_seen_at DESC
    `).all() as TranscriptConversationRow[];

    const messagesStmt = this.db.prepare(`
      SELECT direction, message_type, body, created_at, app_version
      FROM messages
      WHERE customer_phone = ?
      ORDER BY created_at ASC, id ASC
    `);

    const usageStmt = this.db.prepare(`
      SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
      FROM ai_usage
      WHERE customer_phone = ?
    `);

    return conversations.map(conv => {
      const messages = messagesStmt.all(conv.customer_phone) as TranscriptMessageRow[];
      const usage = usageStmt.get(conv.customer_phone) as TranscriptUsageRow | undefined;
      const turns: TranscriptTurn[] = messages.map(m => ({
        at: m.created_at,
        role: m.direction === 'inbound' ? 'customer' : 'bot',
        type: m.message_type,
        text: m.body ?? '',
        appVersion: m.app_version ?? null,
      }));
      const hasUsage = usage && (usage.prompt_tokens || usage.completion_tokens || usage.estimated_cost_usd);
      return {
        customerPhone: conv.customer_phone,
        language: conv.language,
        firstSeenAt: conv.first_seen_at,
        lastSeenAt: conv.last_seen_at,
        leadScore: conv.lead_score ?? 0,
        mode: conv.conversation_mode,
        handedOff: Boolean(conv.handed_off_at),
        converted: Boolean(conv.converted_at),
        collected: {
          name: conv.collected_name,
          date: conv.collected_date,
          people: conv.collected_people,
          transportNeed: conv.collected_transport_need,
          lodgingNeed: conv.collected_lodging_need,
          pet: conv.collected_pet,
          plan: conv.collected_plan,
        },
        aiUsage: hasUsage ? {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          estimatedCostUsd: usage.estimated_cost_usd ?? 0,
        } : null,
        turns,
      };
    });
  }

  getDayActivity(sinceIso: string, untilIso: string | null, excludedPhones: string[] = []): DayActivityResult {
    interface ActiveConvRow {
      customer_phone: string;
      language: 'es' | 'en' | null;
      first_seen_at: string;
      last_activity_at: string;
      lead_score: number;
      collected_name: string | null;
      collected_date: string | null;
      collected_people: number | null;
      collected_plan: string | null;
      lead_intent: string | null;
      sales_phase: string | null;
      message_count: number;
      inbound_count: number;
      outbound_count: number;
      ai_cost_usd: number;
      ai_prompt_tokens: number;
      ai_completion_tokens: number;
      ai_calls: number;
    }

    const activeConvs = this.db.prepare(`
      SELECT
        c.customer_phone,
        c.language,
        c.first_seen_at,
        c.last_seen_at AS last_activity_at,
        c.lead_score,
        c.collected_name,
        c.collected_date,
        c.collected_people,
        c.collected_plan,
        c.lead_intent,
        c.sales_phase,
        COUNT(m.id) AS message_count,
        SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_count,
        SUM(CASE WHEN m.direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_count,
        COALESCE((
          SELECT SUM(estimated_cost_usd) FROM ai_usage
          WHERE customer_phone = c.customer_phone
            AND created_at >= @since
            AND (@until IS NULL OR created_at < @until)
        ), 0) AS ai_cost_usd,
        COALESCE((
          SELECT SUM(prompt_tokens) FROM ai_usage
          WHERE customer_phone = c.customer_phone
            AND created_at >= @since
            AND (@until IS NULL OR created_at < @until)
        ), 0) AS ai_prompt_tokens,
        COALESCE((
          SELECT SUM(completion_tokens) FROM ai_usage
          WHERE customer_phone = c.customer_phone
            AND created_at >= @since
            AND (@until IS NULL OR created_at < @until)
        ), 0) AS ai_completion_tokens,
        COALESCE((
          SELECT COUNT(*) FROM ai_usage
          WHERE customer_phone = c.customer_phone
            AND created_at >= @since
            AND (@until IS NULL OR created_at < @until)
        ), 0) AS ai_calls
      FROM conversations c
      JOIN messages m ON m.customer_phone = c.customer_phone
      WHERE m.created_at >= @since
        AND (@until IS NULL OR m.created_at < @until)
        AND c.customer_phone NOT IN (SELECT value FROM json_each(@excludedJson))
      GROUP BY c.customer_phone
      ORDER BY c.last_seen_at DESC
    `).all({ since: sinceIso, until: untilIso, excludedJson: JSON.stringify(excludedPhones) }) as ActiveConvRow[];

    const messagesStmt = this.db.prepare(`
      SELECT direction, message_type, body, created_at, app_version
      FROM messages
      WHERE customer_phone = ?
        AND created_at >= ?
        AND (? IS NULL OR created_at < ?)
      ORDER BY created_at ASC, id ASC
    `);

    let totalMessages = 0;
    let totalInbound = 0;
    let totalOutbound = 0;
    let totalAiCost = 0;

    const conversations: DayConversationSummary[] = activeConvs.map(conv => {
      const msgRows = messagesStmt.all(
        conv.customer_phone, sinceIso, untilIso, untilIso,
      ) as TranscriptMessageRow[];

      const messages: DayMessage[] = msgRows.map(m => ({
        at: m.created_at,
        direction: m.direction as 'inbound' | 'outbound',
        type: m.message_type,
        text: m.body ?? '',
        appVersion: m.app_version ?? null,
      }));

      totalMessages += conv.message_count;
      totalInbound += conv.inbound_count;
      totalOutbound += conv.outbound_count;
      totalAiCost += conv.ai_cost_usd;

      return {
        customerPhone: conv.customer_phone,
        name: conv.collected_name,
        score: conv.lead_score,
        phase: conv.sales_phase,
        plan: conv.collected_plan,
        intent: conv.lead_intent,
        language: conv.language,
        people: conv.collected_people,
        date: conv.collected_date,
        firstSeenAt: conv.first_seen_at,
        lastActivityAt: conv.last_activity_at,
        messageCount: conv.message_count,
        inboundCount: conv.inbound_count,
        outboundCount: conv.outbound_count,
        aiCostUsd: Math.round(conv.ai_cost_usd * 10000) / 10000,
        aiPromptTokens: conv.ai_prompt_tokens,
        aiCompletionTokens: conv.ai_completion_tokens,
        aiCalls: conv.ai_calls,
        aiUsageBreakdown: this.computeBreakdownForPhone(conv.customer_phone, sinceIso, untilIso),
        messages,
      };
    });

    return {
      totals: {
        label: '',
        generatedAt: new Date().toISOString(),
        totalConversations: conversations.length,
        totalMessages,
        totalInbound,
        totalOutbound,
        totalAiCostUsd: Math.round(totalAiCost * 10000) / 10000,
      },
      conversations,
    };
  }

  private computeBreakdownForPhone(phone: string, sinceIso: string, untilIso: string | null): AiUsageBreakdown {
    const zero = (): TokenBreakdown => ({ calls: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 });
    const breakdown: AiUsageBreakdown = { reply: zero(), lead_analysis: zero(), follow_up: zero(), totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalCostUsd: 0 };
    const rows = this.db.prepare(
      'SELECT COALESCE(purpose, \'reply\') as purpose, COUNT(*) as calls, COALESCE(SUM(prompt_tokens), 0) as prompt_tokens, COALESCE(SUM(completion_tokens), 0) as completion_tokens, COALESCE(SUM(estimated_cost_usd), 0) as cost_usd FROM ai_usage WHERE customer_phone = ? AND created_at >= ? AND (? IS NULL OR created_at < ?) GROUP BY COALESCE(purpose, \'reply\')'
    ).all(phone, sinceIso, untilIso, untilIso) as Array<{ purpose: string; calls: number; prompt_tokens: number; completion_tokens: number; cost_usd: number }>;
    for (const r of rows) {
      const tb: TokenBreakdown = { calls: r.calls, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens, estimatedCostUsd: r.cost_usd };
      if (r.purpose === 'reply') breakdown.reply = tb;
      else if (r.purpose === 'lead_analysis') breakdown.lead_analysis = tb;
      else if (r.purpose === 'follow_up') breakdown.follow_up = tb;
      breakdown.totalCalls += r.calls;
      breakdown.totalPromptTokens += r.prompt_tokens;
      breakdown.totalCompletionTokens += r.completion_tokens;
      breakdown.totalCostUsd += r.cost_usd;
    }
    return breakdown;
  }
}
