import type { Repositories } from '../db/repositories/index.js';
import { getLineByTelegramChat, hasRoutingConfig } from './lead-routing.js';

/**
 * Resolves which sales line a Telegram chat is scoped to.
 * Returns null when routing is not configured (single-line mode = full access)
 * or when the chat is not mapped to a line.
 */
export function resolveCallerLineId(telegramChatId: number | string): string | null {
  if (!hasRoutingConfig()) return null;
  return getLineByTelegramChat(String(telegramChatId))?.id ?? null;
}

/**
 * Whether the caller may access a specific customer's conversation details.
 * Single-line mode: always true. Multi-line: only the owning line, or any line
 * while the lead is still unassigned (pre-handoff).
 */
export function canAccessConversation(repos: Repositories, telegramChatId: number | string, customerPhone: string): boolean {
  if (!hasRoutingConfig()) return true;
  const assignment = repos.conversation.getAssignment(customerPhone);
  if (!assignment) return true;
  return assignment.assignedAgentChat === String(telegramChatId);
}
