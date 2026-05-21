import type Database from 'better-sqlite3';

export interface MergedQualification {
  nombre?: unknown;
  personas?: unknown;
  fecha?: unknown;
  transporte?: unknown;
  mascota?: unknown;
}

export interface ProcessMessageInput {
  db: Database.Database;
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
