import { logger } from '../config/logger.js';
import type { CommandContext } from './index.js';

export async function resumeHandler(ctx: CommandContext): Promise<string> {
  if (!ctx.repos.isPaused()) return '▶️ El bot ya esta activo.';

  ctx.repos.setPaused(false);
  logger.info('[TELEGRAM_BOT] bot resumed via /resume command');
  return '▶️ Bot reactivado.';
}
