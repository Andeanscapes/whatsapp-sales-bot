import { logger } from '../config/logger.js';
import { broadcastToAllLines } from '../services/broadcast.js';
import { getLineByTelegramChat, isReferralLine } from '../services/lead-routing.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import type { CommandContext } from './index.js';

export async function bookingHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0];
  if (!phone) return bridgeMessages.bookingUsage;

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);

  const assignment = ctx.repos.conversation.getAssignment(phone);
  if (!assignment) return bridgeMessages.leadNotAssigned;
  if (assignment.assignedAgentChat !== String(ctx.chatId)) return bridgeMessages.leadAssignedToOther;

  const existing = ctx.repos.conversation.getBookedAt(phone);
  if (existing) return bridgeMessages.alreadyBooked(existing.slice(0, 10));

  ctx.repos.conversation.setBooked(phone);

  const line = getLineByTelegramChat(String(ctx.chatId));
  const who = line ? `${line.agentName}${isReferralLine(line) ? ` (${line.displayNumber})` : ''}` : 'Telegram';
  logger.info({ chatId: ctx.chatId, phone, who }, '[TELEGRAM_BOT] booking confirmed via /booking command');

  void broadcastToAllLines(bridgeMessages.bookingBroadcast({ who, phone, name: conv.collected_name }));

  return bridgeMessages.bookingConfirmed(conv.collected_name ?? phone);
}
