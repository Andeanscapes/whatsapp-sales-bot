import { bridgeMessages } from '../services/bridge-messages.js';
import { hasRoutingConfig } from '../services/lead-routing.js';
import type { CommandContext } from './index.js';

export async function blockHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0];
  if (!phone) return 'Uso: /block <telefono>';

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (hasRoutingConfig()) {
    if (!conv) return bridgeMessages.leadNotFound(phone);
    const assignment = ctx.repos.conversation.getAssignment(phone);
    if (!assignment) return bridgeMessages.leadNotAssigned;
    if (assignment.assignedAgentChat !== String(ctx.chatId)) return bridgeMessages.leadAssignedToOther;
  }
  if (conv && conv.opt_out_at) return `🔄 ${phone} ya estaba bloqueado.`;

  ctx.repos.optOut.setOptOut(phone);
  return `🚫 ${phone} bloqueado (opt-out).`;
}
