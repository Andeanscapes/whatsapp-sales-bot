import { readFileSync } from 'fs';

interface Message {
  direction?: unknown;
  text?: unknown;
}

interface UsageBreakdown {
  reply?: { calls?: unknown; promptTokens?: unknown };
}

interface Conversation {
  score?: unknown;
  phase?: unknown;
  inboundCount?: unknown;
  outboundCount?: unknown;
  aiCostUsd?: unknown;
  aiUsageBreakdown?: UsageBreakdown;
  messages?: unknown;
}

interface ExportData {
  totals?: Record<string, unknown>;
  conversations?: unknown;
}

const configuredHotThreshold = Number(process.env.HOT_LEAD_THRESHOLD ?? 85);
const HOT_LEAD_THRESHOLD = Number.isFinite(configuredHotThreshold)
  && configuredHotThreshold >= 0
  && configuredHotThreshold <= 100
  ? configuredHotThreshold
  : 85;

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function conversations(value: unknown): Conversation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Conversation => typeof item === 'object' && item !== null);
}

function messages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Message => typeof item === 'object' && item !== null);
}

function main(): void {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npm run report:iteration -- <export.json>');

  const raw = JSON.parse(readFileSync(path, 'utf8')) as ExportData;
  if (!Array.isArray(raw.conversations)) {
    throw new Error('Expected a day-summary JSON object with a conversations array.');
  }
  const rows = conversations(raw.conversations);
  const replyRows = rows.filter(row => number(row.aiUsageBreakdown?.reply?.calls) > 0);
  const promptTokens = replyRows.reduce((sum, row) => sum + number(row.aiUsageBreakdown?.reply?.promptTokens), 0);
  const replyCalls = replyRows.reduce((sum, row) => sum + number(row.aiUsageBreakdown?.reply?.calls), 0);
  const costs = rows.reduce((sum, row) => sum + number(row.aiCostUsd), 0);
  const scores = rows.map(row => number(row.score));
  const phases = rows.reduce<Record<string, number>>((result, row) => {
    const phase = typeof row.phase === 'string' && row.phase ? row.phase : 'unknown';
    result[phase] = (result[phase] ?? 0) + 1;
    return result;
  }, {});
  const messagesByDirection = rows.flatMap(row => messages(row.messages));
  const inbound = messagesByDirection.filter(message => message.direction === 'inbound').length;
  const outbound = messagesByDirection.filter(message => message.direction === 'outbound').length;

  const report = {
    source: path,
    conversations: rows.length,
    inboundMessages: inbound,
    outboundMessages: outbound,
    averageScore: rows.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / rows.length : 0,
    hotLeads: scores.filter(score => score >= HOT_LEAD_THRESHOLD).length,
    midLeads: scores.filter(score => score >= 30 && score < HOT_LEAD_THRESHOLD).length,
    coldLeads: scores.filter(score => score < 30).length,
    phases,
    averageReplyPromptTokens: replyCalls > 0 ? promptTokens / replyCalls : 0,
    averageCostPerConversation: rows.length > 0 ? costs / rows.length : 0,
    totals: raw.totals ?? {},
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Iteration report failed.');
  process.exit(1);
}
