import { getLineByTelegramChat, isOwnerChat } from '../services/lead-routing.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { formatLeadHistory } from './lead-format.js';
import type { CommandContext } from './index.js';

export async function chatHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0]?.replace(/\D/g, '');
  if (!phone) return bridgeMessages.bridgeUsage;

  const chatId = String(ctx.chatId);
  const isOwner = isOwnerChat(chatId);
  const line = getLineByTelegramChat(chatId);
  if (!isOwner && line && line.type !== 'bridge') return bridgeMessages.bridgeOnlyForApiLine;

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);

  const assignment = ctx.repos.conversation.getAssignment(phone);
  if (!isOwner) {
    if (!assignment) return bridgeMessages.leadNotAssigned;
    if (assignment.assignedAgentChat !== chatId) return bridgeMessages.leadAssignedToOther;
  }

  const targetSession = ctx.repos.bridgeSession.getByCustomer(phone);
  if (!isOwner && targetSession && targetSession.agentChatId !== chatId) {
    return bridgeMessages.leadAssignedToOther;
  }

  // One Telegram chat can bridge one customer. Close its previous bridge first
  // so returning to the bot and owner takeover never leave mixed live sessions.
  const currentSession = ctx.repos.bridgeSession.getByAgentChat(chatId);
  if (currentSession && currentSession.customerPhone !== phone) {
    ctx.repos.bridgeSession.close(chatId);
    ctx.repos.conversation.setMode(currentSession.customerPhone, 'bot');
  }

  // Owner takeover replaces an agent's active bridge for this customer. The
  // target mode is set below only after its previous bridge session is closed.
  if (targetSession && targetSession.agentChatId !== chatId) {
    ctx.repos.bridgeSession.close(targetSession.agentChatId);
  }

  ctx.repos.bridgeSession.open(chatId, phone);
  ctx.repos.conversation.setMode(phone, 'bridge_active');

  const history = formatLeadHistory(conv, ctx.repos.message.getRecentMessages(phone, 500));
  return `${bridgeMessages.chatActiveHeader(phone)}\n\n${history}`;
}
