import { sendText } from '../services/whatsapp-client.js';
import { canAccessConversation } from '../services/access-control.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { getLineByTelegramChat, hasRoutingConfig } from '../services/lead-routing.js';
import { sendBridgeReply } from '../services/bridge-service.js';
import type { CommandContext } from './index.js';

export async function sendHandler(ctx: CommandContext): Promise<string> {
  const args = ctx.args;
  if (args.length < 2) return 'Uso: /send <telefono> <mensaje>';

  const phone = args[0];
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

  try {
    await sendText(phone, message);
    return `✅ Mensaje enviado a ${phone}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ Error al enviar: ${msg}`;
  }
}
