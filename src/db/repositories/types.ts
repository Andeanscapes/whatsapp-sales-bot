export interface StoredMessage {
  id?: number;
  whatsapp_message_id?: string;
  customer_phone: string;
  direction: 'inbound' | 'outbound';
  message_type: 'text' | 'image' | 'video' | 'audio';
  body?: string;
  created_at: string;
  raw_json?: string | null;
}

export interface RecentMessage {
  role: 'user' | 'assistant';
  content: string;
  messageType?: string;
}

export interface ConversationRepository {
  getByPhone(phone: string): ConversationRow | undefined;
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
  getCollectedPlan(phone: string): string | null;
  getLanguage(phone: string): 'es' | 'en' | null;
  getSalesPhase(phone: string): string | null;
  setSalesPhase(phone: string, phase: string): void;
  getLeadIntent(phone: string): string | null;
  setLeadIntent(phone: string, intent: string): void;
  getAssignment(phone: string): ConversationAssignment | null;
  setAssignment(phone: string, assignment: ConversationAssignment): void;
  getMode(phone: string): ConversationMode;
  setMode(phone: string, mode: ConversationMode): void;
  getBookedAt(phone: string): string | null;
  setBooked(phone: string): void;
  getFollowUpCandidates(cutoffIso: string, serviceWindowStartIso: string, limit: number): FollowUpCandidate[];
  getPainQuestionCandidates(serviceWindowStartIso: string, limit: number): FollowUpCandidate[];
  markFollowUpSent(phone: string): void;
  setLeadPain(phone: string, pain: LeadPain, detail?: string): void;
  getLeadPain(phone: string): LeadPain | null;
  incrementFollowUpReplyCount(phone: string): void;
}

export interface MessageRepository {
  addMessage(msg: StoredMessage): void;
  getLastOutboundBody(phone: string): string | null;
  getRecentMessages(phone: string, limit?: number): RecentMessage[];
  getLastInboundBodies(phone: string, limit?: number): { body: string | null }[];
  getLastInboundBody(phone: string): string | null;
  getLastInboundAt(phone: string): string | null;
  getLastMessageDirection(phone: string): 'inbound' | 'outbound' | null;
  countOutboundSince(phone: string, sinceIso: string): number;
}

export interface DedupeRepository {
  isProcessed(messageId: string): boolean;
  markProcessed(messageId: string): void;
}

export interface OptOutRepository {
  isOptedOut(phone: string): boolean;
  setOptOut(phone: string): void;
}

export interface AiCacheRepository {
  get(key: string): unknown | null;
  set(key: string, value: unknown, ttlSeconds: number): void;
}

export interface AiUsageRepository {
  getDailyCost(todayStart: string): number;
  getMonthlyCost(monthStart: string): number;
  countCustomerDaily(phone: string, todayStart: string): number;
  countGlobalDaily(todayStart: string): number;
  recordUsage(phone: string, model: string, promptTokens: number, completionTokens: number, cachedTokens: number, estimatedCost: number): void;
}

export interface OwnerAlertRepository {
  wasAlertedToday(phone: string, alertType: string): boolean;
  insert(phone: string, channel: string, score: number, alertType: string, body: string): void;
}

export interface MediaSendRepository {
  countRecentImages(phone: string, cutoffIso: string): number;
  hasRecentSameImage(phone: string, imageId: string, cutoffIso: string): boolean;
  recordSend(phone: string, mediaId: string): void;
}

export type ConversationMode = 'bot' | 'bridge_active' | 'referred';

export type LeadPain = 'price' | 'date_time' | 'security' | 'logistics_4x4' | 'experience_clarity' | 'partner_group' | 'not_interested' | 'other';

export type FollowUpStage = 'first_nudge' | 'pain_question';
export type FollowUpStatus = 'sent' | 'replied';

export interface FollowUpEvent {
  id?: number;
  customerPhone: string;
  sequenceNumber: number;
  stage: FollowUpStage;
  sentAt: string | null;
  repliedAt: string | null;
  scoreBefore: number;
  scoreAfter: number | null;
  detectedPain: LeadPain | null;
  status: FollowUpStatus;
}

export interface FollowUpEventRepository {
  insert(event: Omit<FollowUpEvent, 'id'>): void;
  getLatestByPhone(phone: string): FollowUpEvent | null;
  markReplied(phone: string, sequenceNumber: number, scoreAfter: number, detectedPain: LeadPain | null): void;
  countByPhone(phone: string): number;
}

export interface ConversationAssignment {
  assignedLineId: string;
  assignedAgentChat: string;
}

export interface BridgeSessionRow {
  agentChatId: string;
  customerPhone: string;
  openedAt: string;
  lastActivityAt: string;
}

export interface BridgeSessionRepository {
  open(agentChatId: string, customerPhone: string): void;
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
  collected_name: string | null;
  collected_date: string | null;
  collected_people: number | null;
  collected_transport_need: string | null;
  collected_lodging_need: string | null;
  collected_pet: string | null;
  collected_plan: string | null;
  price_given_at: string | null;
  handed_off_at: string | null;
  soft_closed_at: string | null;
  gallery_nudged_at: string | null;
  follow_up_sent_at: string | null;
  lead_pain: LeadPain | null;
  lead_pain_detail: string | null;
  lead_pain_detected_at: string | null;
  follow_up_reply_count: number;
  converted_at: string | null;
  sales_phase: string | null;
  lead_intent: string | null;
  assigned_line_id: string | null;
  assigned_agent_chat: string | null;
  conversation_mode: ConversationMode | null;
}

export interface FollowUpCandidate {
  customerPhone: string;
  language: 'es' | 'en' | null;
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
}

export interface ConversationSummary {
  customerPhone: string;
  name: string | null;
  score: number;
  phase: string | null;
  plan: string | null;
  people: number | null;
  date: string | null;
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
  getTopLeads(limit: number, threshold: number, lineId?: string | null): ConversationSummary[];
  getPhaseBreakdown(): PhaseBreakdown[];
  getLeadCountsByLine(hotLeadThreshold: number): LineLeadCount[];
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
    followUpEvents: number;
  };
}

export interface TranscriptTurn {
  at: string;
  role: 'customer' | 'bot';
  type: string;
  text: string;
}

export interface TranscriptRecord {
  customerPhone: string;
  language: 'es' | 'en' | null;
  firstSeenAt: string;
  lastSeenAt: string;
  leadScore: number;
  mode: ConversationMode | null;
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
  };
  aiUsage: { promptTokens: number; completionTokens: number; estimatedCostUsd: number } | null;
  turns: TranscriptTurn[];
}

export interface DayMessage {
  at: string;
  direction: 'inbound' | 'outbound';
  type: string;
  text: string;
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
  firstSeenAt: string;
  lastActivityAt: string;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
  aiCostUsd: number;
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
  conversation: ConversationRepository;
  message: MessageRepository;
  dedupe: DedupeRepository;
  optOut: OptOutRepository;
  aiCache: AiCacheRepository;
  aiUsage: AiUsageRepository;
  ownerAlert: OwnerAlertRepository;
  mediaSend: MediaSendRepository;
  bridgeSession: BridgeSessionRepository;
  stats: StatsRepository;
  systemErrors: SystemErrorRepository;
  customerData: CustomerDataRepository;
  transcripts: TranscriptRepository;
  followUpEvent: FollowUpEventRepository;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  ping(): boolean;
}
