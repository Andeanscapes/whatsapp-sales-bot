import { bridgeMessages } from '../services/bridge-messages.js';
import { stopbotHandler } from './stopbot.command.js';
import type { CommandContext } from './index.js';

export async function stopallHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0]?.replace(/\D/g, '');
  if (!phone) return bridgeMessages.stopallUsage;

  const result = await stopbotHandler(ctx);
  if (result === bridgeMessages.leadNotFound(phone) || result === bridgeMessages.stopbotBooked) return result;

  return bridgeMessages.stopallDone(phone);
}
