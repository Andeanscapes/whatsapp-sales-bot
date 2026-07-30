import { bridgeMessages } from '../services/bridge-messages.js';
import type { CommandContext } from './index.js';

export async function stopbotHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0]?.replace(/\D/g, '');
  if (!phone) return bridgeMessages.stopbotUsage;

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);

  if (ctx.repos.conversation.getBookedAt(phone)) {
    return bridgeMessages.stopbotBooked;
  }

  const agentChatId = String(ctx.chatId);
  const currentSession = ctx.repos.bridgeSession.getByAgentChat(agentChatId);
  if (currentSession && currentSession.customerPhone !== phone) {
    ctx.repos.bridgeSession.close(agentChatId);
    ctx.repos.conversation.setMode(currentSession.customerPhone, currentSession.returnMode);
  }

  const targetSession = ctx.repos.bridgeSession.getByCustomer(phone);
  if (targetSession && targetSession.agentChatId !== agentChatId) {
    ctx.repos.bridgeSession.close(targetSession.agentChatId);
  }
  ctx.repos.conversation.clearHandoff(phone);
  ctx.repos.bridgeSession.open(agentChatId, phone, 'human_only');
  ctx.repos.conversation.setMode(phone, 'bridge_active');
  return bridgeMessages.stopbotDone(phone);
}
