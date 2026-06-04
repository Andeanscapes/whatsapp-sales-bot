import { createHash } from 'crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ConversationAssignment } from '../db/repositories/types.js';

const bridgeLineSchema = z.object({
  id: z.string().min(1),
  type: z.literal('bridge'),
  label: z.string().min(1),
  weight: z.number().positive(),
  telegramChatId: z.string().min(1),
  agentName: z.string().min(1),
});

const referralLineSchema = z.object({
  id: z.string().min(1),
  type: z.literal('referral'),
  label: z.string().min(1),
  weight: z.number().positive(),
  telegramChatId: z.string().min(1),
  agentName: z.string().min(1),
  displayNumber: z.string().min(1),
});

const routingSchema = z.object({
  salesLines: z.array(z.discriminatedUnion('type', [bridgeLineSchema, referralLineSchema])).min(1),
}).superRefine((config, ctx) => {
  const ids = new Set<string>();
  const telegramChatIds = new Set<string>();

  config.salesLines.forEach((line, index) => {
    if (ids.has(line.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['salesLines', index, 'id'],
        message: 'sales line id must be unique',
      });
    }
    ids.add(line.id);

    if (telegramChatIds.has(line.telegramChatId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['salesLines', index, 'telegramChatId'],
        message: 'telegramChatId must be unique',
      });
    }
    telegramChatIds.add(line.telegramChatId);
  });
});

export type SalesLine = z.infer<typeof routingSchema>['salesLines'][number];
export type RoutingConfig = z.infer<typeof routingSchema>;

function substituteNames(value: string): string {
  return value
    .replace(/\{\{OWNER_NAME\}\}/g, env.OWNER_NAME)
    .replace(/\{\{PARTNER_NAME\}\}/g, env.PARTNER_NAME);
}

function withNames<T extends SalesLine>(line: T): T {
  return { ...line, label: substituteNames(line.label), agentName: substituteNames(line.agentName) };
}

let bridgeFlowFallbackWarned = false;

/**
 * Resolves the BRIDGE_FLOW override percentage. `env.BRIDGE_FLOW` is `-1` both
 * when intentionally disabled and when the raw value failed coercion (zod
 * `.catch(-1)`). We distinguish the two via the raw env string so a misconfig
 * (e.g. `BRIDGE_FLOW=150`) is surfaced once instead of silently disabling.
 */
function resolveBridgeFlow(): number {
  const flow = env.BRIDGE_FLOW;
  const raw = process.env.BRIDGE_FLOW?.trim();
  if (flow < 0 && raw && raw !== '-1' && !bridgeFlowFallbackWarned) {
    logger.warn({ raw }, '[ROUTING] BRIDGE_FLOW invalid (expected 0-100); using raw LEAD_ROUTING_JSON weights');
    bridgeFlowFallbackWarned = true;
  }
  return flow;
}

function normalizeConfig(config: RoutingConfig): RoutingConfig {
  const bridgeFlow = resolveBridgeFlow();

  const bridgeLines = config.salesLines.filter(l => l.type === 'bridge');
  const otherLines = config.salesLines.filter(l => l.type !== 'bridge');

  // No override when disabled/invalid, or when only one line group exists
  // (BRIDGE_FLOW splits between bridge and referral groups).
  if (bridgeFlow < 0 || bridgeFlow > 100 || bridgeLines.length === 0 || otherLines.length === 0) {
    return { salesLines: config.salesLines.map(withNames) };
  }

  const bridgeTotal = bridgeLines.reduce((s, l) => s + l.weight, 0);
  const otherTotal = otherLines.reduce((s, l) => s + l.weight, 0);
  const otherFlow = 100 - bridgeFlow;

  return {
    salesLines: config.salesLines.map(line => {
      const base = withNames(line);
      if (line.type === 'bridge') {
        const weight = bridgeTotal > 0 ? (line.weight / bridgeTotal) * bridgeFlow : bridgeFlow / bridgeLines.length;
        return { ...base, weight };
      }
      const weight = otherTotal > 0 ? (line.weight / otherTotal) * otherFlow : otherFlow / otherLines.length;
      return { ...base, weight };
    }),
  };
}

let cachedConfig: RoutingConfig | null | undefined;

export function getRoutingConfig(): RoutingConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  if (!env.LEAD_ROUTING_JSON.trim()) {
    cachedConfig = null;
    return cachedConfig;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(env.LEAD_ROUTING_JSON);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`LEAD_ROUTING_JSON is not valid JSON: ${reason}`);
  }
  const result = routingSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`LEAD_ROUTING_JSON failed validation: ${result.error.message}`);
  }
  cachedConfig = normalizeConfig(result.data);
  return cachedConfig;
}

export function hasRoutingConfig(): boolean {
  return getRoutingConfig() !== null;
}

/** Test-only: clears the memoized config so env changes take effect. */
export function resetRoutingConfigCache(): void {
  cachedConfig = undefined;
  bridgeFlowFallbackWarned = false;
}

export function isAllowedTelegramChat(chatId: string): boolean {
  const config = getRoutingConfig();
  if (!config) return chatId === env.TELEGRAM_CHAT_ID;
  return config.salesLines.some(line => line.telegramChatId === chatId);
}

export function getLineById(lineId: string): SalesLine | null {
  const config = getRoutingConfig();
  return config?.salesLines.find(line => line.id === lineId) ?? null;
}

export function getLineByTelegramChat(chatId: string): SalesLine | null {
  const config = getRoutingConfig();
  return config?.salesLines.find(line => line.telegramChatId === chatId) ?? null;
}

export function pickSalesLine(customerPhone: string): SalesLine | null {
  const config = getRoutingConfig();
  return config ? pickSalesLineFromConfig(config, customerPhone) : null;
}

export function pickSalesLineFromConfig(config: RoutingConfig, customerPhone: string): SalesLine | null {
  if (!config) return null;

  const total = config.salesLines.reduce((sum, line) => sum + line.weight, 0);
  const digest = createHash('sha256').update(customerPhone).digest();
  const bucket = digest.readUInt32BE(0) / 0xffffffff * total;
  let cursor = 0;

  for (const line of config.salesLines) {
    cursor += line.weight;
    if (bucket <= cursor) return line;
  }

  return config.salesLines[config.salesLines.length - 1] ?? null;
}

/**
 * Single source of routing policy. Resolves (and persists, once) the sales line
 * assigned to a customer. Sticky: an existing assignment is never overwritten.
 */
export function assignLine(repos: Repositories, customerPhone: string): SalesLine | null {
  const existing = repos.conversation.getAssignment(customerPhone);
  if (existing) return getLineById(existing.assignedLineId);

  const line = pickSalesLine(customerPhone);
  if (!line) return null;

  const assignment: ConversationAssignment = { assignedLineId: line.id, assignedAgentChat: line.telegramChatId };
  repos.conversation.setAssignment(customerPhone, assignment);
  return line;
}

export function isReferralLine(line: SalesLine | null): line is Extract<SalesLine, { type: 'referral' }> {
  return line?.type === 'referral';
}
