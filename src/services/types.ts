import type { ConversationMode, DateStatus, Repositories } from '../db/repositories/index.js';

export type OutboundDateAction = 'asked' | 'options_offered';
export type LeadLifecycle = 'quoted' | 'human_pending' | 'payment_pending' | 'decision_pending' | 'lost_price';

export interface MergedQualification {
  nombre?: unknown;
  plan?: unknown;
  personas?: unknown;
  fecha?: unknown;
  dateStatus?: DateStatus;
  transporte?: unknown;
  mascota?: unknown;
}

export interface ProcessMessageInput {
  repos: Repositories;
  customerPhone: string;
  message: string;
  messageId?: string;
  storeInbound?: boolean;
  /**
   * Set when this inbound was classified as accepting the follow-up permission.
   * Passed through to the prompt so the model acknowledges the permission and does
   * not read a bare "si" as a booking confirmation.
   */
  consentAcceptedThisTurn?: boolean;
  /**
   * Set when this inbound declined the follow-up permission. Like the accepted
   * case it is not a sales signal, so it must not move the lead score.
   */
  consentDeclinedThisTurn?: boolean;
  /** This inbound reopened a consent opportunity after a customer opt-out. */
  followupReopenedThisTurn?: boolean;
}

export interface ProcessMessageOutput {
  reply: string;
  shouldSendReply: boolean;
  leadScore: number;
  usedAi: boolean;
  shouldAlertOwner: boolean;
  ownerAlertType?: string;
  shouldSendImage: boolean;
  shouldSendOwnerImage: boolean;
  /**
   * True when this turn ships gallery photos (see `requestedGalleryImages`).
   * The webhook does not read it: it is the signal the conversation-eval
   * `output_count_at_most` rule counts, so image floods stay measurable.
   */
  shouldSendGalleryImages: boolean;
  /**
   * One gallery image matching the theme of this reply, selected post-LLM from
   * the reply text. Delivered as a single message with `reply` as its caption,
   * so the closing question always renders under the photo. Separate messages
   * cannot guarantee that: WhatsApp fetches `image.link` before delivering, so
   * a text sent afterwards overtakes the image.
   */
  contextualImage?: { url: string };
  /**
   * Gallery photos the customer explicitly asked for, by category. The webhook
   * captions the last successfully claimed photo with the unchanged LLM reply;
   * earlier photos are captionless. URLs only — feed captions are not sales copy.
   */
  requestedGalleryImages?: string[];
  priceJustGiven: boolean;
  conversationMode?: ConversationMode;
  salesPhase?: string | null;
  softClosed?: boolean;
  reservationReady?: boolean;
  intent?: string | null;
  mediaPlanId?: string | null;
  outboundDateAction?: OutboundDateAction;
  bookingIntent?: boolean;
  handoffCreated?: boolean;
  leadLifecycle?: LeadLifecycle;
  suppressGenericFollowups?: boolean;
}
