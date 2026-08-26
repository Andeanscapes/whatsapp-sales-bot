export interface StoredMessage {
  id?: number;
  whatsapp_message_id?: string;
  customer_phone: string;
  direction: 'inbound' | 'outbound';
  message_type: 'text' | 'image' | 'video' | 'audio' | 'template';
  body?: string;
  created_at: string;
  raw_json?: string | null;
  app_version?: string | null;
  media_id?: string;
}

export interface RecentMessage {
  role: 'user' | 'assistant';
  content: string;
  messageType?: string;
  /** ISO timestamp of the stored row. Needed to interleave media by time. */
  createdAt?: string;
  /** WhatsApp media id for an inbound photo/audio/video, so a replay can re-download it. */
  mediaId?: string;
}

export interface OutboundMediaRow {
  id?: number;
  customer_phone: string;
  media_url: string;
  media_id: string;
  caption?: string;
  carried_reply: number;
  flow: string;
  theme_site_id?: string;
  theme_type?: string;
  turn_inbound_message_id?: string;
  sequence?: number;
  sent_at: string;
}

export type DateStatus = 'unasked' | 'asked' | 'deferred' | 'options_offered' | 'selected' | 'window';

export interface ConversationRepository {
  getByPhone(phone: string): ConversationRow | undefined;
  /**
   * Leads eligible for the one-shot post-24h follow-up template. All gates that
   * can be expressed in SQL run here (consent, qualification, opt-out,
   * conversion, handoff, silence age, last message is ours) so the scheduler
   * does not N+1 scan every conversation.
   *
   * Qualification is `collected_plan` OR `collected_people` OR `price_given_at` —
   * a quoted lead often has neither collected column set. See
   * `QUALIFIED_FOR_FOLLOWUP_SQL` in `sqlite-repos.ts`.
   */
  listFollowupCandidates(input: { silentSinceIso: string; limit: number }): FollowupCandidateRow[];
  /**
   * Leads due the free-form consent ask. Every gate is SQL so the scheduler does
   * not N+1 scan: subscription is `unasked`, the customer has been silent since
   * `silentSinceIso`, their last inbound is still newer than `windowExpiryIso`
   * (so the free-form 24h window is definitely open), the last message in the
   * thread is OURS (i.e. they never replied), and the lead is qualified
   * (`QUALIFIED_FOR_FOLLOWUP_SQL`: plan, people count, or a delivered price).
   */
  listConsentAskCandidates(input: {
    silentSinceIso: string;
    windowExpiryIso: string;
    limit: number;
  }): ConsentAskCandidateRow[];
  /**
   * Broad recurring candidates past the shortest interval. Exact exponential
   * due filtering and the dispatch batch limit run together in the service so
   * non-due r2/r3 rows cannot consume the limited batch and starve due r1 rows.
   *
   * `dueBeforeIso` spaces sends from the previous send (cadence). `silentSinceIso`
   * is the independent dormancy floor measured from the customer's last inbound.
   * `scanLimit` bounds memory only; it must stay well above the per-tick send limit
   * so the exact due filter still has non-due rows to discard without starving.
   */
  listRecurringCandidates(input: {
    dueBeforeIso: string;
    silentSinceIso: string;
    maxSends: number;
    scanLimit: number;
  }): RecurringCandidateRow[];
  listMetaAudienceLeads(): MetaAudienceLead[];
  upsert(phone: string, data: Record<string, unknown>): void;
  getHandedOffAt(phone: string): string | null;
  setHandedOff(phone: string): void;
  clearHandoff(phone: string): void;
  getSoftClosedAt(phone: string): string | null;
  setSoftClosed(phone: string): void;
  clearSoftClosed(phone: string): void;
  getPriceGivenAt(phone: string): string | null;
  setPriceGiven(phone: string): void;
  getLeadScore(phone: string): number;
  updateLeadScore(phone: string, score: number): void;
  getCollectedFields(phone: string): Record<string, unknown>;
  clearCollectedDate(phone: string): void;
  clearCollectedChildAges(phone: string): void;
  getDateStatus(phone: string): DateStatus;
  setDateAsked(phone: string): void;
  setDateDeferred(phone: string): void;
  setDateOptionsOffered(phone: string): void;
  setSelectedDate(phone: string, date: string): void;
  getCollectedDateWindow(phone: string): string | null;
  setCollectedDateWindow(phone: string, window: string | null): void;
  getCollectedPlan(phone: string): string | null;
  resetExperienceSalesState(phone: string): void;
  clearCollectedTransport(phone: string): void;
  getLanguage(phone: string): 'es' | 'en' | null;
  getSalesPhase(phone: string): string | null;
  setSalesPhase(phone: string, phase: string): void;
  getLeadIntent(phone: string): string | null;
  setLeadIntent(phone: string, intent: string): void;
  getAssignment(phone: string): ConversationAssignment | null;
  setAssignment(phone: string, assignment: ConversationAssignment): void;
  getMode(phone: string): ConversationMode;
  setMode(phone: string, mode: ConversationMode): void;
  getSelectedExperienceId(phone: string): string | null;
  setSelectedExperienceId(phone: string, experienceId: string): void;
  clearSelectedExperienceId(phone: string): void;
  getBookedAt(phone: string): string | null;
  setBooked(phone: string): void;
  setLeadPain(phone: string, pain: LeadPain, detail?: string): void;
  getLeadPain(phone: string): LeadPain | null;
}

export interface MetaAudienceLead {
  customerPhone: string;
  collectedName: string | null;
}

export interface FollowupConsentRepository {
  hasConsent(phone: string): boolean;
  grantConsent(phone: string, grantedBy: string): void;
  revokeConsent(phone: string): void;
}

/**
 * Consent lifecycle for the recurring follow-up flow:
 *   unasked → pending (ask sent) → active (said yes) | declined (said no)
 *   any state → revoked (opt-out or operator command)
 *
 * Silence is NOT consent: a `pending` row that is never answered stays `pending`
 * and never receives a recurring send. One ambiguous sales continuation may defer
 * the ask once per session; the final unanswered ask remains pending. Keep `FOLLOWUP_CONSENT_ASK_ENABLED`,
 * `FOLLOWUP_RECURRING_ENABLED` and `ALLOW_FOLLOWUP_TEMPLATE` independent —
 * never alias them.
 */
export type FollowupSubscriptionStatus = 'unasked' | 'pending' | 'active' | 'declined' | 'revoked';

export interface FollowupSubscriptionRow {
  customer_phone: string;
  status: FollowupSubscriptionStatus;
  asked_at: string | null;
  ask_outbound_message_id: string | null;
  ask_attempts: number;
  consent_session: number;
  deferred_reask_used: number;
  decided_at: string | null;
  decision_inbound_message_id: string | null;
  consent_source: string | null;
  activated_at: string | null;
  revoked_at: string | null;
  revoke_source: string | null;
  updated_at: string | null;
}

export interface FollowupSubscriptionRepository {
  getByPhone(phone: string): FollowupSubscriptionRow | null;
  /**
   * Consent status per customer for a set of phones. Batched for the operator
   * digest, which reports the recorded decision for every consent ask it lists and
   * would otherwise issue one query per row.
   */
  listStatuses(phones: string[]): { customer_phone: string; status: FollowupSubscriptionStatus }[];
  /** Ensure row exists; initialize to 'unasked' if needed. */
  ensureExists(phone: string): void;
  /** Ask consent: transition to 'pending', record ask metadata. */
  /** `null` when the carrying outbound id is not known yet (pre-dispatch write). */
  markAsked(phone: string, outboundMessageId: string | null): void;
  /** Definite pre-acceptance failure: reopen eligibility for a bounded retry. */
  resetUnaskedIfPending(phone: string): void;
  /** Customer continued after c1: allow one deferred ask after the new silence. */
  deferPendingAskAfterCustomerInbound(phone: string): boolean;
  /** Accept consent: transition to 'active'. */
  affirm(phone: string, inboundMessageId: string, consentSource: string): void;
  /** Decline consent: transition to 'declined'. */
  decline(phone: string, inboundMessageId: string): void;
  /** Revoke consent: transition to 'revoked'. */
  revoke(phone: string, revokeSource: string): void;
  /**
   * Consent is session-scoped: a customer-initiated inbound closes an `active`
   * cycle back to `unasked`, so recurring templates stop until a fresh "sí" and a
   * new ask becomes eligible after this session goes silent. Returns true when a
   * cycle was actually closed. `pending`/`declined`/`revoked` are untouched.
   */
  closeCycleOnCustomerInbound(phone: string): boolean;
  /**
   * A customer who previously revoked may reopen a NEW consent opportunity by
   * initiating a later inbound. This never grants consent; it only returns to
   * `unasked`. Operator revocations are never reopened automatically.
   */
  reopenAfterCustomerInbound(phone: string): boolean;
}

/** A lead eligible for the one-shot post-24h template, resolved in one SQL pass. */
export interface FollowupCandidateRow {
  customer_phone: string;
  language: string | null;
  collected_plan: string | null;
  selected_experience_id: string | null;
  /** Last inbound timestamp — the silence anchor and the claim idempotency key. */
  anchor_at: string;
}

/** A lead eligible for the free-form consent ask, resolved in one SQL pass. */
export interface ConsentAskCandidateRow {
  customer_phone: string;
  language: string | null;
  /** Customer's last inbound — both the silence anchor and the 24h window origin. */
  anchor_at: string;
  /** Successfully sent/uncertain asks from previous customer-initiated sessions. */
  consent_asks_so_far: number;
  /** Current consent session number, incremented each time a new ask cycle opens. */
  consent_session: number;
}

/** A consented customer due for the next recurring template send. */
export interface RecurringCandidateRow {
  customer_phone: string;
  language: string | null;
  collected_plan: string | null;
  selected_experience_id: string | null;
  /** Count of recurring sends already delivered/uncertain — drives the next cycle index. */
  sends_so_far: number;
  /** Consent session sequence; recurring ids are scoped as cN-rN. */
  consent_cycle: number;
  /** When the last recurring send (or the consent activation) happened. */
  last_send_at: string;
}

/**
 * Per-stage dispatch ledger kinds. `cycle_key` is a session sequence (`'c1'`, `'c2'`…)
 * for consent asks and a consent-scoped send sequence (`'c1-r1'`, `'c2-r1'`…)
 * for recurring — never a calendar key, which would
 * silently cap sends at one per calendar month and make short dev intervals untestable.
 */
export type FollowupSubscriptionEventKind = 'consent_ask' | 'recurring';
export type FollowupSubscriptionEventStatus = 'due' | 'claimed' | 'dispatching' | 'accepted' | 'delivered' | 'failed' | 'uncertain' | 'cancelled';

export interface FollowupSubscriptionEventRow {
  id: number;
  customer_phone: string;
  event_kind: FollowupSubscriptionEventKind;
  cycle_key: string;
  scheduled_for: string;
  status: FollowupSubscriptionEventStatus;
  claim_token: string | null;
  claimed_at: string | null;
  dispatch_started_at: string | null;
  dispatching_until: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  error_reason: string | null;
  whatsapp_message_id: string | null;
  attempts: number;
  updated_at: string | null;
}

export interface FollowupSubscriptionEventRepository {
  /** List events in a given status, for claiming/processing. */
  listByStatus(status: FollowupSubscriptionEventStatus, limit: number): FollowupSubscriptionEventRow[];
  /**
   * Atomically claim an event: update status to 'claimed' and set claim_token.
   * Returns the event id, or null if already claimed/terminal.
   */
  claim(
    phone: string,
    eventKind: FollowupSubscriptionEventKind,
    cycleKey: string,
    maxAttempts: number,
    staleClaimedMinutes: number
  ): number | null;
  /**
   * Persist the no-retry boundary before entering Meta. It is conservatively
   * `uncertain` until a definite success/failure overwrites it.
   */
  startDispatching(eventId: number, dispatchingUntilIso: string): void;
  markAccepted(eventId: number, whatsappMessageId: string): void;
  markDelivered(eventId: number): void;
  markFailed(eventId: number, reason: string): void;
  markUncertain(eventId: number, reason: string): void;
  /** Release a claim without consuming an attempt (e.g., local guard blocked send). */
  releaseClaim(eventId: number): void;
  /**
   * Operator-only: clear the burned attempts of an EXHAUSTED cycle so `claim()`
   * can issue attempts again. Returns true when a row was actually reset.
   *
   * Restricted to `status = 'failed'` by design. `accepted`, `delivered` and
   * `uncertain` all mean Meta may have taken the message, so resetting them could
   * double-send; a `failed` row is only written before the send is attempted.
   */
  resetExhaustedCycle(
    phone: string,
    eventKind: FollowupSubscriptionEventKind,
    cycleKey: string,
  ): boolean;
  getByPhoneKindCycle(phone: string, eventKind: FollowupSubscriptionEventKind, cycleKey: string): FollowupSubscriptionEventRow | null;
  getLatest(phone: string): FollowupSubscriptionEventRow | null;
  /** Newest-first dispatch history for one customer. Operator diagnostics only. */
  listByPhone(phone: string, limit?: number): FollowupSubscriptionEventRow[];
  /**
   * True when a consent ask actually reached Meta after `sinceIso`.
   *
   * Scopes the post-opt-out ask tone to the FIRST ask after a stop request.
   * `last_opt_out_at` is never cleared (it is compliance evidence), so testing
   * it alone would soften every ask this customer ever receives again.
   */
  hasAskedSince(phone: string, sinceIso: string): boolean;
  /** Ensure the event row exists; update if due row already exists. */
  ensureExists(
    phone: string,
    eventKind: FollowupSubscriptionEventKind,
    cycleKey: string,
    scheduledForIso: string
  ): number;
  /**
   * Events of one kind that actually reached Meta inside a window, for the operator
   * digest. `listByStatus` cannot serve this: it filters `scheduled_for <= now` and
   * takes a single status, so it can neither bound a past window nor span the three
   * statuses that mean "shipped".
   *
   * The terminal instant is `COALESCE(accepted_at, delivered_at, failed_at)`, matching
   * the `terminal_recurring` CTE in `listRecurringCandidates` — `uncertain` records
   * only `failed_at` even though Meta may have accepted it.
   */
  listReachedMetaBetween(
    eventKind: FollowupSubscriptionEventKind,
    sinceIso: string,
    untilIso: string
  ): FollowupSubscriptionEventRow[];
}

/** LIVE: one-shot post-24h template event row. */
export interface FollowupEventRow {
  id: number;
  customer_phone: string;
  anchor_at: string;
  claimed_at: string;
  attempts: number;
  sent_at: string | null;
  whatsapp_message_id: string | null;
  failed_at: string | null;
  error_reason: string | null;
  status: 'pending' | 'sent' | 'failed' | 'uncertain';
}

/**
 * LIVE: the one-shot post-24h template flow (`followup_events`). This is the only
 * follow-up path that actually sends today. Distinct from
 * `FollowupSubscriptionEventRepository`, which powers the consent-gated recurring
 * flow. Do not merge them; they have separate tables, columns and semantics.
 */
export interface FollowupEventRepository {
  /**
   * Atomically reserves the send for (phone, anchor). Returns the claim id, or
   * `null` when the lead already has a terminal row (sent/uncertain, or failed
   * `maxAttempts` times) or a fresh pending claim is held by another worker.
   * `stalePendingMinutes` allows reclaim after a crash left status='pending'.
   */
  claim(phone: string, anchorAt: string, maxAttempts: number, stalePendingMinutes: number): number | null;
  /**
   * Terminal pre-send boundary: once dispatch starts, a process crash makes Meta
   * acceptance unknowable, so the row is `uncertain` and must never auto-retry.
   * A definite HTTP rejection may still transition it to `failed`.
   */
  markDispatching(claimId: number): void;
  markSent(claimId: number, whatsappMessageId: string): void;
  markFailed(claimId: number, reason: string): void;
  /** Terminal: Meta may have accepted the message — never auto-retry. */
  markUncertain(claimId: number, reason: string): void;
  /** Drops a claim that never reached Meta, so a local guard does not consume a retry. */
  releaseClaim(claimId: number): void;
  getLatest(phone: string): FollowupEventRow | null;
  /**
   * One-shot rows that actually reached Meta inside a window, for the operator digest.
   *
   * The terminal instant is `COALESCE(sent_at, failed_at)`: `uncertain` leaves
   * `sent_at` NULL and records the dispatch moment in `failed_at`, so filtering on
   * `sent_at` alone would silently drop every send Meta may have accepted.
   */
  listReachedMetaBetween(sinceIso: string, untilIso: string): FollowupEventRow[];
}


export interface MessageRepository {
  addMessage(msg: StoredMessage): void;
  getLastOutboundBody(phone: string): string | null;
  getLastOutboundTextBody(phone: string): string | null;
  getRecentMessages(phone: string, limit?: number): RecentMessage[];
  getLastInboundBodies(phone: string, limit?: number): { body: string | null }[];
  getLastInboundBody(phone: string): string | null;
  getLastInboundAt(phone: string): string | null;
  getLastMessageDirection(phone: string): 'inbound' | 'outbound' | null;
  countOutboundSince(phone: string, sinceIso: string, messageType?: 'text' | 'image'): number;
  /**
   * Inbound timestamps at or after `sinceIso` for a set of customers, oldest first
   * per phone.
   *
   * Batched on purpose: the operator digest needs, for each follow-up it sent,
   * whether a reply landed before the NEXT send to that same customer. Per-row
   * `getLastInboundAt` calls were both N+1 and unable to answer that — the latest
   * inbound marks every send of the day as answered, inflating the reply count.
   */
  listInboundSince(phones: string[], sinceIso: string): { customer_phone: string; created_at: string }[];
}

export interface OutboundMediaRepository {
  record(row: OutboundMediaRow): void;
  listByPhone(phone: string, limit?: number): OutboundMediaRow[];
}

export interface DedupeRepository {
  isProcessed(messageId: string): boolean;
  markProcessed(messageId: string): void;
}

export interface OptOutRepository {
  isOptedOut(phone: string): boolean;
  setOptOut(phone: string): void;
  /**
   * Clears the ACTIVE suppression flag only (customer-initiated return).
   * The `last_opt_out_at` compliance record is never cleared.
   */
  clearOptOut(phone: string): void;
  /** Timestamp of the last stop request, surviving any later reopening. */
  getLastOptOutAt(phone: string): string | null;
}

export interface AiCacheRepository {
  get(key: string): unknown | null;
  set(key: string, value: unknown, ttlSeconds: number): void;
}

export type AiUsagePurpose = 'reply' | 'lead_analysis' | 'follow_up';

export interface AiUsageRecordInput {
  phone: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  estimatedCost: number;
  purpose: AiUsagePurpose;
  success: boolean;
  errorType?: string | null;
}

export interface TokenBreakdown {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

export interface AiUsageBreakdown {
  reply: TokenBreakdown;
  lead_analysis: TokenBreakdown;
  follow_up: TokenBreakdown;
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
}

export interface AiUsageRepository {
  getDailyCost(todayStart: string): number;
  getMonthlyCost(monthStart: string): number;
  countCustomerDaily(phone: string, todayStart: string): number;
  countGlobalDaily(todayStart: string): number;
  recordUsage(input: AiUsageRecordInput): void;
  getUsageByPurpose(phone: string, sinceIso: string, untilIso: string | null): AiUsageBreakdown;
  getGlobalUsageByPurpose(sinceIso: string, untilIso: string | null): AiUsageBreakdown;
}

export interface OwnerAlertRepository {
  wasAlertedToday(phone: string, alertType: string): boolean;
  wasAlertedSince(phone: string, alertType: string, sinceIso: string): boolean;
  insert(phone: string, channel: string, score: number, alertType: string, body: string): void;
}

export interface MediaSendRepository {
  countRecentImages(phone: string, cutoffIso: string): number;
  /** Counts only sends whose media id starts with `prefix` (e.g. gallery vs plan images). */
  countRecentImagesWithPrefix(phone: string, cutoffIso: string, prefix: string): number;
  hasRecentSameImage(phone: string, imageId: string, cutoffIso: string): boolean;
  /**
   * Last send of one logical image. Without `scopedPrefix` this is an exact
   * `media_id` match; with it, ids namespaced as `<scopedPrefix><scope>_<imageId>`
   * count as the same photo. Exact substr comparison, never LIKE: `_` is a LIKE
   * wildcard and both the prefix and the image id are full of them.
   */
  getLastSentAtForImage(phone: string, imageId: string, scopedPrefix?: string): string | null;
  claimSend(phone: string, mediaId: string, cutoffIso: string): number | null;
  releaseClaim(id: number): void;
  recordSend(phone: string, mediaId: string): void;
}

export type PaymentReservationStatus = 'pending' | 'approved' | 'failed';

export interface PaymentReservationCreate {
  externalReference: string;
  customerPhone: string;
  expectedAmountCop: number;
  planId: string;
  date: string;
  people: number;
  transportNeed: string | null;
  depositPercent: number;
  availabilityConfirmedAt: string;
}

export interface PaymentReservation {
  id: number;
  externalReference: string;
  customerPhone: string;
  preferenceId: string | null;
  paymentUrl: string | null;
  expectedAmountCop: number;
  planId: string | null;
  date: string | null;
  people: number | null;
  transportNeed: string | null;
  depositPercent: number | null;
  availabilityConfirmedAt: string | null;
  status: PaymentReservationStatus;
  createdAt: string;
  approvedAt: string | null;
  mercadoPagoPaymentId: string | null;
}

export interface PaymentReservationRepository {
  createPending(reservation: PaymentReservationCreate): boolean;
  attachPreference(externalReference: string, preferenceId: string, paymentUrl: string): void;
  getByExternalReference(externalReference: string): PaymentReservation | null;
  getPendingByCustomerPhone(customerPhone: string): PaymentReservation | null;
  markApproved(externalReference: string, mercadoPagoPaymentId: string): boolean;
  markFailed(externalReference: string): void;
}

export type ConversationMode = 'bot' | 'bridge_active' | 'referred' | 'human_pending' | 'human_only';

export type LeadPain = 'price' | 'date_time' | 'security' | 'logistics_4x4' | 'experience_clarity' | 'partner_group' | 'not_interested' | 'other';

export interface ConversationAssignment {
  assignedLineId: string;
  assignedAgentChat: string;
}

export interface BridgeSessionRow {
  agentChatId: string;
  customerPhone: string;
  openedAt: string;
  lastActivityAt: string;
  returnMode: 'bot' | 'human_only';
}

export interface BridgeSessionRepository {
  open(agentChatId: string, customerPhone: string, returnMode?: 'bot' | 'human_only'): void;
  close(agentChatId: string): void;
  getByAgentChat(agentChatId: string): BridgeSessionRow | null;
  getByCustomer(customerPhone: string): BridgeSessionRow | null;
  touch(agentChatId: string): void;
}

export interface ConversationRow {
  id: number;
  customer_phone: string;
  language: 'es' | 'en' | null;
  first_seen_at: string;
  last_seen_at: string;
  lead_score: number;
  hot_alert_sent_at: string | null;
  urgent_alert_sent_at: string | null;
  opt_out_at: string | null;
  free_entry_detected: number;
  ad_referral_json: string | null;
  entry_marker: string | null;
  entry_temperature: 'cold' | 'funnel' | 'retargeting' | null;
  entry_marker_at: string | null;
  collected_name: string | null;
  collected_date: string | null;
  collected_date_canon_year: number | null;
  collected_date_canon_month: number | null;
  collected_date_canon_day: number | null;
  collected_date_window: string | null;
  date_status: DateStatus | null;
  collected_people: number | null;
  collected_transport_need: string | null;
  collected_lodging_need: string | null;
  collected_pet: string | null;
  collected_plan: string | null;
  collected_adults: number | null;
  collected_children: number | null;
  collected_child_ages_json: string | null;
  collected_travel_origin: string | null;
  price_given_at: string | null;
  handed_off_at: string | null;
  soft_closed_at: string | null;
  gallery_nudged_at: string | null;
  lead_pain: LeadPain | null;
  lead_pain_detail: string | null;
  lead_pain_detected_at: string | null;
  converted_at: string | null;
  sales_phase: string | null;
  lead_intent: string | null;
  assigned_line_id: string | null;
  assigned_agent_chat: string | null;
  conversation_mode: ConversationMode | null;
  selected_experience_id: string | null;
}

export interface DailyStats {
  label: string;
  totalConversations: number;
  newConversations: number;
  activeConversations: number;
  messagesInbound: number;
  messagesOutbound: number;
  hotLeads: number;
  hotLeadPercentage: number;
  optedOut: number;
  handedOff: number;
  softClosed: number;
  bookedToday: number;
  aiSpentUsd: number;
  aiCalls: number;
  aiPromptTokens: number;
  aiCompletionTokens: number;
  aiReplyCost: number;
  aiAnalysisCost: number;
  aiFollowUpCost: number;
}

export interface ConversationSummary {
  customerPhone: string;
  name: string | null;
  score: number;
  phase: string | null;
  plan: string | null;
  people: number | null;
  date: string | null;
  transportNeed: string | null;
  adults: number | null;
  children: number | null;
  childAges: number[] | null;
  travelOrigin: string | null;
  entryMarker: string | null;
  entryTemperature: 'cold' | 'funnel' | 'retargeting' | null;
  lastSeenAt: string;
}

export interface PhaseBreakdown {
  phase: string;
  count: number;
}

export interface LineLeadCount {
  lineId: string;
  total: number;
  hot: number;
  booked: number;
}

export interface StatsRepository {
  getDailyStats(todayStart: string, hotLeadThreshold: number, excludedPhones?: string[]): DailyStats;
  getPeriodStats(label: string, sinceIso: string, untilIso: string | null, hotLeadThreshold: number, excludedPhones?: string[]): DailyStats;
  getRecentConversations(limit: number, lineId?: string | null): ConversationSummary[];
  getRecentInboundAfterFirstReply(limit: number, lineId?: string | null, excludedPhones?: string[]): ConversationSummary[];
  getTopLeads(limit: number, threshold: number, lineId?: string | null, excludedPhones?: string[]): ConversationSummary[];
  getPhaseBreakdown(): PhaseBreakdown[];
  getLeadCountsByLine(hotLeadThreshold: number, excludedPhones?: string[]): LineLeadCount[];
  getLeadCountsByLineForPeriod(sinceIso: string, untilIso: string | null, hotLeadThreshold: number, excludedPhones?: string[]): LineLeadCount[];
}

export interface SystemErrorRow {
  id: number;
  error_type: string;
  severity: string;
  message: string;
  stack: string | null;
  context_json: string | null;
  created_at: string;
}

export interface SystemErrorRepository {
  insert(type: string, severity: string, message: string, stack?: string, context?: Record<string, unknown>): void;
  pruneOlderThan(days: number): number;
}

export interface CustomerDataRepository {
  deleteCustomer(phone: string): {
    conversations: number;
    messages: number;
    processedMessages: number;
    aiUsage: number;
    ownerAlerts: number;
    mediaSends: number;
    bridgeSessions: number;
    followupConsent: number;
    followupEvents: number;
    followupSubscriptions: number;
    followupSubscriptionEvents: number;
  };
}

export interface TranscriptTurn {
  at: string;
  role: 'customer' | 'bot';
  type: string;
  text: string;
  appVersion?: string | null;
}

export interface TranscriptRecord {
  customerPhone: string;
  language: 'es' | 'en' | null;
  firstSeenAt: string;
  lastSeenAt: string;
  leadScore: number;
  mode: ConversationMode | null;
  entryMarker: string | null;
  entryTemperature: 'cold' | 'funnel' | 'retargeting' | null;
  entryMarkerAt: string | null;
  adReferral: string | null;
  handedOff: boolean;
  converted: boolean;
  collected: {
    name: string | null;
    date: string | null;
    people: number | null;
    transportNeed: string | null;
    lodgingNeed: string | null;
    pet: string | null;
    plan: string | null;
    adults: number | null;
    children: number | null;
    childAges: number[] | null;
    travelOrigin: string | null;
  };
  aiUsage: { promptTokens: number; completionTokens: number; estimatedCostUsd: number } | null;
  turns: TranscriptTurn[];
}

export interface DayMessage {
  at: string;
  direction: 'inbound' | 'outbound';
  type: string;
  text: string;
  appVersion?: string | null;
}

export interface DayConversationSummary {
  customerPhone: string;
  name: string | null;
  score: number;
  phase: string | null;
  plan: string | null;
  intent: string | null;
  language: 'es' | 'en' | null;
  people: number | null;
  date: string | null;
  transportNeed: string | null;
  adults: number | null;
  children: number | null;
  childAges: number[] | null;
  travelOrigin: string | null;
  entryMarker: string | null;
  entryTemperature: 'cold' | 'funnel' | 'retargeting' | null;
  entryMarkerAt: string | null;
  adReferralJson: string | null;
  firstSeenAt: string;
  lastActivityAt: string;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
  aiCostUsd: number;
  aiPromptTokens: number;
  aiCompletionTokens: number;
  aiCalls: number;
  aiUsageBreakdown: AiUsageBreakdown;
  followUps: [];
  messages: DayMessage[];
}

export interface PeriodActivityTotals {
  label: string;
  generatedAt: string;
  totalConversations: number;
  totalMessages: number;
  totalInbound: number;
  totalOutbound: number;
  totalAiCostUsd: number;
  followUpsSent: number;
  followUpsReplied: number;
  followUpHandoffs: number;
  followUpBookings: number;
}

export interface DayActivityResult {
  totals: PeriodActivityTotals;
  conversations: DayConversationSummary[];
}

export interface TranscriptRepository {
  getAllTranscripts(): TranscriptRecord[];
  getDayActivity(sinceIso: string, untilIso: string | null, excludedPhones?: string[]): DayActivityResult;
}

export interface Repositories {
  followupConsent: FollowupConsentRepository;
  followupSubscription: FollowupSubscriptionRepository;
  followupEvent: FollowupEventRepository; // LIVE: one-shot post-24h template
  followupSubscriptionEvent: FollowupSubscriptionEventRepository;
  conversation: ConversationRepository;
  message: MessageRepository;
  outboundMedia: OutboundMediaRepository;
  dedupe: DedupeRepository;
  optOut: OptOutRepository;
  aiCache: AiCacheRepository;
  aiUsage: AiUsageRepository;
  ownerAlert: OwnerAlertRepository;
  mediaSend: MediaSendRepository;
  paymentReservation: PaymentReservationRepository;
  bridgeSession: BridgeSessionRepository;
  stats: StatsRepository;
  systemErrors: SystemErrorRepository;
  customerData: CustomerDataRepository;
  transcripts: TranscriptRepository;
  runInTransaction(operation: () => void): void;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  /**
   * Claims a once-per-period operator job, returning true only for the caller that
   * won. Persisted in `bot_config`, so a restart cannot re-run a period already
   * delivered — an in-process flag alone would re-send on every boot, and a crash
   * loop at the trigger hour would spam the operator.
   *
   * The claim is taken BEFORE the send: losing one period's informational digest to
   * a transport failure is cheaper than repeating it on every retry.
   */
  claimPeriodicJob(jobKey: string, periodKey: string): boolean;
  ping(): boolean;
}
