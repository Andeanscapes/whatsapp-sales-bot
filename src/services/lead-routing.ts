import { createHash } from 'crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
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

function normalizeConfig(config: RoutingConfig): RoutingConfig {
  return {
    salesLines: config.salesLines.map(line => ({
      ...line,
      label: substituteNames(line.label),
      agentName: substituteNames(line.agentName),
    })),
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
