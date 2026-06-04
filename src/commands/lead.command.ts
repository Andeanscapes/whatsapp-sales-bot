import { bridgeMessages } from '../services/bridge-messages.js';
import { canAccessConversation } from '../services/access-control.js';
import { formatLeadHistory } from './lead-format.js';
import type { CommandContext } from './index.js';

export async function leadHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0];
  if (!phone) return bridgeMessages.leadUsage;

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);

  if (!canAccessConversation(ctx.repos, ctx.chatId, phone)) return bridgeMessages.leadAssignedToOther;

  return formatLeadHistory(conv, ctx.repos.message.getRecentMessages(phone, 12));
}
