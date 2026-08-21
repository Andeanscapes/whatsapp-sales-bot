import { canAccessConversation } from '../services/access-control.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { getLineByTelegramChat, hasRoutingConfig } from '../services/lead-routing.js';
import { sendBridgeReply } from '../services/bridge-service.js';
import { normalizeCommandPhone } from './phone.js';
import type { CommandContext } from './index.js';

export async function sendHandler(ctx: CommandContext): Promise<string> {
  const args = ctx.args;
  if (args.length < 2) return 'Uso: /send <telefono> <mensaje>';

  const phone = normalizeCommandPhone(args[0]);
  if (!phone) return 'Uso: /send <telefono> <mensaje>';
  const message = args.slice(1).join(' ');

  if (!canAccessConversation(ctx.repos, ctx.chatId, phone)) return bridgeMessages.leadAssignedToOther;

  if (hasRoutingConfig()) {
    const line = getLineByTelegramChat(String(ctx.chatId));
    if (!line || line.type !== 'bridge') return bridgeMessages.bridgeOnlyForApiLine;
    // Sending to a customer is a write action: require the lead be assigned to
    // this caller's line. Prevents bridge agents messaging arbitrary/unassigned
    // numbers.
    const assignment = ctx.repos.conversation.getAssignment(phone);
    if (!assignment) return bridgeMessages.leadNotAssigned;
    if (assignment.assignedAgentChat !== String(ctx.chatId)) return bridgeMessages.leadAssignedToOther;
    const result = await sendBridgeReply(ctx.repos, phone, message);
    return result.message;
  }

  // Single-line mode still goes through the bridge sender: it is the only path
  // that enforces pause / opt-out / the 24h service window AND persists the
  // outbound. A raw sendText here could message a customer who asked us to stop
  // and left no trace in the transcript.
  const result = await sendBridgeReply(ctx.repos, phone, message);
  return result.message;
}
