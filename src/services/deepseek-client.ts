import { z } from 'zod';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import type { Skills } from './skill-loader.js';
import { substituteTokens } from './skill-loader.js';
import { env } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT_CACHED: string = substituteTokens(
  readFileSync(join(__dirname, '..', 'prompts', 'deepseek-system.prompt.md'), 'utf-8')
);

const INPUT_COST_PER_TOKEN = 0.15 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000;
const DEEPSEEK_FETCH_TIMEOUT_MS = 60_000;

export interface DeepSeekResponse {
  reply: string | null;
  intent: string;
  lead_score_delta: number;
  should_send_image: boolean;
  needs_human: boolean;
  missing_fields: string[];
  collected_fields: Record<string, unknown>;
}

export interface DeepSeekResult {
  response: DeepSeekResponse;
  promptTokens: number;
  completionTokens: number;
}

export interface RecentMessageContext {
  role: 'user' | 'assistant';
  content: string;
}

const deepSeekApiChoiceSchema = z.object({
  message: z.object({
    content: z.string(),
  }),
});

const deepSeekApiUsageSchema = z.object({
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  prompt_cache_hit_tokens: z.number().int().optional(),
  prompt_cache_miss_tokens: z.number().int().optional(),
});

const deepSeekApiResponseSchema = z.object({
  choices: z.array(deepSeekApiChoiceSchema),
  usage: deepSeekApiUsageSchema.optional(),
});

export function readSystemPrompt(): string {
  return SYSTEM_PROMPT_CACHED;
}

export function buildSystemPrompt(skills: Skills, lang?: string, collectedFields?: Record<string, unknown>): string {
  const base = readSystemPrompt();
  const exp = skills.andeanScapes.experiences[0];
  const tactics = skills.salesStrategy.salesTactics as Record<string, unknown> | undefined;

  const facts = [
    `Business: ${skills.andeanScapes.business.name} — ${exp.shortDescription}`,
    `Location: ${skills.andeanScapes.business.location}`,
    `Route from Bogota: ${exp.route.fromBogota}`,
    `Available dates: ${exp.availability.availableDates.map(d => d.date).join(', ')} (${exp.availability.botRule})`,
    'Pricing: ' + exp.pricing.items.filter(i => i.publiclyShow).map(i =>
      i.couplePrice ? `${i.label}: ${(i.couplePrice as number).toLocaleString('en-US')} COP total` : i.pricePerPerson ? `${i.label}: ${(i.pricePerPerson as number).toLocaleString('en-US')} COP` : `${i.label}: consultar`
    ).join(' | '),
    'Pricing rules: ' + exp.pricing.botRules.join('; '),
    'Included: ' + exp.included.join(', '),
    'NOT included: ' + exp.notIncludedUnlessConfirmed.join(', '),
    'Reservation: ' + exp.reservationFlow.join('; '),
  ];

  if (tactics) {
    facts.push(
      `Sales attitude: ${tactics.tonePersonality || ''}`,
      `Power confidence: ${(tactics.powerConfidence as Record<string, unknown>)?.attitude || ''}`,
      `Closing: ${(tactics.closing as Record<string, unknown>)?.assumptive || ''} | ${(tactics.closing as Record<string, unknown>)?.softTakeaway || ''}`,
      `Service rule: ${tactics.serviceOverSales || ''}`,
      `Meta: ${tactics.metaRule || ''}`
    );
  }

  if (collectedFields && Object.keys(collectedFields).length > 0) {
    const fieldLines: string[] = [];
    for (const [k, v] of Object.entries(collectedFields)) {
      if (v != null) fieldLines.push(`  - ${k}: ${v}`);
    }
    facts.unshift('LO QUE YA SABEMOS DE ESTE CLIENTE (NO vuelvas a preguntar esto):\n' + fieldLines.join('\n'));
  }

  return `${base}\n\n---\n${facts.join('\n')}`;
}

function logDeepSeekIssue(reason: string, detail?: string): void {
  console.warn('[AI] DeepSeek issue:', JSON.stringify({ reason, detail: detail?.slice(0, 200) }));
}

export async function callDeepSeek(
  message: string,
  systemPrompt: string,
  recentMessages?: RecentMessageContext[],
): Promise<DeepSeekResult | null> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  if (recentMessages && recentMessages.length > 0) {
    for (const rm of recentMessages) {
      messages.push({ role: rm.role, content: rm.content });
    }
  }

  messages.push({ role: 'user', content: message });
  const startTime = Date.now();
  try {
    const response = await fetch(`${env.DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(DEEPSEEK_FETCH_TIMEOUT_MS),
      headers: {
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL,
        messages,
        max_tokens: env.DEEPSEEK_MAX_OUTPUT_TOKENS,
        temperature: env.DEEPSEEK_TEMPERATURE,
      }),
    });

    if (!response.ok) {
      logDeepSeekIssue('http_error', `status:${response.status}`);
      return null;
    }

    const data = await response.json();
    const apiParse = deepSeekApiResponseSchema.safeParse(data);
    if (!apiParse.success) {
      logDeepSeekIssue('invalid_api_response', apiParse.error.message);
      return null;
    }
    const apiResponse = apiParse.data;

    const content = apiResponse.choices[0]?.message?.content?.trim();
    if (!content) {
      logDeepSeekIssue('empty_content');
      return null;
    }

    const reply = parseDeepSeekReply(content);
    if (!reply) {
      logDeepSeekIssue('no_reply');
      return null;
    }

    const promptTokens = apiResponse.usage?.prompt_tokens ?? 0;
    const completionTokens = apiResponse.usage?.completion_tokens ?? 0;

    const elapsed = Date.now() - startTime;
    console.log('[AI] responseTime:', elapsed, 'ms, tokens:', promptTokens, '+', completionTokens);

    return {
      response: reply,
      promptTokens,
      completionTokens,
    };
  } catch (error) {
    logDeepSeekIssue('request_failed', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

const metaLineSchema = z.object({
  delta: z.number().int().catch(0),
  img: z.boolean().catch(false),
  name: z.string().nullable().catch(null),
  people: z.number().int().nullable().catch(null),
  date: z.string().nullable().catch(null),
  transport_need: z.string().nullable().catch(null),
});

type MetaLine = z.infer<typeof metaLineSchema>;

const META_DEFAULTS: MetaLine = { delta: 0, img: false, name: null, people: null, date: null, transport_need: null };

function extractMetaLine(text: string): { reply: string; meta: MetaLine } {
  const match = text.match(/\[META:(\{[^}]+\})\]\s*$/);
  if (!match) return { reply: text, meta: META_DEFAULTS };
  try {
    const parsed = JSON.parse(match[1]);
    const result = metaLineSchema.safeParse(parsed);
    return {
      reply: text.slice(0, match.index).trim(),
      meta: result.success ? result.data : META_DEFAULTS,
    };
  } catch {
    return { reply: text, meta: META_DEFAULTS };
  }
}

function parseDeepSeekReply(content: string): DeepSeekResponse | null {
  if (content.includes('[NO_REPLY]') || content.length < 3) return null;

  const needsHuman = content.includes('[NEEDS_HUMAN]');

  const stripped = content
    .replace(/\[NEEDS_HUMAN\]/g, '')
    .replace(/\[NO_REPLY\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (stripped.length < 2) return null;

  const { reply, meta } = extractMetaLine(stripped);
  const replyText = reply.length >= 2 ? reply : stripped;

  const collected_fields: Record<string, unknown> = {};
  if (meta.name != null) collected_fields.name = meta.name;
  if (meta.people != null) collected_fields.people = meta.people;
  if (meta.date != null) collected_fields.date = meta.date;
  if (meta.transport_need != null) collected_fields.transport_need = meta.transport_need;

  return {
    reply: replyText,
    intent: 'general',
    lead_score_delta: needsHuman ? Math.max(meta.delta, 30) : meta.delta,
    should_send_image: meta.img,
    needs_human: needsHuman,
    missing_fields: [],
    collected_fields,
  };
}

export function recordAiUsage(
  db: Database.Database,
  customerPhone: string,
  usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number }
): void {
  const estimatedCost = usage.prompt_tokens * INPUT_COST_PER_TOKEN + usage.completion_tokens * OUTPUT_COST_PER_TOKEN;
  db.prepare(
    'INSERT INTO ai_usage (customer_phone, model, prompt_tokens, completion_tokens, cached_tokens, estimated_cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(customerPhone, env.DEEPSEEK_MODEL, usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens ?? 0, estimatedCost, new Date().toISOString());
}
