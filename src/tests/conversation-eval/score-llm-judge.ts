import type { TurnRecord } from './runner.js';
import type { DimensionScores } from './schema.js';
import { INPUT_COST_PER_TOKEN, OUTPUT_COST_PER_TOKEN } from '../../services/constants.js';
import { z } from 'zod';

const DEFAULT_LIVE_WEIGHT = 0.3;

export interface LlmJudgeResult {
  qualification: number;
  salesStrategy: number;
  closeStrategy: number;
  safety: number;
  mediaGuards: number;
  total: number;
  approved: boolean;
  notes: string;
  recommendations: string;
  promptTokens: number;
  completionTokens: number;
}

const llmJudgeResponseSchema = z.object({
  qualification: z.number(),
  salesStrategy: z.number(),
  closeStrategy: z.number(),
  safety: z.number(),
  mediaGuards: z.number(),
  total: z.number(),
  approved: z.boolean(),
  notes: z.string(),
  recommendations: z.string(),
}).strict();

export function llmCostUsd(promptTokens: number, completionTokens: number): number {
  return promptTokens * INPUT_COST_PER_TOKEN + completionTokens * OUTPUT_COST_PER_TOKEN;
}

interface LlmJudgeInput {
  turns: TurnRecord[];
  deterministic: DimensionScores;
  deterministicTotal: number;
  scenarioId: string;
}

function getLlmConfig(): { apiKey: string; model: string; url: string } | null {
  const apiKey = process.env.EVAL_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey === 'test') return null;
  return {
    apiKey,
    model: process.env.EVAL_LLM_MODEL ?? 'deepseek-chat',
    url: process.env.EVAL_LLM_URL ?? 'https://api.deepseek.com/v1/chat/completions',
  };
}

export async function runLlmJudge(input: LlmJudgeInput): Promise<LlmJudgeResult | null> {
  const config = getLlmConfig();
  if (!config) return null;

  const transcript = input.turns.map(t =>
    `[Turn ${t.turnNumber}] User: ${t.user}\nBot: ${t.reply}`
  ).join('\n\n');

  const det = input.deterministic;

  const prompt = `You are scoring a WhatsApp sales bot conversation. Evaluate the bot's quality.

Transcript:
${transcript}

Deterministic scores (0-100) from code-based analysis:
- qualification: ${det.qualification}
- salesStrategy: ${det.salesStrategy}
- closeStrategy: ${det.closeStrategy}
- safety: ${det.safety}
- mediaGuards: ${det.mediaGuards}
- total: ${input.deterministicTotal}

Evaluate: tone, empathy, natural flow, sales effectiveness, trust-building. Judge qualitative aspects the deterministic scorer cannot capture. Adjust scores ONLY if you see clear qualitative misalignment with the score — otherwise keep them close to deterministic.

Return ONLY valid JSON (no markdown fences):
{
  "qualification": number (0-100),
  "salesStrategy": number (0-100),
  "closeStrategy": number (0-100),
  "safety": number (0-100),
  "mediaGuards": number (0-100),
  "total": number (0-100),
  "approved": boolean,
  "notes": "one-sentence quality observation",
  "recommendations": "1-2 sentences of actionable improvement advice"
}`;

  try {
    const resp = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: 'You are a quality evaluator for a WhatsApp sales bot. Return only valid JSON. Never include markdown fences or extra text.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
    });

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;

    const cleaned = content.replace(/```(?:json)?\s*|\s*```/g, '').trim();
    const parsed = llmJudgeResponseSchema.parse(JSON.parse(cleaned));

    return {
      qualification: clamp(parsed.qualification),
      salesStrategy: clamp(parsed.salesStrategy),
      closeStrategy: clamp(parsed.closeStrategy),
      safety: clamp(parsed.safety),
      mediaGuards: clamp(parsed.mediaGuards),
      total: clamp(parsed.total),
      approved: Boolean(parsed.approved),
      notes: String(parsed.notes ?? ''),
      recommendations: String(parsed.recommendations ?? ''),
      promptTokens,
      completionTokens,
    };
  } catch {
    return null;
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function mergeScores(
  deterministic: DimensionScores,
  deterministicTotal: number,
  judge: LlmJudgeResult,
  liveWeight: number = DEFAULT_LIVE_WEIGHT,
): { scores: DimensionScores; total: number; notes: string[] } {
  const detWeight = 1 - liveWeight;

  return {
    scores: {
      qualification: Math.round(deterministic.qualification * detWeight + judge.qualification * liveWeight),
      salesStrategy: Math.round(deterministic.salesStrategy * detWeight + judge.salesStrategy * liveWeight),
      closeStrategy: Math.round(deterministic.closeStrategy * detWeight + judge.closeStrategy * liveWeight),
      safety: Math.round(deterministic.safety * detWeight + judge.safety * liveWeight),
      mediaGuards: Math.round(deterministic.mediaGuards * detWeight + judge.mediaGuards * liveWeight),
    },
    total: Math.round(deterministicTotal * detWeight + judge.total * liveWeight),
    notes: [
      `LLM judge ${judge.approved ? 'APPROVED' : 'REJECTED'}: ${judge.notes}`,
      `Recommendations: ${judge.recommendations}`,
    ],
  };
}
