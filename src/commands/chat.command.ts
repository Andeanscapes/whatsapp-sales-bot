import { getLineByTelegramChat } from '../services/lead-routing.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { formatLeadHistory } from './lead-format.js';
import type { CommandContext } from './index.js';

export async function chatHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0];
  if (!phone) return bridgeMessages.bridgeUsage;

  const chatId = String(ctx.chatId);
  const line = getLineByTelegramChat(chatId);
  if (line && line.type !== 'bridge') return bridgeMessages.bridgeOnlyForApiLine;

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);

  const assignment = ctx.repos.conversation.getAssignment(phone);
  if (!assignment) return bridgeMessages.leadNotAssigned;
  if (assignment.assignedAgentChat !== chatId) return bridgeMessages.leadAssignedToOther;

  ctx.repos.bridgeSession.open(chatId, phone);
  ctx.repos.conversation.setMode(phone, 'bridge_active');

  const history = formatLeadHistory(conv, ctx.repos.message.getRecentMessages(phone, 12));
  return `${bridgeMessages.chatActiveHeader(phone)}\n\n${history}`;
}
