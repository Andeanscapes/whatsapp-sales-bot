import type { ConversationRow, RecentMessage } from '../db/repositories/types.js';

function md(text: string): string {
  return text.replace(/([*_`[])/g, '\\$1');
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
  for (const message of recentMessages.slice(-12)) {
    const prefix = message.role === 'user' ? '👤 Cliente' : '🤖 Bot';
    const content = message.content.length > 600 ? `${message.content.slice(0, 600)}...` : message.content;
    lines.push('', `${prefix}: ${md(content)}`);
  }

  return lines.join('\n');
}
