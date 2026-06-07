import type { ConversationRow, RecentMessage } from '../db/repositories/types.js';

const MAX_HISTORY_CHARS = 3500;

function md(text: string): string {
  return text.replace(/([*_`[])/g, '\\$1');
}

function formatRecentMessage(message: RecentMessage): string {
  const prefix = message.role === 'user' ? '👤 Cliente' : '🤖 Bot';

  if (message.messageType === 'image') {
    return `${prefix}: 📷 ${message.content.trim() ? md(message.content) : 'imagen'}`;
  }
  if (message.messageType === 'audio') return `${prefix}: 🎤 audio`;
  if (message.messageType === 'video') return `${prefix}: 🎥 video`;

  const content = message.content.length > 600 ? `${message.content.slice(0, 600)}...` : message.content;
  return `${prefix}: ${md(content)}`;
}

export function formatLeadHistory(conv: ConversationRow, recentMessages: RecentMessage[]): string {
  const lines: string[] = [
    '*Lead*',
    `Phone: ${md(conv.customer_phone)}`,
    `Score: ${conv.lead_score}`,
    `Phase: ${md(conv.sales_phase ?? '-')}`,
    `Mode: ${md(conv.conversation_mode ?? 'bot')}`,
  ];

  if (conv.assigned_line_id) lines.push(`Assigned line: ${md(conv.assigned_line_id)}`);
  if (conv.collected_name) lines.push(`Name: ${md(conv.collected_name)}`);
  if (conv.collected_people) lines.push(`People: ${conv.collected_people}`);
  if (conv.collected_date) lines.push(`Date: ${md(conv.collected_date)}`);
  if (conv.collected_plan) lines.push(`Plan: ${md(conv.collected_plan)}`);
  if (conv.collected_transport_need) lines.push(`Transport: ${md(conv.collected_transport_need)}`);
  if (conv.lead_intent) lines.push(`Intent: ${md(conv.lead_intent)}`);

  lines.push('', '*Recent messages*');
  if (recentMessages.length === 0) lines.push('No messages yet.');

  const selected: string[] = [];
  let remainingChars = MAX_HISTORY_CHARS - lines.join('\n').length;
  let skipped = 0;
  for (const message of [...recentMessages].reverse()) {
    const formatted = formatRecentMessage(message);
    const needed = formatted.length + 2;
    if (selected.length > 0 && needed > remainingChars) {
      skipped += 1;
      continue;
    }
    selected.unshift(formatted);
    remainingChars -= needed;
  }

  if (skipped > 0) lines.push(`Showing latest messages only (${skipped} older omitted).`);
  for (const message of selected) lines.push('', message);

  return lines.join('\n');
}
