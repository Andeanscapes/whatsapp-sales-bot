import { bridgeMessages } from '../services/bridge-messages.js';
import { canAccessConversation } from '../services/access-control.js';
import { formatLeadCard, formatLeadHistory } from './lead-format.js';
import { emitTranscript, formatTranscriptFooter, parseTurnLimit } from './transcript-blocks.js';
import { normalizeCommandPhone } from './phone.js';
import type { CommandContext } from './index.js';

const DEFAULT_TURNS = 12;
const MAX_TURNS = 40;

export async function leadHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizeCommandPhone(ctx.args[0]);
  if (!phone) return bridgeMessages.leadUsage;

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);

  if (!canAccessConversation(ctx.repos, ctx.chatId, phone)) return bridgeMessages.leadAssignedToOther;

  const limit = parseTurnLimit(ctx.args[1], DEFAULT_TURNS, MAX_TURNS);

  // Without an emitter (offline callers, tests) fall back to the text-only
  // transcript so the command never silently returns just a card.
  if (!ctx.emit) {
    return formatLeadHistory(conv, ctx.repos.message.getRecentMessages(phone, limit));
  }

  ctx.emit({ kind: 'text', text: formatLeadCard(conv), parseMode: 'Markdown' });
  const stats = await emitTranscript(ctx, phone, limit);
  return formatTranscriptFooter(stats, limit);
}
