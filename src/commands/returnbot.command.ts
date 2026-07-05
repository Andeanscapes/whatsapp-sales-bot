import { bridgeMessages } from '../services/bridge-messages.js';
import type { CommandContext } from './index.js';

export async function returnbotHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0]?.replace(/\D/g, '');
  if (!phone) return bridgeMessages.returnbotUsage;

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);

  if (ctx.repos.conversation.getBookedAt(phone)) {
    return bridgeMessages.returnbotBooked;
  }

  const session = ctx.repos.bridgeSession.getByCustomer(phone);
  if (session) {
    ctx.repos.bridgeSession.close(session.agentChatId);
  }

  ctx.repos.conversation.clearHandoff(phone);

  return bridgeMessages.returnbotDone(phone);
}
