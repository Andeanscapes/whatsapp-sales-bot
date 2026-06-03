import { bridgeMessages } from '../services/bridge-messages.js';
import type { CommandContext } from './index.js';

export async function endHandler(ctx: CommandContext): Promise<string> {
  const session = ctx.repos.bridgeSession.getByAgentChat(String(ctx.chatId));
  if (!session) return bridgeMessages.noActiveChat;

  ctx.repos.bridgeSession.close(String(ctx.chatId));
  ctx.repos.conversation.setMode(session.customerPhone, 'bot');
  return bridgeMessages.chatClosed(session.customerPhone);
}
