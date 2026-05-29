export interface StoredMessage {
  id?: number;
  whatsapp_message_id?: string;
  customer_phone: string;
  direction: 'inbound' | 'outbound';
  message_type: 'text' | 'image';
  body?: string;
  created_at: string;
  raw_json?: string | null;
}

export interface RecentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DeepSeekResult {
  response: {
    reply: string | null;
    intent: string;
    lead_score_delta: number;
    should_send_image: boolean;
    needs_human: boolean;
    missing_fields: string[];
    collected_fields: Record<string, unknown>;
  };
  promptTokens: number;
  completionTokens: number;
}

export interface ConversationRepository {
  getByPhone(phone: string): ConversationRow | undefined;
  upsert(phone: string, data: Record<string, unknown>): void;
  getHandedOffAt(phone: string): string | null;
  setHandedOff(phone: string): void;
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
}

export interface MessageRepository {
  addMessage(msg: StoredMessage): void;
  getLastOutboundBody(phone: string): string | null;
  getRecentMessages(phone: string, limit?: number): RecentMessage[];
  getLastInboundBodies(phone: string, limit?: number): { body: string | null }[];
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
  get(key: string): DeepSeekResult | null;
  set(key: string, result: DeepSeekResult, ttlSeconds: number): void;
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
  ping(): boolean;
}
