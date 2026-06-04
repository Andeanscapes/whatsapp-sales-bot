import { logger } from '../config/logger.js';
import { broadcastToAllLines } from '../services/broadcast.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { getLineByTelegramChat, isReferralLine } from '../services/lead-routing.js';
import type { CommandContext } from './index.js';

export async function resumeHandler(ctx: CommandContext): Promise<string> {
  if (!ctx.repos.isPaused()) return '▶️ El bot ya esta activo.';

  ctx.repos.setPaused(false);

  const line = getLineByTelegramChat(String(ctx.chatId));
  const who = line ? `${line.agentName}${isReferralLine(line) ? ` (${line.displayNumber})` : ''}` : 'Telegram';
  logger.info({ chatId: ctx.chatId, who }, '[TELEGRAM_BOT] bot resumed via /resume command');

  void broadcastToAllLines(bridgeMessages.botResumedBroadcast(who));

  return bridgeMessages.botResumedConfirmed;
}
