import { getLineByTelegramChat, isOwnerChat } from '../services/lead-routing.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { formatLeadCard, formatLeadHistory } from './lead-format.js';
import { emitTranscript, formatTranscriptFooter, parseTurnLimit } from './transcript-blocks.js';
import type { CommandContext } from './index.js';

const DEFAULT_TURNS = 20;
const MAX_TURNS = 40;

export async function chatHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0]?.replace(/\D/g, '');
  if (!phone) return bridgeMessages.bridgeUsage;

  const chatId = String(ctx.chatId);
  const isOwner = isOwnerChat(chatId);
  const line = getLineByTelegramChat(chatId);
  if (!isOwner && line && line.type !== 'bridge') return bridgeMessages.bridgeOnlyForApiLine;

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);

  const assignment = ctx.repos.conversation.getAssignment(phone);
  if (!isOwner) {
    if (!assignment) return bridgeMessages.leadNotAssigned;
    if (assignment.assignedAgentChat !== chatId) return bridgeMessages.leadAssignedToOther;
  }

  const targetSession = ctx.repos.bridgeSession.getByCustomer(phone);
  if (!isOwner && targetSession && targetSession.agentChatId !== chatId) {
    return bridgeMessages.leadAssignedToOther;
  }

  // One Telegram chat can bridge one customer. Close its previous bridge first
  // so returning to the bot and owner takeover never leave mixed live sessions.
  const currentSession = ctx.repos.bridgeSession.getByAgentChat(chatId);
  if (currentSession && currentSession.customerPhone !== phone) {
    ctx.repos.bridgeSession.close(chatId);
    ctx.repos.conversation.setMode(currentSession.customerPhone, currentSession.returnMode);
  }

  // Owner takeover replaces an agent's active bridge for this customer. The
  // target mode is set below only after its previous bridge session is closed.
  if (targetSession && targetSession.agentChatId !== chatId) {
    ctx.repos.bridgeSession.close(targetSession.agentChatId);
  }

  const returnMode = targetSession?.returnMode
    ?? (ctx.repos.conversation.getMode(phone) === 'human_only' ? 'human_only' : 'bot');
  ctx.repos.bridgeSession.open(chatId, phone, returnMode);
  ctx.repos.conversation.setMode(phone, 'bridge_active');

  // Without an emitter (offline callers, tests) keep the text-only transcript.
  if (!ctx.emit) {
    const history = formatLeadHistory(conv, ctx.repos.message.getRecentMessages(phone, 500));
    return `${bridgeMessages.chatActiveHeader(phone)}\n\n${history}`;
  }

  // The replay is emitted first so `chatActiveHeader` — the "you can type now"
  // call to action — is the LAST thing the agent sees.
  const limit = parseTurnLimit(ctx.args[1], DEFAULT_TURNS, MAX_TURNS);
  ctx.emit({ kind: 'text', text: formatLeadCard(conv), parseMode: 'Markdown' });
  const stats = await emitTranscript(ctx, phone, limit);
  return `${bridgeMessages.chatActiveHeader(phone)}\n${formatTranscriptFooter(stats, limit)}`;
}
