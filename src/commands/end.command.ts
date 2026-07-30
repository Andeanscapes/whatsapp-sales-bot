import { bridgeMessages } from '../services/bridge-messages.js';
import type { CommandContext } from './index.js';

export async function endHandler(ctx: CommandContext): Promise<string> {
  const session = ctx.repos.bridgeSession.getByAgentChat(String(ctx.chatId));
  if (!session) return bridgeMessages.noActiveChat;

  ctx.repos.bridgeSession.close(String(ctx.chatId));
  const currentMode = ctx.repos.conversation.getMode(session.customerPhone);
  ctx.repos.conversation.setMode(session.customerPhone, currentMode === 'human_only' ? 'human_only' : session.returnMode);
  return bridgeMessages.chatClosed(session.customerPhone);
}
