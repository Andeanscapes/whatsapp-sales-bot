import type { Repositories } from '../db/repositories/index.js';

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
}

export interface ProcessMessageOutput {
  reply: string;
  shouldSendReply: boolean;
  leadScore: number;
  usedAi: boolean;
  shouldAlertOwner: boolean;
  ownerAlertType?: string;
  shouldSendImage: boolean;
  priceJustGiven: boolean;
  priceFollowUpText?: string;
}
