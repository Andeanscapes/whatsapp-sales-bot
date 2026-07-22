import type { ConversationMode, Repositories } from '../db/repositories/index.js';

export interface MergedQualification {
  nombre?: unknown;
  plan?: unknown;
  personas?: unknown;
  fecha?: unknown;
  transporte?: unknown;
  mascota?: unknown;
}

export interface ProcessMessageInput {
  repos: Repositories;
  customerPhone: string;
  message: string;
  messageId?: string;
  storeInbound?: boolean;
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
  shouldSendGalleryImages: boolean;
  priceJustGiven: boolean;
  priceFollowUpText?: string;
  conversationMode?: ConversationMode;
  salesPhase?: string | null;
  softClosed?: boolean;
}
