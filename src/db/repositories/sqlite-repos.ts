import type Database from 'better-sqlite3';
import type {
  ConversationRepository,
  ConversationRow,
  MetaAudienceLead,
  MessageRepository,
  OutboundMediaRepository,
  OutboundMediaRow,
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
  LeadPain,
  AiUsageRecordInput,
  AiUsageBreakdown,
  TokenBreakdown,
  PaymentReservationRepository,
  PaymentReservation,
  PaymentReservationCreate,
   DateStatus,
   FollowupConsentRepository,
   FollowupConsentGrantRepository,
   FollowupConsentGrantRow,
   FollowupSubscriptionEventRepository,
   FollowupSubscriptionEventRow,
   FollowupSubscriptionEventKind,
   FollowupSubscriptionEventStatus,
   FollowupSubscriptionStatus,
   FollowupSubscriptionRepository,
   FollowupSubscriptionRow,
   FollowupCandidateRow,
   ConsentAskCandidateRow,
   RecurringCandidateRow,
   FollowupEventRepository,
   FollowupEventRow,
} from './types.js';
import { env } from '../../config/env.js';
import { canonicalizeDateText } from '../../services/date-canonicalizer.js';

const ALLOWED_CONVERSATION_COLUMNS = new Set([
  'language', 'lead_score', 'last_seen_at', 'opt_out_at', 'handed_off_at',
  'collected_name', 'collected_date', 'collected_date_window', 'date_status', 'collected_people',
  'collected_transport_need', 'collected_lodging_need',
  'collected_pet', 'collected_plan',
  'collected_adults', 'collected_children', 'collected_child_ages_json', 'collected_travel_origin',
  'free_entry_detected', 'ad_referral_json', 'entry_marker', 'entry_temperature', 'entry_marker_at',
  'hot_alert_sent_at', 'urgent_alert_sent_at',
  'price_given_at', 'soft_closed_at',
  'sales_phase', 'lead_intent',
  'assigned_line_id', 'assigned_agent_chat', 'conversation_mode',
  'converted_at', 'gallery_nudged_at',
  'lead_pain', 'lead_pain_detail', 'lead_pain_detected_at',
  'selected_experience_id',
  // Direct writes are mainly a test/migration seam; production code derives
  // these from collected_date via canonicalDateColumns() in this file.
  'collected_date_canon_year', 'collected_date_canon_month', 'collected_date_canon_day',
]);

/**
 * Best-effort canonical {year, month, day} derived from the free-text
 * `collected_date` value, or all-null when it should be cleared (no
 * recognizable month, or the date was deferred). Computed explicitly rather
 * than through the generic upsert() column loop below because that loop
 * skips `null` values — clearing a stale canonical date needs an explicit
 * `= NULL`, the same pattern already used for collected_date/collected_date_window.
 */
function canonicalDateColumns(dateText: string): { year: number | null; month: number | null; day: number | null } {
  const canonical = canonicalizeDateText(dateText);
  return { year: canonical?.year ?? null, month: canonical?.month ?? null, day: canonical?.day ?? null };
}

/**
 * "Worth following up" gate, shared by the one-shot template and the consent ask so the
 * two can never drift apart. A drive-by "hola" with nothing collected is still excluded.
 *
 * `price_given_at` is part of the gate because a lead who received a full quote is the
 * MOST qualified kind of lead, and neither `collected_plan` nor `collected_people` is
 * guaranteed to be set when that happens: both are written only from regex extraction of
 * the CUSTOMER's own words (`qualification-engine.ts`) or from an LLM structured turn,
 * and the plain-text reply path hardcodes `collected_fields` to all-null
 * (`deepseek-llm-client.ts`). A lead who entered on a transport-diagnosis entry segment,
 * answered it, then asked "¿qué vale el plan?" gets a real quote while both columns stay
 * NULL — so the narrower gate silently dropped exactly the leads worth re-engaging.
 */
const QUALIFIED_FOR_FOLLOWUP_SQL =
  '(c.collected_plan IS NOT NULL OR c.collected_people IS NOT NULL OR c.price_given_at IS NOT NULL)';

export class SqliteConversationRepo implements ConversationRepository {
  constructor(private db: Database.Database) {}

  getByPhone(phone: string): ConversationRow | undefined {
    return this.db.prepare(
      'SELECT * FROM conversations WHERE customer_phone = ?'
    ).get(phone) as ConversationRow | undefined;
  }

  listFollowupCandidates(input: { silentSinceIso: string; limit: number }): FollowupCandidateRow[] {
    return this.db.prepare(`
      SELECT c.customer_phone, c.language, c.collected_plan, c.selected_experience_id,
             last_in.created_at AS anchor_at
      FROM conversations c
      JOIN (
        SELECT customer_phone, MAX(created_at) AS created_at
        FROM messages WHERE direction = 'inbound' GROUP BY customer_phone
      ) last_in ON last_in.customer_phone = c.customer_phone
      LEFT JOIN followup_consent fc ON fc.customer_phone = c.customer_phone
      LEFT JOIN followup_subscriptions fs ON fs.customer_phone = c.customer_phone
      WHERE c.opt_out_at IS NULL
        AND c.converted_at IS NULL
        AND c.handed_off_at IS NULL
        AND c.soft_closed_at IS NULL
        AND COALESCE(c.conversation_mode, 'bot') IN ('bot', 'human_pending')
        AND ${QUALIFIED_FOR_FOLLOWUP_SQL}
        -- A recorded customer refusal outranks BOTH provenances. An operator grant
        -- is a presumption of consent; "no" is the customer answering the question.
        -- Without this the OR below re-enabled every declined lead that happened to
        -- carry an older /followupgrant, because decline() writes only the
        -- subscription and never revokes the operator row.
        AND COALESCE(fs.status, '') <> 'declined'
        -- Permission check: operator grant (not revoked) OR customer active consent
        AND (
          (fc.customer_phone IS NOT NULL AND fc.revoked_at IS NULL)
          OR (fs.customer_phone IS NOT NULL AND fs.status = 'active')
        )
        AND datetime(last_in.created_at) <= datetime(@silentSinceIso)
        -- Never template over an inbound we never answered.
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.customer_phone = c.customer_phone
            AND m.direction = 'outbound'
            AND m.created_at > last_in.created_at
        )
        -- One delivered OR uncertain template per customer, ever (uncertain may already be with Meta).
        AND NOT EXISTS (
          SELECT 1 FROM followup_events fe
          WHERE fe.customer_phone = c.customer_phone
            AND fe.status IN ('sent', 'uncertain')
        )
      ORDER BY last_in.created_at ASC
      LIMIT @limit
    `).all(input) as FollowupCandidateRow[];
  }

  listConsentAskCandidates(input: {
    silentSinceIso: string;
    windowExpiryIso: string;
    limit: number;
  }): ConsentAskCandidateRow[] {
    return this.db.prepare(`
       SELECT c.customer_phone, c.language, last_in.created_at AS anchor_at,
              (
                SELECT COUNT(*) FROM followup_subscription_events previous_ask
                WHERE previous_ask.customer_phone = c.customer_phone
                  AND previous_ask.event_kind = 'consent_ask'
                  AND previous_ask.status IN ('accepted', 'delivered', 'uncertain')
              ) AS consent_asks_so_far,
              COALESCE(fs.consent_session, 1) AS consent_session
      FROM conversations c
      JOIN (
        SELECT customer_phone, MAX(created_at) AS created_at
        FROM messages WHERE direction = 'inbound' GROUP BY customer_phone
      ) last_in ON last_in.customer_phone = c.customer_phone
      LEFT JOIN followup_subscriptions fs ON fs.customer_phone = c.customer_phone
      WHERE c.opt_out_at IS NULL
        AND c.converted_at IS NULL
        AND c.handed_off_at IS NULL
        AND c.soft_closed_at IS NULL
        AND COALESCE(c.conversation_mode, 'bot') IN ('bot', 'human_pending')
        AND ${QUALIFIED_FOR_FOLLOWUP_SQL}
        -- A lead the analyzer marked not_interested is never re-asked. lead_intent
        -- is NULL for anyone never analysed, and in SQLite NULL != 'not_interested'
        -- is NULL (which filters the row out), so the IS NULL branch is REQUIRED:
        -- omitting it would silently exclude most leads.
        AND (c.lead_intent IS NULL OR c.lead_intent != 'not_interested')
        -- Only unasked cycles qualify. Pending/declined/revoked remain excluded;
        -- a pending cycle returns to unasked only through the bounded deferral.
        AND (fs.customer_phone IS NULL OR fs.status = 'unasked')
        -- Silence long enough to ask...
        AND datetime(last_in.created_at) <= datetime(@silentSinceIso)
        -- ...but the free-form 24h window (measured from THEIR message) still open.
        AND datetime(last_in.created_at) > datetime(@windowExpiryIso)
        -- "Never replied": the last message in the thread must be ours.
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.customer_phone = c.customer_phone
            AND m.direction = 'outbound'
            AND m.created_at > last_in.created_at
        )
        -- Event idempotency/retry state is resolved atomically by claim(). A failed
        -- pre-acceptance attempt remains eligible until FOLLOWUP_MAX_ATTEMPTS;
        -- accepted/uncertain asks create a non-unasked subscription and stop here.
      ORDER BY last_in.created_at ASC
      LIMIT @limit
    `).all(input) as ConsentAskCandidateRow[];
  }

  listRecurringCandidates(input: {
    dueBeforeIso: string;
    silentSinceIso: string;
    maxSends: number;
    scanLimit: number;
  }): RecurringCandidateRow[] {
    return this.db.prepare(`
      WITH terminal_recurring AS (
        SELECT customer_phone,
               COALESCE(accepted_at, delivered_at, failed_at) AS terminal_at
        FROM followup_subscription_events
        WHERE event_kind = 'recurring'
          AND status IN ('accepted', 'delivered', 'uncertain')
      ), consent_cycles AS (
        SELECT customer_phone, COUNT(*) AS consent_cycle
        FROM followup_subscription_events
        WHERE event_kind = 'consent_ask'
          AND status IN ('accepted', 'delivered', 'uncertain')
        GROUP BY customer_phone
      )
      SELECT c.customer_phone, c.language, c.collected_plan, c.selected_experience_id,
             COUNT(tr.terminal_at) AS sends_so_far,
             COALESCE(MAX(tr.terminal_at), fs.activated_at) AS last_send_at,
             COALESCE(cc.consent_cycle, 0) AS consent_cycle
      FROM conversations c
      JOIN followup_subscriptions fs ON fs.customer_phone = c.customer_phone
      JOIN (
        SELECT customer_phone, MAX(created_at) AS created_at
        FROM messages WHERE direction = 'inbound' GROUP BY customer_phone
      ) last_in ON last_in.customer_phone = c.customer_phone
      LEFT JOIN terminal_recurring tr
        ON tr.customer_phone = c.customer_phone
       AND datetime(tr.terminal_at) >= datetime(fs.activated_at)
      LEFT JOIN consent_cycles cc ON cc.customer_phone = c.customer_phone
      WHERE fs.status = 'active'
        AND fs.activated_at IS NOT NULL
        AND c.opt_out_at IS NULL
        AND c.converted_at IS NULL
        AND c.handed_off_at IS NULL
        AND c.soft_closed_at IS NULL
        AND COALESCE(c.conversation_mode, 'bot') IN ('bot', 'human_pending')
        -- A re-engagement template is for a DORMANT customer. Consent authorises
        -- writing later, not interrupting a live conversation, so the customer must
        -- have been silent for the dedicated silence FLOOR (independent of the
        -- cadence interval, so a short/accelerated cadence cannot interleave a
        -- template with a live conversation)...
        AND datetime(last_in.created_at) <= datetime(@silentSinceIso)
        -- ...and the last message in the thread must be ours (never template over
        -- an inbound we have not answered).
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.customer_phone = c.customer_phone
            AND m.direction = 'outbound'
            AND m.created_at > last_in.created_at
        )
        -- In-flight state is resolved atomically by claim(): a fresh claim blocks,
        -- while a stale dispatch becomes terminal uncertain and never resends.
      GROUP BY c.customer_phone, c.language, c.collected_plan,
               c.selected_experience_id, fs.activated_at, cc.consent_cycle
      HAVING (@maxSends = 0 OR COUNT(tr.terminal_at) < @maxSends)
         AND datetime(COALESCE(MAX(tr.terminal_at), fs.activated_at)) <= datetime(@dueBeforeIso)
      -- Oldest first, then a generous memory bound. The exact exponential due filter
      -- runs in the service over this set, so the bound must not be the send limit.
      ORDER BY datetime(last_send_at) ASC
      LIMIT @scanLimit
    `).all(input) as RecurringCandidateRow[];
  }

  listMetaAudienceLeads(): MetaAudienceLead[] {
    const rows = this.db.prepare(
      `SELECT customer_phone, collected_name
       FROM conversations
       WHERE converted_at IS NULL
         AND opt_out_at IS NULL
         AND ad_referral_json IS NOT NULL
       ORDER BY customer_phone ASC`
    ).all() as Array<{ customer_phone: string; collected_name: string | null }>;
    return rows.map(row => ({ customerPhone: row.customer_phone, collectedName: row.collected_name }));
  }

  upsert(phone: string, data: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM conversations WHERE customer_phone = ?').get(phone) as ConversationRow | undefined;
    const normalized: Record<string, unknown> = { ...data };

    // Normalize legacy date writes into coherent date_status transitions.
    const rawDateVal = typeof data.collected_date === 'string' ? data.collected_date : null;
    if (typeof normalized.collected_date === 'string') {
      const dateVal = normalized.collected_date;
      if (dateVal === 'tentative_unknown' || dateVal.startsWith('_')) {
        delete normalized.collected_date;
        if (normalized.date_status == null) normalized.date_status = 'deferred';
      } else if (normalized.date_status == null) {
        normalized.date_status = 'selected';
      }
    }
    // Recompute/clear canonical date columns on every status transition that
    // touches collected_date so they never go stale (see canonicalDateColumns).
    let canonicalDate: { year: number | null; month: number | null; day: number | null } | null = null;
    if (normalized.date_status === 'selected' && rawDateVal) {
      canonicalDate = canonicalDateColumns(rawDateVal);
    } else if (normalized.date_status === 'deferred' || normalized.date_status === 'options_offered') {
      canonicalDate = { year: null, month: null, day: null };
    }

    if (existing) {
      const updates: string[] = ['last_seen_at = ?'];
      const values: unknown[] = [now];
      for (const [key, val] of Object.entries(normalized)) {
        if (val !== undefined && val !== null && ALLOWED_CONVERSATION_COLUMNS.has(key)) {
          updates.push(`${key} = ?`);
          values.push(val);
        }
      }
      if (normalized.date_status === 'selected') {
        updates.push('collected_date_window = NULL');
      }
      if (normalized.date_status === 'deferred' || normalized.date_status === 'options_offered') {
        updates.push('collected_date = NULL');
      }
      if (canonicalDate) {
        updates.push('collected_date_canon_year = ?', 'collected_date_canon_month = ?', 'collected_date_canon_day = ?');
        values.push(canonicalDate.year, canonicalDate.month, canonicalDate.day);
      }
      values.push(phone);
      this.db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE customer_phone = ?`).run(...values);
    } else {
      const cols: string[] = ['customer_phone', 'first_seen_at', 'last_seen_at'];
      const vals: unknown[] = [phone, now, now];
      for (const [key, val] of Object.entries(normalized)) {
        if (val !== undefined && val !== null && ALLOWED_CONVERSATION_COLUMNS.has(key)) {
          cols.push(key);
          vals.push(val);
        }
      }
      if (canonicalDate?.year != null) {
        cols.push('collected_date_canon_year', 'collected_date_canon_month', 'collected_date_canon_day');
        vals.push(canonicalDate.year, canonicalDate.month, canonicalDate.day);
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
      'SELECT collected_name, collected_date, collected_date_window, date_status, collected_people, collected_transport_need, collected_lodging_need, collected_pet, collected_plan, collected_adults, collected_children, collected_child_ages_json, collected_travel_origin, language FROM conversations WHERE customer_phone = ?'
    ).get(phone) as Record<string, unknown> | undefined;
    if (!row) return {};
    const fields: Record<string, unknown> = {};
    if (row.collected_name) fields.nombre = row.collected_name;
    if (row.collected_date) fields.fecha = row.collected_date;
    if (row.collected_date_window) fields._date_window = row.collected_date_window;
    fields.dateStatus = this.normalizeDateStatus(row.date_status, row.collected_date, row.collected_date_window);
    // Compat: deferred/options without concrete date expose sentinel for legacy readers.
    if ((fields.dateStatus === 'deferred' || fields.dateStatus === 'options_offered') && !fields.fecha) {
      fields.fecha = 'tentative_unknown';
    }
    if (row.collected_people) fields.personas = row.collected_people;
    if (row.collected_transport_need) fields.transporte = row.collected_transport_need;
    if (row.collected_lodging_need) fields.hospedaje = row.collected_lodging_need;
    if (row.collected_pet) fields.mascota = row.collected_pet;
    if (row.collected_plan) fields.plan = row.collected_plan;
    if (typeof row.collected_adults === 'number') fields.adultos = row.collected_adults;
    if (typeof row.collected_children === 'number') fields.ninos = row.collected_children;
    if (typeof row.collected_child_ages_json === 'string' && row.collected_child_ages_json) {
      const ages = parseChildAgesJson(row.collected_child_ages_json);
      if (ages) fields.edadesNinos = ages;
    }
    if (row.collected_travel_origin) fields.origen = row.collected_travel_origin;
    if (row.language) fields.idioma = row.language;
    return fields;
  }

  resetExperienceSalesState(phone: string): void {
    this.db.prepare(
      `UPDATE conversations
       SET collected_plan = NULL,
           price_given_at = NULL,
           sales_phase = NULL,
           lead_intent = NULL,
           gallery_nudged_at = NULL,
           soft_closed_at = NULL,
           handed_off_at = NULL,
           assigned_line_id = NULL,
           assigned_agent_chat = NULL,
           conversation_mode = 'bot'
       WHERE customer_phone = ?`
    ).run(phone);
  }

  clearCollectedTransport(phone: string): void {
    this.db.prepare('UPDATE conversations SET collected_transport_need = NULL WHERE customer_phone = ?').run(phone);
  }

  clearCollectedDate(phone: string): void {
    this.db.prepare(
      `UPDATE conversations
       SET collected_date = NULL,
           collected_date_canon_year = NULL,
           collected_date_canon_month = NULL,
           collected_date_canon_day = NULL,
                      date_status = CASE WHEN date_status IN ('selected') THEN 'unasked' ELSE date_status END
       WHERE customer_phone = ?`
    ).run(phone);
  }

  clearCollectedChildAges(phone: string): void {
    this.db.prepare('UPDATE conversations SET collected_child_ages_json = NULL WHERE customer_phone = ?').run(phone);
  }

  getDateStatus(phone: string): DateStatus {
    const row = this.db.prepare(
      'SELECT date_status, collected_date, collected_date_window FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { date_status: string | null; collected_date: string | null; collected_date_window: string | null } | undefined;
    if (!row) return 'unasked';
    return this.normalizeDateStatus(row.date_status, row.collected_date, row.collected_date_window);
  }

  setDateAsked(phone: string): void {
    this.ensureConversation(phone);
    const current = this.getDateStatus(phone);
    if (current === 'selected' || current === 'window' || current === 'deferred' || current === 'options_offered') return;
    this.db.prepare(
      `UPDATE conversations SET date_status = 'asked', collected_date = NULL, collected_date_window = NULL,
        collected_date_canon_year = NULL, collected_date_canon_month = NULL, collected_date_canon_day = NULL
        WHERE customer_phone = ?`
    ).run(phone);
  }

  setDateDeferred(phone: string): void {
    this.ensureConversation(phone);
    this.db.prepare(
      `UPDATE conversations SET date_status = 'deferred', collected_date = NULL, collected_date_window = NULL,
        collected_date_canon_year = NULL, collected_date_canon_month = NULL, collected_date_canon_day = NULL
        WHERE customer_phone = ?`
    ).run(phone);
  }

  setDateOptionsOffered(phone: string): void {
    this.ensureConversation(phone);
    const current = this.getDateStatus(phone);
    if (current === 'selected' || current === 'window') return;
    this.db.prepare(
      `UPDATE conversations SET date_status = 'options_offered', collected_date = NULL, collected_date_window = NULL,
        collected_date_canon_year = NULL, collected_date_canon_month = NULL, collected_date_canon_day = NULL
        WHERE customer_phone = ?`
    ).run(phone);
  }

  setSelectedDate(phone: string, date: string): void {
    this.ensureConversation(phone);
    const canonical = canonicalDateColumns(date);
    this.db.prepare(
      `UPDATE conversations
       SET date_status = 'selected', collected_date = ?, collected_date_window = NULL,
           collected_date_canon_year = ?, collected_date_canon_month = ?, collected_date_canon_day = ?
       WHERE customer_phone = ?`
    ).run(date, canonical.year, canonical.month, canonical.day, phone);
  }

  getCollectedDateWindow(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT collected_date_window FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { collected_date_window: string | null } | undefined;
    return row?.collected_date_window ?? null;
  }

  setCollectedDateWindow(phone: string, window: string | null): void {
    this.ensureConversation(phone);
    if (window) {
      this.db.prepare(
        `UPDATE conversations SET collected_date_window = ?, collected_date = NULL, date_status = 'window',
          collected_date_canon_year = NULL, collected_date_canon_month = NULL, collected_date_canon_day = NULL
          WHERE customer_phone = ?`
      ).run(window, phone);
      return;
    }
    this.db.prepare(
      "UPDATE conversations SET collected_date_window = NULL, date_status = CASE WHEN date_status = 'window' THEN 'unasked' ELSE date_status END WHERE customer_phone = ?"
    ).run(phone);
  }

  private ensureConversation(phone: string): void {
    if (!this.getByPhone(phone)) this.upsert(phone, {});
  }

  private normalizeDateStatus(
    status: unknown,
    collectedDate: unknown,
    collectedWindow: unknown,
  ): DateStatus {
    const allowed: DateStatus[] = ['unasked', 'asked', 'deferred', 'options_offered', 'selected', 'window'];
    if (typeof status === 'string' && (allowed as string[]).includes(status)) {
      return status as DateStatus;
    }
    if (typeof collectedWindow === 'string' && collectedWindow.trim()) return 'window';
    if (typeof collectedDate === 'string' && collectedDate.trim()) {
      if (collectedDate === 'tentative_unknown' || collectedDate.startsWith('_')) return 'deferred';
      return 'selected';
    }
    return 'unasked';
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

  getSelectedExperienceId(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT selected_experience_id FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { selected_experience_id: string | null } | undefined;
    return row?.selected_experience_id ?? null;
  }

  setSelectedExperienceId(phone: string, experienceId: string): void {
    this.upsert(phone, { selected_experience_id: experienceId });
  }

  clearSelectedExperienceId(phone: string): void {
    this.db.prepare('UPDATE conversations SET selected_experience_id = NULL WHERE customer_phone = ?').run(phone);
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

}

export class SqliteBridgeSessionRepo implements BridgeSessionRepository {
  constructor(private db: Database.Database) {}

  open(agentChatId: string, customerPhone: string, returnMode: 'bot' | 'human_only' = 'bot'): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO bridge_sessions (agent_chat_id, customer_phone, opened_at, last_activity_at, return_mode)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_chat_id) DO UPDATE SET customer_phone = ?, last_activity_at = ?, return_mode = ?`
    ).run(agentChatId, customerPhone, now, now, returnMode, customerPhone, now, returnMode);
  }

  close(agentChatId: string): void {
    this.db.prepare('DELETE FROM bridge_sessions WHERE agent_chat_id = ?').run(agentChatId);
  }

  getByAgentChat(agentChatId: string): BridgeSessionRow | null {
    const row = this.db.prepare(
      'SELECT agent_chat_id, customer_phone, opened_at, last_activity_at, return_mode FROM bridge_sessions WHERE agent_chat_id = ?'
    ).get(agentChatId) as { agent_chat_id: string; customer_phone: string; opened_at: string; last_activity_at: string; return_mode: 'bot' | 'human_only' } | undefined;
    if (!row) return null;
    return { agentChatId: row.agent_chat_id, customerPhone: row.customer_phone, openedAt: row.opened_at, lastActivityAt: row.last_activity_at, returnMode: row.return_mode };
  }

  getByCustomer(customerPhone: string): BridgeSessionRow | null {
    const row = this.db.prepare(
      'SELECT agent_chat_id, customer_phone, opened_at, last_activity_at, return_mode FROM bridge_sessions WHERE customer_phone = ? ORDER BY last_activity_at DESC LIMIT 1'
    ).get(customerPhone) as { agent_chat_id: string; customer_phone: string; opened_at: string; last_activity_at: string; return_mode: 'bot' | 'human_only' } | undefined;
    if (!row) return null;
    return { agentChatId: row.agent_chat_id, customerPhone: row.customer_phone, openedAt: row.opened_at, lastActivityAt: row.last_activity_at, returnMode: row.return_mode };
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
      `INSERT OR IGNORE INTO messages (whatsapp_message_id, customer_phone, direction, message_type, body, created_at, raw_json, app_version, media_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(msg.whatsapp_message_id ?? null, msg.customer_phone, msg.direction, msg.message_type, msg.body ?? null, msg.created_at, msg.raw_json ?? null, appVersion, msg.media_id ?? null);
  }

  getLastOutboundBody(phone: string): string | null {
    const row = this.db.prepare(
      "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'outbound' ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(phone) as { body: string | null } | undefined;
    return row?.body ?? null;
  }

  getLastOutboundTextBody(phone: string): string | null {
    // message_type = 'text' so an image caption (e.g. owner intro photo) never
    // becomes "the last thing the bot asked" for qualification context — the
    // real question text before it wins.
    const row = this.db.prepare(
      "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'outbound' AND message_type = 'text' ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(phone) as { body: string | null } | undefined;
    return row?.body ?? null;
  }

  getRecentMessages(phone: string, limit: number = 12): RecentMessage[] {
    const rows = this.db.prepare(
      "SELECT direction, body, message_type, created_at, media_id FROM messages WHERE customer_phone = ? AND message_type != 'template' ORDER BY created_at DESC, id DESC LIMIT ?"
    ).all(phone, limit) as { direction: string; body: string | null; message_type: string | null; created_at: string; media_id: string | null }[];
    return rows.reverse().map(r => ({
      role: r.direction === 'inbound' ? 'user' as const : 'assistant' as const,
      content: r.body ?? '',
      messageType: r.message_type ?? undefined,
      createdAt: r.created_at,
      mediaId: r.media_id ?? undefined,
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

  listInboundSince(phones: string[], sinceIso: string): { customer_phone: string; created_at: string }[] {
    if (phones.length === 0) return [];

    // Chunked because SQLite caps bound parameters (999 on older builds) and the
    // caller's phone set is not bounded by a LIMIT.
    const CHUNK = 400;
    const rows: { customer_phone: string; created_at: string }[] = [];
    for (let start = 0; start < phones.length; start += CHUNK) {
      const chunk = phones.slice(start, start + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      rows.push(...this.db.prepare(`
        SELECT customer_phone, created_at
        FROM messages
        WHERE direction = 'inbound'
          AND customer_phone IN (${placeholders})
          AND datetime(created_at) >= datetime(?)
        ORDER BY customer_phone ASC, datetime(created_at) ASC
      `).all(...chunk, sinceIso) as { customer_phone: string; created_at: string }[]);
    }
    return rows;
  }

  getLastMessageDirection(phone: string): 'inbound' | 'outbound' | null {
    const row = this.db.prepare(
      "SELECT direction FROM messages WHERE customer_phone = ? ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(phone) as { direction: 'inbound' | 'outbound' } | undefined;
    return row?.direction ?? null;
  }

  countOutboundSince(phone: string, sinceIso: string, messageType?: 'text' | 'image'): number {
    const typeClause = messageType ? ' AND message_type = ?' : '';
    const params = messageType ? [phone, sinceIso, messageType] : [phone, sinceIso];
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE customer_phone = ? AND direction = 'outbound' AND created_at >= ?${typeClause}`
    ).get(...params) as { cnt: number };
    return row.cnt;
  }
}

export class SqliteOutboundMediaRepo implements OutboundMediaRepository {
  constructor(private db: Database.Database) {}

  record(row: OutboundMediaRow): void {
    this.db.prepare(`
      INSERT INTO outbound_media (
        customer_phone, media_url, media_id, caption, carried_reply, flow,
        theme_site_id, theme_type, turn_inbound_message_id, sequence, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.customer_phone,
      row.media_url,
      row.media_id,
      row.caption ?? null,
      row.carried_reply,
      row.flow,
      row.theme_site_id ?? null,
      row.theme_type ?? null,
      row.turn_inbound_message_id ?? null,
      row.sequence ?? null,
      row.sent_at
    );
  }

  listByPhone(phone: string, limit: number = 50): OutboundMediaRow[] {
    return this.db.prepare(`
      SELECT id, customer_phone, media_url, media_id, caption, carried_reply, flow,
             theme_site_id, theme_type, turn_inbound_message_id, sequence, sent_at
      FROM outbound_media
      WHERE customer_phone = ?
      ORDER BY sent_at DESC
      LIMIT ?
    `).all(phone, limit) as OutboundMediaRow[];
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
      'INSERT INTO conversations (customer_phone, opt_out_at, last_opt_out_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(customer_phone) DO UPDATE SET opt_out_at = ?, last_opt_out_at = ?'
    ).run(phone, now, now, now, now, now, now);
  }

  /**
   * Clears only the ACTIVE suppression flag (customer-initiated return).
   * `last_opt_out_at` is deliberately preserved: it is the compliance evidence
   * that the customer once asked us to stop, and nothing may erase it.
   */
  clearOptOut(phone: string): void {
    this.db.prepare('UPDATE conversations SET opt_out_at = NULL WHERE customer_phone = ?').run(phone);
  }

  getLastOptOutAt(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT last_opt_out_at FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { last_opt_out_at: string | null } | undefined;
    return row?.last_opt_out_at ?? null;
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

  // substr() instead of LIKE: '_' is a single-char wildcard in LIKE and the
  // gallery prefix ends with one, so LIKE would also match 'galleryX...'.
  countRecentImagesWithPrefix(phone: string, cutoffIso: string, prefix: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM media_sends WHERE customer_phone = ? AND sent_at >= ? AND substr(media_id, 1, ?) = ?'
    ).get(phone, cutoffIso, prefix.length, prefix) as { cnt: number };
    return row.cnt;
  }

  hasRecentSameImage(phone: string, imageId: string, cutoffIso: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM media_sends WHERE customer_phone = ? AND media_id = ? AND sent_at >= ? LIMIT 1'
    ).get(phone, imageId, cutoffIso);
    return !!row;
  }

  // Same reason the prefix count avoids LIKE: '_' is a single-char wildcard, and
  // both the namespace prefix and the gallery id are full of them, so a LIKE
  // pattern also matches a DIFFERENT photo ('galleryX/a.jpg' for 'gallery_/a.jpg').
  // substr() on both ends keeps the comparison exact.
  getLastSentAtForImage(phone: string, imageId: string, scopedPrefix?: string): string | null {
    if (!scopedPrefix) {
      const exact = this.db.prepare(
        'SELECT sent_at FROM media_sends WHERE customer_phone = ? AND media_id = ? ORDER BY sent_at DESC LIMIT 1'
      ).get(phone, imageId) as { sent_at: string } | undefined;
      return exact?.sent_at ?? null;
    }
    const scopedSuffix = `_${imageId}`;
    const row = this.db.prepare(
      `SELECT sent_at FROM media_sends
       WHERE customer_phone = ?
         AND (media_id = ?
           OR (substr(media_id, 1, ?) = ? AND substr(media_id, -?) = ?))
       ORDER BY sent_at DESC LIMIT 1`
    ).get(
      phone,
      imageId,
      scopedPrefix.length,
      scopedPrefix,
      scopedSuffix.length,
      scopedSuffix,
    ) as { sent_at: string } | undefined;
    return row?.sent_at ?? null;
  }

  claimSend(phone: string, mediaId: string, cutoffIso: string): number | null {
    return this.db.transaction(() => {
      if (this.hasRecentSameImage(phone, mediaId, cutoffIso)) return null;
      const result = this.db.prepare(
        'INSERT INTO media_sends (customer_phone, media_id, sent_at) VALUES (?, ?, ?)'
      ).run(phone, mediaId, new Date().toISOString());
      return Number(result.lastInsertRowid);
    })();
  }

  releaseClaim(id: number): void {
    this.db.prepare('DELETE FROM media_sends WHERE id = ?').run(id);
  }

  recordSend(phone: string, mediaId: string): void {
    this.db.prepare(
      'INSERT INTO media_sends (customer_phone, media_id, sent_at) VALUES (?, ?, ?)'
    ).run(phone, mediaId, new Date().toISOString());
  }
}

interface PaymentReservationRow {
  id: number;
  external_reference: string;
  customer_phone: string;
  preference_id: string | null;
  payment_url: string | null;
  expected_amount_cop: number;
  plan_id: string | null;
  booking_date: string | null;
  people: number | null;
  transport_need: string | null;
  deposit_percent: number | null;
  availability_confirmed_at: string | null;
  status: PaymentReservation['status'];
  created_at: string;
  approved_at: string | null;
  mercado_pago_payment_id: string | null;
}

export class SqlitePaymentReservationRepo implements PaymentReservationRepository {
  constructor(private db: Database.Database) {}

  createPending(reservation: PaymentReservationCreate): boolean {
    const result = this.db.prepare(`
      INSERT INTO payment_reservations
        (external_reference, customer_phone, expected_amount_cop, plan_id, booking_date,
         people, transport_need, deposit_percent, availability_confirmed_at, status, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM payment_reservations WHERE customer_phone = ? AND status = 'pending'
      )
    `).run(
      reservation.externalReference,
      reservation.customerPhone,
      reservation.expectedAmountCop,
      reservation.planId,
      reservation.date,
      reservation.people,
      reservation.transportNeed,
      reservation.depositPercent,
      reservation.availabilityConfirmedAt,
      new Date().toISOString(),
      reservation.customerPhone,
    );
    return result.changes > 0;
  }

  attachPreference(externalReference: string, preferenceId: string, paymentUrl: string): void {
    this.db.prepare(
      'UPDATE payment_reservations SET preference_id = ?, payment_url = ? WHERE external_reference = ?'
    ).run(preferenceId, paymentUrl, externalReference);
  }

  getByExternalReference(externalReference: string): PaymentReservation | null {
    const row = this.db.prepare(
      'SELECT * FROM payment_reservations WHERE external_reference = ?'
    ).get(externalReference) as PaymentReservationRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      externalReference: row.external_reference,
      customerPhone: row.customer_phone,
      preferenceId: row.preference_id,
      paymentUrl: row.payment_url,
      expectedAmountCop: row.expected_amount_cop,
      planId: row.plan_id,
      date: row.booking_date,
      people: row.people,
      transportNeed: row.transport_need,
      depositPercent: row.deposit_percent,
      availabilityConfirmedAt: row.availability_confirmed_at,
      status: row.status,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
      mercadoPagoPaymentId: row.mercado_pago_payment_id,
    };
  }

  getPendingByCustomerPhone(customerPhone: string): PaymentReservation | null {
    const row = this.db.prepare(`
      SELECT external_reference
      FROM payment_reservations
      WHERE customer_phone = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(customerPhone) as { external_reference: string } | undefined;
    return row ? this.getByExternalReference(row.external_reference) : null;
  }

  markApproved(externalReference: string, mercadoPagoPaymentId: string): boolean {
    const result = this.db.prepare(`
      UPDATE payment_reservations
      SET status = 'approved', approved_at = ?, mercado_pago_payment_id = ?
      WHERE external_reference = ? AND status = 'pending'
    `).run(new Date().toISOString(), mercadoPagoPaymentId, externalReference);
    return result.changes > 0;
  }

  markFailed(externalReference: string): void {
    this.db.prepare(`
      UPDATE payment_reservations
      SET status = 'failed'
      WHERE external_reference = ? AND status = 'pending'
    `).run(externalReference);
  }
}

type SummaryDbRow = {
  customer_phone: string; collected_name: string | null; lead_score: number;
  sales_phase: string | null; collected_plan: string | null;
  collected_people: number | null; collected_date: string | null;
  collected_transport_need: string | null; collected_adults: number | null;
  collected_children: number | null; collected_child_ages_json: string | null;
  collected_travel_origin: string | null; entry_marker: string | null;
  entry_temperature: 'cold' | 'funnel' | 'retargeting' | null;
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
      transportNeed: r.collected_transport_need,
      adults: r.collected_adults,
      children: r.collected_children,
      childAges: parseChildAgesJson(r.collected_child_ages_json),
      travelOrigin: r.collected_travel_origin,
      entryMarker: r.entry_marker,
      entryTemperature: r.entry_temperature,
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
             collected_plan, collected_people, collected_date, collected_transport_need,
             collected_adults, collected_children, collected_child_ages_json,
             collected_travel_origin, entry_marker, entry_temperature, last_seen_at
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
             c.collected_plan, c.collected_people, c.collected_date, c.collected_transport_need,
             c.collected_adults, c.collected_children, c.collected_child_ages_json,
             c.collected_travel_origin, c.entry_marker, c.entry_temperature,
             MAX(m.created_at) AS last_seen_at
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

  getTopLeads(limit: number, threshold: number, lineId?: string | null, excludedPhones: string[] = []): ConversationSummary[] {
    const lineFilter = lineId ? 'AND (assigned_line_id = @lineId OR assigned_line_id IS NULL)' : '';
    const rows = this.db.prepare(`
      SELECT customer_phone, collected_name, lead_score, sales_phase,
             collected_plan, collected_people, collected_date, collected_transport_need,
             collected_adults, collected_children, collected_child_ages_json,
             collected_travel_origin, entry_marker, entry_temperature, last_seen_at
      FROM conversations
      WHERE opt_out_at IS NULL
        AND lead_score >= @threshold
        AND customer_phone NOT IN (SELECT value FROM json_each(@excludedJson))
        ${lineFilter}
      ORDER BY lead_score DESC
      LIMIT @limit
    `).all({
      threshold,
      lineId: lineId ?? null,
      excludedJson: JSON.stringify(excludedPhones),
      limit,
    }) as SummaryDbRow[];
    return rows.map(SqliteStatsRepo.mapRowToSummary);
  }

  getLeadCountsByLine(hotLeadThreshold: number, excludedPhones: string[] = []): LineLeadCount[] {
    const rows = this.db.prepare(`
      SELECT COALESCE(assigned_line_id, 'unassigned') as line_id,
             COUNT(*) as total,
             SUM(CASE WHEN lead_score >= @threshold THEN 1 ELSE 0 END) as hot,
             SUM(CASE WHEN converted_at IS NOT NULL THEN 1 ELSE 0 END) as booked
      FROM conversations
      WHERE opt_out_at IS NULL
        AND customer_phone NOT IN (SELECT value FROM json_each(@excludedJson))
      GROUP BY line_id
      ORDER BY total DESC
    `).all({ threshold: hotLeadThreshold, excludedJson: JSON.stringify(excludedPhones) }) as { line_id: string; total: number; hot: number; booked: number }[];
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

  constructor(db: Database.Database) {
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
      const followupSubscriptionEvents = this.db.prepare('DELETE FROM followup_subscription_events WHERE customer_phone = ?').run(customerPhone).changes;
      const followupEvents = this.db.prepare('DELETE FROM followup_events WHERE customer_phone = ?').run(customerPhone).changes;
      const followupSubscriptions = this.db.prepare('DELETE FROM followup_subscriptions WHERE customer_phone = ?').run(customerPhone).changes;
      const followupConsent = this.db.prepare('DELETE FROM followup_consent WHERE customer_phone = ?').run(customerPhone).changes;
      const followupConsentGrants = this.db.prepare('DELETE FROM followup_consent_grants WHERE customer_phone = ?').run(customerPhone).changes;
      const mediaSends = this.db.prepare('DELETE FROM media_sends WHERE customer_phone = ?').run(customerPhone).changes;
      const ownerAlerts = this.db.prepare('DELETE FROM owner_alerts WHERE customer_phone = ?').run(customerPhone).changes;
      const aiUsage = this.db.prepare('DELETE FROM ai_usage WHERE customer_phone = ?').run(customerPhone).changes;
      const messages = this.db.prepare('DELETE FROM messages WHERE customer_phone = ?').run(customerPhone).changes;
      const conversations = this.db.prepare('DELETE FROM conversations WHERE customer_phone = ?').run(customerPhone).changes;

      return {
        conversations,
        messages,
        processedMessages,
        aiUsage,
        ownerAlerts,
        mediaSends,
        bridgeSessions,
        followupConsent,
        followupConsentGrants,
        followupEvents,
        followupSubscriptions,
        followupSubscriptionEvents,
      };
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
  collected_adults: number | null;
  collected_children: number | null;
  collected_child_ages_json: string | null;
  collected_travel_origin: string | null;
  handed_off_at: string | null;
  converted_at: string | null;
  conversation_mode: ConversationMode | null;
  entry_marker: string | null;
  entry_temperature: 'cold' | 'funnel' | 'retargeting' | null;
  entry_marker_at: string | null;
  ad_referral_json: string | null;
}

function parseChildAgesJson(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      && parsed.every((age): age is number => Number.isInteger(age) && age >= 0 && age <= 17)
      ? parsed
      : null;
  } catch {
    return null;
  }
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
        entry_marker, entry_temperature, entry_marker_at, ad_referral_json,
        collected_name, collected_date, collected_people, collected_transport_need,
        collected_lodging_need, collected_pet, collected_plan, handed_off_at,
        collected_adults, collected_children, collected_child_ages_json, collected_travel_origin,
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
        entryMarker: conv.entry_marker,
        entryTemperature: conv.entry_temperature,
        entryMarkerAt: conv.entry_marker_at,
        adReferral: conv.ad_referral_json,
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
          adults: conv.collected_adults,
          children: conv.collected_children,
          childAges: parseChildAgesJson(conv.collected_child_ages_json),
          travelOrigin: conv.collected_travel_origin,
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
      collected_transport_need: string | null;
      collected_adults: number | null;
      collected_children: number | null;
      collected_child_ages_json: string | null;
      collected_travel_origin: string | null;
      entry_marker: string | null;
      entry_temperature: 'cold' | 'funnel' | 'retargeting' | null;
      entry_marker_at: string | null;
      ad_referral_json: string | null;
      lead_intent: string | null;
      sales_phase: string | null;
      handed_off_at: string | null;
      converted_at: string | null;
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
        MAX(m.created_at) AS last_activity_at,
        c.lead_score,
        c.collected_name,
        c.collected_date,
        c.collected_people,
        c.collected_plan,
        c.collected_transport_need,
        c.collected_adults,
        c.collected_children,
        c.collected_child_ages_json,
        c.collected_travel_origin,
        c.entry_marker,
        c.entry_temperature,
        c.entry_marker_at,
        c.ad_referral_json,
        c.lead_intent,
        c.sales_phase,
        c.handed_off_at,
        c.converted_at,
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
      ORDER BY last_activity_at DESC
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
        transportNeed: conv.collected_transport_need,
        adults: conv.collected_adults,
        children: conv.collected_children,
        childAges: parseChildAgesJson(conv.collected_child_ages_json),
        travelOrigin: conv.collected_travel_origin,
        entryMarker: conv.entry_marker,
        entryTemperature: conv.entry_temperature,
        entryMarkerAt: conv.entry_marker_at,
        adReferralJson: conv.ad_referral_json,
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
        followUps: [],
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
        followUpsSent: 0,
        followUpsReplied: 0,
        followUpHandoffs: 0,
        followUpBookings: 0,
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

export class SqliteFollowupConsentRepo implements FollowupConsentRepository {
  constructor(private db: Database.Database) {}

  hasConsent(phone: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM followup_consent
      WHERE customer_phone = ? AND granted_at IS NOT NULL AND revoked_at IS NULL
    `).get(phone);
    return !!row;
  }

  grantConsent(phone: string, grantedBy: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO followup_consent (customer_phone, granted_at, granted_by, revoked_at)
      VALUES (?, datetime('now'), ?, NULL)
    `).run(phone, grantedBy);
  }

  revokeConsent(phone: string): void {
    this.db.prepare(`
      UPDATE followup_consent SET revoked_at = datetime('now')
      WHERE customer_phone = ?
    `).run(phone);
  }
}

export class SqliteFollowupConsentGrantRepo implements FollowupConsentGrantRepository {
  constructor(private db: Database.Database) {}

  record(grant: FollowupConsentGrantRow): void {
    this.db.prepare(`
      INSERT INTO followup_consent_grants (customer_phone, decision, decided_at, inbound_message_id, source, actor_id, ask_cycle_key, app_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      grant.customer_phone,
      grant.decision,
      grant.decided_at,
      grant.inbound_message_id ?? null,
      grant.source,
      grant.actor_id ?? null,
      grant.ask_cycle_key ?? null,
      grant.app_version ?? null
    );
  }

  listByPhone(phone: string, limit = 100): FollowupConsentGrantRow[] {
    return this.db.prepare(`
      SELECT id, customer_phone, decision, decided_at, inbound_message_id, source, actor_id, ask_cycle_key, app_version, created_at
      FROM followup_consent_grants
      WHERE customer_phone = ?
      ORDER BY datetime(decided_at) DESC, id DESC
      LIMIT ?
    `).all(phone, limit) as FollowupConsentGrantRow[];
  }

  /** Newest decision of any kind — may be a decline or a revocation, not only a grant. */
  latestDecision(phone: string): FollowupConsentGrantRow | null {
    // `.get()` yields undefined for no row; the contract is `null`, and an undefined
    // leaking out makes `=== null` checks silently false.
    const row = this.db.prepare(`
      SELECT id, customer_phone, decision, decided_at, inbound_message_id, source, actor_id, ask_cycle_key, app_version, created_at
      FROM followup_consent_grants
      WHERE customer_phone = ?
      ORDER BY datetime(decided_at) DESC, id DESC
      LIMIT 1
    `).get(phone) as FollowupConsentGrantRow | undefined;
    return row ?? null;
  }

  countBetween(startIso: string, endIso: string): number {
    // datetime() on both sides: writers mix JS ISO strings with SQLite's
    // 'YYYY-MM-DD HH:MM:SS', which compare wrong as plain text.
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM followup_consent_grants
      WHERE datetime(decided_at) >= datetime(?) AND datetime(decided_at) < datetime(?)
    `).get(startIso, endIso) as { cnt: number };
    return row.cnt;
  }
}

export class SqliteFollowupEventRepo implements FollowupEventRepository {
  constructor(private db: Database.Database) {}

  /**
   * Reserves the send inside a single transaction. The `UNIQUE(customer_phone,
   * anchor_at)` key makes this idempotent under concurrent ticks.
   * A `failed` row is retried only until `maxAttempts`. A `pending` row older
   * than `stalePendingMinutes` may be reclaimed after a crash. `uncertain` and
   * `sent` are terminal for the customer.
   */
  claim(phone: string, anchorAt: string, maxAttempts: number, stalePendingMinutes: number): number | null {
    const claimTx = this.db.transaction((): number | null => {
      const terminal = this.db.prepare(
        "SELECT id FROM followup_events WHERE customer_phone = ? AND status IN ('sent', 'uncertain') LIMIT 1"
      ).get(phone) as { id: number } | undefined;
      if (terminal) return null;

      const existing = this.db.prepare(
        `SELECT id, attempts, status,
                CASE WHEN claimed_at <= datetime('now', printf('-%d minutes', ?)) THEN 1 ELSE 0 END AS is_stale
         FROM followup_events WHERE customer_phone = ? AND anchor_at = ?`
      ).get(Math.max(1, stalePendingMinutes), phone, anchorAt) as {
        id: number;
        attempts: number;
        status: string;
        is_stale: number;
      } | undefined;

      if (!existing) {
        const info = this.db.prepare(`
          INSERT INTO followup_events (customer_phone, anchor_at, claimed_at, attempts, status)
          VALUES (?, ?, datetime('now'), 1, 'pending')
        `).run(phone, anchorAt);
        return Number(info.lastInsertRowid);
      }

      if (existing.status === 'pending') {
        // Fresh pending = another worker mid-flight. Stale pending = crash recovery.
        if (!existing.is_stale || existing.attempts >= maxAttempts) return null;

        this.db.prepare(`
          UPDATE followup_events
          SET claimed_at = datetime('now'), attempts = attempts + 1,
              failed_at = NULL, error_reason = NULL
          WHERE id = ? AND status = 'pending'
        `).run(existing.id);
        return existing.id;
      }

      if (existing.attempts >= maxAttempts) return null;

      this.db.prepare(`
        UPDATE followup_events
        SET status = 'pending', attempts = attempts + 1, claimed_at = datetime('now'),
            failed_at = NULL, error_reason = NULL
        WHERE id = ?
      `).run(existing.id);
      return existing.id;
    });

    return claimTx();
  }

  markSent(claimId: number, whatsappMessageId: string): void {
    // Clears the `dispatch_in_progress` marker written by markDispatching(), so a
    // delivered row does not keep a failure reason forever.
    this.db.prepare(`
      UPDATE followup_events
      SET sent_at = datetime('now'), whatsapp_message_id = ?, status = 'sent',
          failed_at = NULL, error_reason = NULL
      WHERE id = ?
    `).run(whatsappMessageId, claimId);
  }

  markDispatching(claimId: number): void {
    this.db.prepare(`
      UPDATE followup_events
      SET failed_at = datetime('now'), error_reason = 'dispatch_in_progress', status = 'uncertain'
      WHERE id = ? AND status = 'pending'
    `).run(claimId);
  }

  markFailed(claimId: number, reason: string): void {
    this.db.prepare(`
      UPDATE followup_events
      SET failed_at = datetime('now'), error_reason = ?, status = 'failed'
      WHERE id = ?
    `).run(reason.slice(0, 300), claimId);
  }

  markUncertain(claimId: number, reason: string): void {
    this.db.prepare(`
      UPDATE followup_events
      SET failed_at = datetime('now'), error_reason = ?, status = 'uncertain'
      WHERE id = ?
    `).run(reason.slice(0, 300), claimId);
  }

  /**
   * Releases a claim that never reached Meta (e.g. the bot was paused between the
   * candidate scan and dispatch). The row is removed so `attempts` keeps meaning
   * "Meta send attempts" and a transient local guard cannot burn the retry budget.
   */
  releaseClaim(claimId: number): void {
    this.db.prepare('DELETE FROM followup_events WHERE id = ? AND status = ?').run(claimId, 'pending');
  }

  getLatest(phone: string): FollowupEventRow | null {
    const row = this.db.prepare(`
      SELECT id, customer_phone, anchor_at, claimed_at, attempts, sent_at, whatsapp_message_id, failed_at, error_reason, status
      FROM followup_events
      WHERE customer_phone = ?
      ORDER BY claimed_at DESC, id DESC LIMIT 1
    `).get(phone) as FollowupEventRow | undefined;
    return row ?? null;
  }

  listReachedMetaBetween(sinceIso: string, untilIso: string): FollowupEventRow[] {
    // datetime() on both sides: stored values mix SQLite's 'YYYY-MM-DD HH:MM:SS'
    // (datetime('now')) with JS ISO strings, which compare wrong as plain text.
    return this.db.prepare(`
      SELECT id, customer_phone, anchor_at, claimed_at, attempts, sent_at,
             whatsapp_message_id, failed_at, error_reason, status
      FROM followup_events
      WHERE status IN ('sent', 'uncertain')
        AND datetime(COALESCE(sent_at, failed_at)) >= datetime(@sinceIso)
        AND datetime(COALESCE(sent_at, failed_at)) < datetime(@untilIso)
      ORDER BY datetime(COALESCE(sent_at, failed_at)) ASC
    `).all({ sinceIso, untilIso }) as FollowupEventRow[];
  }
}

export class SqliteFollowupSubscriptionRepo implements FollowupSubscriptionRepository {
  constructor(private db: Database.Database) {}

  getByPhone(phone: string): FollowupSubscriptionRow | null {
    const row = this.db.prepare('SELECT * FROM followup_subscriptions WHERE customer_phone = ?').get(phone) as FollowupSubscriptionRow | undefined;
    return row ?? null;
  }

  listStatuses(phones: string[]): { customer_phone: string; status: FollowupSubscriptionStatus }[] {
    if (phones.length === 0) return [];

    const CHUNK = 400;
    const rows: { customer_phone: string; status: FollowupSubscriptionStatus }[] = [];
    for (let start = 0; start < phones.length; start += CHUNK) {
      const chunk = phones.slice(start, start + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      rows.push(...this.db.prepare(
        `SELECT customer_phone, status FROM followup_subscriptions WHERE customer_phone IN (${placeholders})`
      ).all(...chunk) as { customer_phone: string; status: FollowupSubscriptionStatus }[]);
    }
    return rows;
  }

  ensureExists(phone: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO followup_subscriptions (customer_phone, status, updated_at)
      VALUES (?, 'unasked', datetime('now'))
    `).run(phone);
  }

  markAsked(phone: string, outboundMessageId: string | null): void {
    this.db.prepare(`
      UPDATE followup_subscriptions
      SET status = 'pending', asked_at = datetime('now'), ask_outbound_message_id = ?, updated_at = datetime('now')
      WHERE customer_phone = ?
    `).run(outboundMessageId, phone);
  }

  resetUnaskedIfPending(phone: string): void {
    this.db.prepare(`
      UPDATE followup_subscriptions
      SET status = 'unasked', asked_at = NULL, ask_outbound_message_id = NULL,
          updated_at = datetime('now')
      WHERE customer_phone = ? AND status = 'pending'
    `).run(phone);
  }

   deferPendingAskAfterCustomerInbound(phone: string): boolean {
     const result = this.db.prepare(`
       UPDATE followup_subscriptions
       SET status = 'unasked', asked_at = NULL, ask_outbound_message_id = NULL,
           deferred_reask_used = 1, consent_session = consent_session + 1,
           updated_at = datetime('now')
       WHERE customer_phone = ?
         AND status = 'pending'
         AND deferred_reask_used = 0
         AND ask_outbound_message_id IS NOT NULL
     `).run(phone);
     return result.changes > 0;
   }

  affirm(phone: string, inboundMessageId: string, consentSource: string): void {
    this.db.prepare(`
      UPDATE followup_subscriptions
      SET status = 'active', decided_at = datetime('now'), decision_inbound_message_id = ?,
          consent_source = ?, activated_at = datetime('now'), updated_at = datetime('now')
      WHERE customer_phone = ?
    `).run(inboundMessageId, consentSource, phone);
  }

  decline(phone: string, inboundMessageId: string): void {
    this.db.prepare(`
      UPDATE followup_subscriptions
      SET status = 'declined', decided_at = datetime('now'), decision_inbound_message_id = ?, updated_at = datetime('now')
      WHERE customer_phone = ?
    `).run(inboundMessageId, phone);
  }

  /**
   * An OPERATOR revocation is immutable except by another operator action. A later
   * customer stop request must not downgrade `operator` to `customer_opt_out`:
   * that provenance is what makes `/block` permanent, so overwriting it would let
   * the customer reopen a block by sending a stop phrase and then writing again.
   */
  revoke(phone: string, revokeSource: string): void {
    this.db.prepare(`
      UPDATE followup_subscriptions
      SET status = 'revoked',
          revoked_at = CASE
            WHEN revoke_source = 'operator' AND @source <> 'operator' THEN revoked_at
            ELSE datetime('now')
          END,
          revoke_source = CASE
            WHEN revoke_source = 'operator' AND @source <> 'operator' THEN revoke_source
            ELSE @source
          END,
          updated_at = datetime('now')
      WHERE customer_phone = @phone
    `).run({ source: revokeSource, phone });
  }

   reopenAfterCustomerInbound(phone: string): boolean {
     const result = this.db.prepare(`
       UPDATE followup_subscriptions
       SET status = 'unasked', asked_at = NULL, ask_outbound_message_id = NULL,
           decided_at = NULL, decision_inbound_message_id = NULL, consent_source = NULL,
           activated_at = NULL, revoked_at = NULL, revoke_source = NULL,
           deferred_reask_used = 0, consent_session = consent_session + 1,
           updated_at = datetime('now')
       WHERE customer_phone = ?
         AND status = 'revoked'
         AND revoke_source = 'customer_opt_out'
     `).run(phone);
     return result.changes > 0;
   }

}

export class SqliteFollowupSubscriptionEventRepo implements FollowupSubscriptionEventRepository {
  constructor(private db: Database.Database) {}

  listByStatus(status: FollowupSubscriptionEventStatus, limit: number): FollowupSubscriptionEventRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM followup_subscription_events
      WHERE status = ? AND scheduled_for <= datetime('now')
      ORDER BY scheduled_for ASC
      LIMIT ?
    `).all(status, limit) as FollowupSubscriptionEventRow[];
    return rows;
  }

  claim(
    phone: string,
    eventKind: FollowupSubscriptionEventKind,
    cycleKey: string,
    maxAttempts: number,
    staleClaimedMinutes: number
  ): number | null {
    const claimToken = `${phone}:${eventKind}:${cycleKey}:${Date.now()}:${Math.random()}`.slice(0, 100);

    const claimTx = this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT id, status, attempts,
               CASE WHEN datetime(dispatching_until) > datetime('now') THEN 1 ELSE 0 END AS dispatch_is_fresh,
               CAST((julianday('now') - julianday(claimed_at)) * 24 * 60 AS INTEGER) as claimed_minutes_ago
        FROM followup_subscription_events
        WHERE customer_phone = ? AND event_kind = ? AND cycle_key = ?
      `).get(phone, eventKind, cycleKey) as
        | { id: number; status: FollowupSubscriptionEventStatus; attempts: number; dispatch_is_fresh: number; claimed_minutes_ago: number | null }
        | undefined;

      if (!existing) {
        const info = this.db.prepare(`
          INSERT INTO followup_subscription_events
          (customer_phone, event_kind, cycle_key, scheduled_for, status, claim_token, claimed_at, updated_at, attempts)
          VALUES (?, ?, ?, datetime('now'), 'claimed', ?, datetime('now'), datetime('now'), 1)
        `).run(phone, eventKind, cycleKey, claimToken);
        return Number(info.lastInsertRowid);
      }

      // Check if already at max attempts
      if (existing.attempts >= maxAttempts) return null;

      // Meta may have accepted a request after we entered `dispatching`. A crash
      // before persisting the response makes delivery unknowable, so never retry:
      // convert the stale row to terminal `uncertain` instead.
      if (existing.status === 'dispatching') {
        if (existing.dispatch_is_fresh) return null;
        this.db.prepare(`
          UPDATE followup_subscription_events
          SET status = 'uncertain', failed_at = datetime('now'),
              error_reason = 'stale_dispatch_delivery_unknown', updated_at = datetime('now')
          WHERE id = ? AND status = 'dispatching'
        `).run(existing.id);
        return null;
      }

      // Check if already claimed (fresh or stale)
      if (existing.status === 'claimed') {
        // Stale? Reclaim it.
        if (existing.claimed_minutes_ago !== null && existing.claimed_minutes_ago >= staleClaimedMinutes) {
          this.db.prepare(`
            UPDATE followup_subscription_events
            SET claim_token = ?, claimed_at = datetime('now'), attempts = attempts + 1, updated_at = datetime('now')
            WHERE id = ? AND status = 'claimed'
          `).run(claimToken, existing.id);
          return existing.id;
        }
        return null; // Fresh claim, already held by another worker
      }

      // Accepted/delivered/uncertain/cancelled are terminal. A definite `failed`
      // response happened before Meta accepted the message and may retry below.
      if (existing.status === 'accepted' || existing.status === 'delivered' || existing.status === 'uncertain' || existing.status === 'cancelled') {
        return null;
      }

      // `due` or definite `failed`: claim another bounded attempt.
      this.db.prepare(`
        UPDATE followup_subscription_events
        SET status = 'claimed', claim_token = ?, claimed_at = datetime('now'),
            failed_at = NULL, error_reason = NULL,
            attempts = attempts + 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(claimToken, existing.id);
      return existing.id;
    });

    return claimTx();
  }

  startDispatching(eventId: number, dispatchingUntilIso: string): void {
    this.db.prepare(`
      UPDATE followup_subscription_events
      SET status = 'uncertain', dispatch_started_at = datetime('now'),
          dispatching_until = ?, failed_at = datetime('now'),
          error_reason = 'dispatch_started_delivery_unknown', updated_at = datetime('now')
      WHERE id = ?
    `).run(dispatchingUntilIso, eventId);
  }

  markAccepted(eventId: number, whatsappMessageId: string): void {
    this.db.prepare(`
      UPDATE followup_subscription_events
      SET status = 'accepted', accepted_at = datetime('now'), whatsapp_message_id = ?,
          failed_at = NULL, error_reason = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(whatsappMessageId, eventId);
  }

  markDelivered(eventId: number): void {
    this.db.prepare(`
      UPDATE followup_subscription_events
      SET status = 'delivered', delivered_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(eventId);
  }

  markFailed(eventId: number, reason: string): void {
    this.db.prepare(`
      UPDATE followup_subscription_events
      SET status = 'failed', failed_at = datetime('now'), error_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(reason.slice(0, 500), eventId);
  }

  markUncertain(eventId: number, reason: string): void {
    this.db.prepare(`
      UPDATE followup_subscription_events
      SET status = 'uncertain', failed_at = datetime('now'), error_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(reason.slice(0, 500), eventId);
  }

  releaseClaim(eventId: number): void {
    this.db.prepare(`
      UPDATE followup_subscription_events
      SET status = 'due', claim_token = NULL, claimed_at = NULL,
          dispatch_started_at = NULL, dispatching_until = NULL,
          attempts = MAX(0, attempts - 1), updated_at = datetime('now')
      WHERE id = ? AND status = 'claimed'
    `).run(eventId);
  }

  resetExhaustedCycle(
    phone: string,
    eventKind: FollowupSubscriptionEventKind,
    cycleKey: string,
  ): boolean {
    // `status = 'failed'` is the whole safety argument: that status is only ever
    // written before Meta accepted anything, so replaying the cycle cannot
    // duplicate a delivered message. Terminal `uncertain`/`accepted`/`delivered`
    // rows are deliberately not matched.
    const info = this.db.prepare(`
      UPDATE followup_subscription_events
      SET status = 'due', attempts = 0, claim_token = NULL, claimed_at = NULL,
          dispatch_started_at = NULL, dispatching_until = NULL,
          failed_at = NULL, error_reason = NULL,
          scheduled_for = datetime('now'), updated_at = datetime('now')
      WHERE customer_phone = ? AND event_kind = ? AND cycle_key = ? AND status = 'failed'
    `).run(phone, eventKind, cycleKey);
    return info.changes > 0;
  }

  getByPhoneKindCycle(phone: string, eventKind: FollowupSubscriptionEventKind, cycleKey: string): FollowupSubscriptionEventRow | null {
    const row = this.db.prepare(`
      SELECT * FROM followup_subscription_events
      WHERE customer_phone = ? AND event_kind = ? AND cycle_key = ?
    `).get(phone, eventKind, cycleKey) as FollowupSubscriptionEventRow | undefined;
    return row ?? null;
  }

  getLatest(phone: string): FollowupSubscriptionEventRow | null {
    const row = this.db.prepare(`
      SELECT * FROM followup_subscription_events
      WHERE customer_phone = ?
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(phone) as FollowupSubscriptionEventRow | undefined;
    return row ?? null;
  }

  listByPhone(phone: string, limit: number = 10): FollowupSubscriptionEventRow[] {
    return this.db.prepare(`
      SELECT * FROM followup_subscription_events
      WHERE customer_phone = ?
      ORDER BY id DESC LIMIT ?
    `).all(phone, limit) as FollowupSubscriptionEventRow[];
  }

  hasAskedSince(phone: string, sinceIso: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS found FROM followup_subscription_events
      WHERE customer_phone = ?
        AND event_kind = 'consent_ask'
        AND status IN ('accepted', 'delivered', 'uncertain')
        AND datetime(COALESCE(accepted_at, delivered_at, failed_at, updated_at)) > datetime(?)
      LIMIT 1
    `).get(phone, sinceIso) as { found: number } | undefined;
    return row !== undefined;
  }

  ensureExists(
    phone: string,
    eventKind: FollowupSubscriptionEventKind,
    cycleKey: string,
    scheduledForIso: string
  ): number {
    const existing = this.db.prepare(`
      SELECT id FROM followup_subscription_events
      WHERE customer_phone = ? AND event_kind = ? AND cycle_key = ?
    `).get(phone, eventKind, cycleKey) as { id: number } | undefined;

    if (existing) {
      // Update scheduled_for if due is still in future
      this.db.prepare(`
        UPDATE followup_subscription_events
        SET scheduled_for = ?, status = 'due', updated_at = datetime('now')
        WHERE id = ? AND status = 'due'
      `).run(scheduledForIso, existing.id);
      return existing.id;
    }

    const info = this.db.prepare(`
      INSERT INTO followup_subscription_events
      (customer_phone, event_kind, cycle_key, scheduled_for, status, updated_at, attempts)
      VALUES (?, ?, ?, ?, 'due', datetime('now'), 0)
    `).run(phone, eventKind, cycleKey, scheduledForIso);
    return Number(info.lastInsertRowid);
  }

  listReachedMetaBetween(
    eventKind: FollowupSubscriptionEventKind,
    sinceIso: string,
    untilIso: string
  ): FollowupSubscriptionEventRow[] {
    return this.db.prepare(`
      SELECT * FROM followup_subscription_events
      WHERE event_kind = @eventKind
        AND status IN ('accepted', 'delivered', 'uncertain')
        AND datetime(COALESCE(accepted_at, delivered_at, failed_at)) >= datetime(@sinceIso)
        AND datetime(COALESCE(accepted_at, delivered_at, failed_at)) < datetime(@untilIso)
      ORDER BY datetime(COALESCE(accepted_at, delivered_at, failed_at)) ASC
    `).all({ eventKind, sinceIso, untilIso }) as FollowupSubscriptionEventRow[];
  }
}
