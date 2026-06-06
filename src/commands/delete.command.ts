import { bridgeMessages } from '../services/bridge-messages.js';
import { hasRoutingConfig, isOwnerChat } from '../services/lead-routing.js';
import type { CommandContext } from './index.js';

function normalizePhone(value: string | undefined): string | null {
  if (!value) return null;
  const phone = value.replace(/[^0-9]/g, '');
  return phone.length >= 8 ? phone : null;
}

export async function deleteHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizePhone(ctx.args[0]);
  if (!phone) return bridgeMessages.deleteUsage;

  // Mirror block.command authorization: in multi-line mode only the owning
  // agent may wipe a lead's data. The owner fallback chat (TELEGRAM_CHAT_ID)
  // bypasses the assignment check — full admin over every lead, including
  // unassigned ones (needed for testing). Single-line mode has no per-lead owner.
  if (hasRoutingConfig() && !isOwnerChat(String(ctx.chatId))) {
    const conv = ctx.repos.conversation.getByPhone(phone);
    if (!conv) return bridgeMessages.leadNotFound(phone);
    const assignment = ctx.repos.conversation.getAssignment(phone);
    if (!assignment) return bridgeMessages.leadNotAssigned;
    if (assignment.assignedAgentChat !== String(ctx.chatId)) return bridgeMessages.leadAssignedToOther;
  }

  const deleted = ctx.repos.customerData.deleteCustomer(phone);
  return bridgeMessages.deleteDone({ phone, ...deleted });
}
