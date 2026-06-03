import { logger } from '../config/logger.js';
import { broadcastToAllLines } from '../services/broadcast.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { getLineByTelegramChat, isReferralLine } from '../services/lead-routing.js';
import type { CommandContext } from './index.js';

export async function pauseHandler(ctx: CommandContext): Promise<string> {
  if (ctx.repos.isPaused()) return '⏸️ El bot ya esta pausado. Usa /resume para reactivar.';

  ctx.repos.setPaused(true);

  const line = getLineByTelegramChat(String(ctx.chatId));
  const who = line ? `${line.agentName}${isReferralLine(line) ? ` (${line.displayNumber})` : ''}` : 'Telegram';
  logger.info({ chatId: ctx.chatId, who }, '[TELEGRAM_BOT] bot paused via /pause command');

  void broadcastToAllLines(bridgeMessages.botPausedBroadcast(who));

  return bridgeMessages.botPausedConfirmed;
}
