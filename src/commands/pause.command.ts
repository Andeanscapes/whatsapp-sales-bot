import { logger } from '../config/logger.js';
import type { CommandContext } from './index.js';

export async function pauseHandler(ctx: CommandContext): Promise<string> {
  if (ctx.repos.isPaused()) return '⏸️ El bot ya esta pausado. Usa /resume para reactivar.';

  ctx.repos.setPaused(true);
  logger.info('[TELEGRAM_BOT] bot paused via /pause command');
  return '⏸️ Bot pausado. No respondera a clientes hasta /resume.';
}
