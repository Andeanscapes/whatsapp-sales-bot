import { z } from 'zod';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { Skills } from './skill-loader.js';
import { substituteTokens } from './skill-loader.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

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
  const exp = skills.andeanScapes.experiences[0] as Record<string, unknown>;
  const route = exp.route as Record<string, unknown>;
  const tactics = skills.salesStrategy.salesTactics as Record<string, unknown> | undefined;

  const dateList = ((exp.availability as Record<string, unknown>).availableDates as Array<Record<string, unknown>>)
    .map(d => {
      const dObj = new Date((d.date as string) + 'T00:00:00');
      const dayName = dObj.toLocaleDateString(lang === 'en' ? 'en-US' : 'es-CO', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      return `${dayName} (${d.status}${d.slotsApprox ? `, ~${d.slotsApprox} slots` : ''})`;
    })
    .join(', ');

  const pricingItems = ((exp.pricing as Record<string, unknown>).items as Array<Record<string, unknown>>)
    .filter((i: Record<string, unknown>) => i.publiclyShow)
    .map((i: Record<string, unknown>) =>
      i.couplePrice ? `${i.label}: ${(i.couplePrice as number).toLocaleString('en-US')} COP total` : i.pricePerPerson ? `${i.label}: ${(i.pricePerPerson as number).toLocaleString('en-US')} COP` : `${i.label}: consultar`
    ).join(' | ');

  const pricingRules = ((exp.pricing as Record<string, unknown>).botRules as string[]).join('; ');

  const included = (exp.included as string[]).join(', ');
  const notIncluded = (exp.notIncludedUnlessConfirmed as string[]).join(', ');
  const reservationFlow = (exp.reservationFlow as string[]).join('; ');

  const availabilityLastUpdated = (exp.availability as Record<string, unknown>).lastUpdated as string;
  const availabilityRule = (exp.availability as Record<string, unknown>).botRule as string;

  const ferryInfo = String(route.ferryInfo ?? '');
  const alternateRoute = String(route.alternateRoute ?? '');
  const arrivalTips = String(route.arrivalTips ?? '');
  const fromBogota = String(route.fromBogota ?? '');
  const routeBotRules = (route.botRules as string[] ?? []).join('; ');

  const cancellation = typeof exp.cancellationPolicy === 'string' ? exp.cancellationPolicy : '';
  const petPolicy = typeof exp.petPolicy === 'string' ? exp.petPolicy : '';
  const ageMin = typeof exp.ageMinimum === 'string' || typeof exp.ageMinimum === 'number' ? String(exp.ageMinimum) : '';
  const shortDesc = String(exp.shortDescription ?? '');
  const meetingPt = String(exp.meetingPoint ?? '');

  const climate = exp.climateInfo as Record<string, unknown> | undefined;
  const climateText = climate
    ? `${climate.temperature ?? ''}. ${climate.rainySeason ?? ''}. ${climate.notes ?? ''}`
    : '';

  const difficulty = exp.difficulty as Record<string, unknown> | undefined;
  const difficultyText = difficulty
    ? `${difficulty.level ?? 'Moderate'}. ${(difficulty.notes as string[] ?? []).join('; ')}`
    : '';

  const reality = exp.experienceReality as Record<string, unknown> | undefined;
  const roadInfo = reality?.roadConditions ?? '';
  const idealFor = reality?.idealFor ?? '';
  const notIdealFor = reality?.notIdealFor ?? '';

  const botBehavior = exp.botBehavior as Record<string, unknown> | undefined;
  const adventureFilter = String(botBehavior?.adventureFilter ?? '');
  const qualPhases = botBehavior?.qualificationPhases as Record<string, string> | undefined;
  const handoffExactReply = botBehavior?.handoffExactReply as Record<string, string> | undefined;
  const negativeExamples = String(botBehavior?.negativeExamples ?? '');

  const plans = exp.plans as Array<Record<string, unknown>> | undefined;
  const plansList = plans
    ? plans.map(p => `${p.id} — ${p.name} (${p.duration}): ${p.shortDescription} | Benefits: ${p.benefits}`).join('\n')
    : '';

  const facts = [
    `Business: ${skills.andeanScapes.business.name} — ${shortDesc}`,
    `Brand intro: ${(skills.andeanScapes.business as Record<string, unknown>).shortBrandIntro ?? ''}`,
    `Location: ${skills.andeanScapes.business.location}${meetingPt ? '. Meeting point: ' + meetingPt : ''}`,
    '---',
    `AVAILABLE PLANS:\n${plansList}`,
    '---',
    `Route from Bogota: ${fromBogota}`,
    alternateRoute ? `Alternate route: ${alternateRoute}` : null,
    ferryInfo ? `Ferry: ${ferryInfo}` : null,
    arrivalTips ? `Arrival tips: ${arrivalTips}` : null,
    routeBotRules ? `Route rules: ${routeBotRules}` : null,
    '---',
    `Availability (last updated: ${availabilityLastUpdated}): ${dateList}`,
    `Availability rule: ${availabilityRule}`,
    '---',
    `Pricing: ${pricingItems}`,
    `Pricing rules: ${pricingRules}`,
    '---',
    `Included: ${included}`,
    `NOT included: ${notIncluded}`,
    `Reservation flow: ${reservationFlow}`,
    '---',
    cancellation ? `Cancellation: ${cancellation}` : null,
    petPolicy ? `Pet policy: ${petPolicy}` : null,
    ageMin ? `Age minimum: ${ageMin}` : null,
    climateText ? `Climate: ${climateText}` : null,
    roadInfo ? `Road info: ${roadInfo}` : null,
    difficultyText ? `Difficulty: ${difficultyText}` : null,
    idealFor ? `Ideal for: ${idealFor}` : null,
    notIdealFor ? `NOT ideal for: ${notIdealFor}` : null,
    '---',
    `Adventure filter: ${adventureFilter}`,
    qualPhases?.phase1 ? `Phase 1: ${qualPhases.phase1}` : null,
    qualPhases?.phase2 ? `Phase 2: ${qualPhases.phase2}` : null,
    qualPhases?.phase3 ? `Phase 3: ${qualPhases.phase3}` : null,
    handoffExactReply ? `Handoff Exact Reply (ES): ${handoffExactReply.es}` : null,
    handoffExactReply ? `Handoff Exact Reply (EN): ${handoffExactReply.en}` : null,
    negativeExamples ? `Negative examples: ${negativeExamples}` : null,
  ].filter((f): f is string => f !== null);

  if (tactics) {
    facts.push(
      `Sales attitude: ${tactics.tonePersonality || ''}`,
      `Power confidence: ${(tactics.powerConfidence as Record<string, unknown>)?.attitude || ''}`,
      `Closing: ${(tactics.closing as Record<string, unknown>)?.assumptive || ''} | ${(tactics.closing as Record<string, unknown>)?.softTakeaway || ''}`,
      `Service rule: ${tactics.serviceOverSales || ''}`,
      `Meta: ${tactics.metaRule || ''}`,
      `First contact: ${tactics.firstContact || ''}`,
      `Typo handling: ${tactics.typoHandling || ''}`,
      `Human sell formula: ${tactics.humanSellFormula || ''}`
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

export function callDeepSeek(
  message: string,
  systemPrompt: string,
  recentMessages?: RecentMessageContext[],
): Promise<DeepSeekResult | null> {
  return callDeepSeekInternal(message, systemPrompt, recentMessages, null);
}

export function callDeepSeekCached(
  db: Database.Database,
  message: string,
  systemPrompt: string,
  recentMessages?: RecentMessageContext[],
): Promise<DeepSeekResult | null> {
  return callDeepSeekInternal(message, systemPrompt, recentMessages, db);
}

function hashCacheKey(systemPrompt: string, message: string, recentMessages?: RecentMessageContext[]): string {
  const hash = createHash('sha256');
  hash.update(systemPrompt);
  hash.update(message);
  if (recentMessages) {
    hash.update(JSON.stringify(recentMessages));
  }
  return hash.digest('hex');
}

function checkCache(db: Database.Database, cacheKey: string): DeepSeekResult | null {
  const row = db.prepare(
    "SELECT response_json FROM ai_cache WHERE cache_key = ? AND expires_at > ?"
  ).get(cacheKey, new Date().toISOString()) as { response_json: string } | undefined;
  if (!row) return null;

  try {
    const parsed = JSON.parse(row.response_json) as DeepSeekResult;
    logger.info({ cacheKey: cacheKey.slice(0, 12) }, '[AI] cache hit');
    return parsed;
  } catch {
    return null;
  }
}

function storeCache(db: Database.Database, cacheKey: string, result: DeepSeekResult): void {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (env.AI_CACHE_TTL_SECONDS * 1000)).toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO ai_cache (cache_key, response_json, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(cacheKey, JSON.stringify(result), now.toISOString(), expiresAt);
}

async function callDeepSeekInternal(
  message: string,
  systemPrompt: string,
  recentMessages: RecentMessageContext[] | undefined,
  db: Database.Database | null,
): Promise<DeepSeekResult | null> {
  const cacheKey = hashCacheKey(systemPrompt, message, recentMessages);

  if (db) {
    const cached = checkCache(db, cacheKey);
    if (cached) return cached;
  }

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
      logger.warn({ status: response.status }, '[AI] http error');
      return null;
    }

    const data = await response.json();
    const apiParse = deepSeekApiResponseSchema.safeParse(data);
    if (!apiParse.success) {
      logger.warn({ error: apiParse.error.message.slice(0, 200) }, '[AI] invalid api response');
      return null;
    }
    const apiResponse = apiParse.data;

    const content = apiResponse.choices[0]?.message?.content?.trim();
    if (!content) {
      logger.warn('[AI] empty content');
      return null;
    }

    const reply = parseDeepSeekReply(content);
    if (!reply) {
      logger.warn('[AI] no reply parsed');
      return null;
    }

    const promptTokens = apiResponse.usage?.prompt_tokens ?? 0;
    const completionTokens = apiResponse.usage?.completion_tokens ?? 0;

    const elapsed = Date.now() - startTime;
    logger.info({ elapsed, promptTokens, completionTokens }, '[AI] response');

    const result: DeepSeekResult = {
      response: reply,
      promptTokens,
      completionTokens,
    };

    if (db) {
      storeCache(db, cacheKey, result);
    }

    return result;
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : 'unknown' }, '[AI] request failed');
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
  pet: z.string().nullable().catch(null),
});

type MetaLine = z.infer<typeof metaLineSchema>;

const META_DEFAULTS: MetaLine = { delta: 0, img: false, name: null, people: null, date: null, transport_need: null, pet: null };

function stripAnyMetaFragment(text: string): string {
  return text.replace(/\s*\[META:[^\]]*\]?\s*$/s, '').trim();
}

function extractMetaLine(text: string): { reply: string; meta: MetaLine } {
  const match = text.match(/\[META:(\{[^}]+\})\]\s*$/);
  if (!match) {
    return { reply: stripAnyMetaFragment(text), meta: META_DEFAULTS };
  }
  try {
    const parsed = JSON.parse(match[1]);
    const result = metaLineSchema.safeParse(parsed);
    return {
      reply: text.slice(0, match.index).trim(),
      meta: result.success ? result.data : META_DEFAULTS,
    };
  } catch {
    return { reply: stripAnyMetaFragment(text), meta: META_DEFAULTS };
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
  const replyText = reply.length >= 2 ? reply : stripAnyMetaFragment(stripped);
  if (replyText.length < 2) return null;

  const collected_fields: Record<string, unknown> = {};
  if (meta.name != null) collected_fields.name = meta.name;
  if (meta.people != null) collected_fields.people = meta.people;
  if (meta.date != null) collected_fields.date = meta.date;
  if (meta.transport_need != null) collected_fields.transport_need = meta.transport_need;
  if (meta.pet != null) collected_fields.pet = meta.pet;

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
