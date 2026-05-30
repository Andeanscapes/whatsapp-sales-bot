import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { type LlmClient, type LlmClientInput, type LlmTurn, type LlmResult } from './llm-client.js';

const DEEPSEEK_FETCH_TIMEOUT_MS = 30_000;

const deepSeekApiResponseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().optional().catch(undefined),
    message: z.object({
      content: z.string().nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
    }).catch(() => ({ content: '' })),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().optional().catch(undefined),
    completion_tokens: z.number().int().optional().catch(undefined),
    completion_tokens_details: z.object({
      reasoning_tokens: z.number().int().optional().catch(undefined),
    }).optional().catch(undefined),
  }).optional(),
});

function parsePlainTextContent(content: string): LlmTurn | null {
  const reply = content.trim();
  if (reply.length < 2) return null;
  return {
    reply,
    sales_phase: 'discovery',
    action: 'answer',
    collected_fields: { name: null, plan: null, people: null, date: null, transport_need: null, pet: null },
    lead: { intent: 'curious', buying_signals: [], blockers: [], score_delta: 0, confidence: 0.5 },
    img: false,
  };
}

export class DeepSeekLlmClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly retryOnFail: boolean;

  constructor(retryOnFail = false) {
    this.baseUrl = env.DEEPSEEK_BASE_URL;
    this.apiKey = env.DEEPSEEK_API_KEY;
    this.model = env.DEEPSEEK_MODEL;
    this.maxTokens = env.DEEPSEEK_MAX_OUTPUT_TOKENS;
    this.temperature = env.DEEPSEEK_TEMPERATURE;
    this.retryOnFail = retryOnFail;
  }

  async complete(input: LlmClientInput): Promise<LlmResult | null> {
    const startTime = Date.now();

    const result = await this.callApi(input);
    if (result) {
      logger.info({ elapsed: Date.now() - startTime, tokens: result.tokens }, '[LLM] response');
      return { turn: result.turn, tokens: result.tokens };
    }

    if (this.retryOnFail) {
      logger.warn('[LLM] retry');
      const retry = await this.callApi(input);
      if (retry) {
        logger.info({ elapsed: Date.now() - startTime, tokens: retry.tokens }, '[LLM] response');
        return { turn: retry.turn, tokens: retry.tokens };
      }
    }

    return null;
  }

  private async callApi(input: LlmClientInput): Promise<{ turn: LlmTurn; tokens: { prompt: number; completion: number } } | null> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: input.systemPrompt },
    ];

    for (const h of input.history) {
      messages.push({ role: h.role, content: h.content });
    }

    messages.push({ role: 'user', content: input.message });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      thinking: { type: 'disabled' },
    };

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(DEEPSEEK_FETCH_TIMEOUT_MS),
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, '[LLM] http error');
        return null;
      }

      const data = await response.json();
      const apiParse = deepSeekApiResponseSchema.safeParse(data);
      if (!apiParse.success) {
        logger.warn({ error: apiParse.error.message.slice(0, 200) }, '[LLM] invalid api response');
        return null;
      }

      const choice = apiParse.data.choices[0];
      const content = choice?.message?.content?.trim();
      if (!content) {
        logger.warn({
          finishReason: choice?.finish_reason,
          completionTokens: apiParse.data.usage?.completion_tokens ?? 0,
          reasoningTokens: apiParse.data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
          hasReasoningContent: Boolean(choice?.message?.reasoning_content),
        }, '[LLM] empty content');
        return null;
      }

      if (content.length < 2) {
        logger.warn({ preview: content.slice(0, 200) }, '[LLM] content too short');
        return null;
      }

      const turn = parsePlainTextContent(content);
      if (!turn) {
        logger.warn({ preview: content.slice(0, 200) }, '[LLM] failed to parse content');
        return null;
      }

      const tokens = apiParse.data.usage?.prompt_tokens ?? 0;
      const completionTokens = apiParse.data.usage?.completion_tokens ?? 0;
      return { turn, tokens: { prompt: tokens, completion: completionTokens } };
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : 'unknown' }, '[LLM] request failed');
      return null;
    }
  }
}
