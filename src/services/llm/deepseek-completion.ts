import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { reportDeepSeekFailure, reportDeepSeekSuccess } from '../whatsapp-operational-health.js';

/**
 * Shared low-level DeepSeek chat/completions transport. Both the reply client
 * (`DeepSeekLlmClient`) and the lead analyzer use this so auth, timeout,
 * `thinking:{disabled}`, and envelope validation live in exactly one audited
 * place. Never log the API key.
 */

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

export type DeepSeekMessage = { role: string; content: string };

export interface DeepSeekCompletionInput {
  messages: DeepSeekMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logTag: string;
}

export interface DeepSeekCompletionResult {
  content: string;
  finishReason: string | undefined;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Sends a validated chat completion request. Returns null on transport, HTTP,
 * or envelope failure. Empty content is returned with its usage metadata so
 * callers can account for the billed attempt before applying their fallback.
 */
export async function requestDeepSeekCompletion(input: DeepSeekCompletionInput): Promise<DeepSeekCompletionResult | null> {
  try {
    const response = await fetch(`${env.DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: {
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL,
        messages: input.messages,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        thinking: { type: 'disabled' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, `${input.logTag} http error`);
      void reportDeepSeekFailure(`HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    const parsed = deepSeekApiResponseSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error.message.slice(0, 200) }, `${input.logTag} invalid api response`);
      void reportDeepSeekFailure('respuesta invalida');
      return null;
    }

    const choice = parsed.data.choices[0];
    const content = choice?.message?.content?.trim();
    const promptTokens = parsed.data.usage?.prompt_tokens ?? 0;
    const completionTokens = parsed.data.usage?.completion_tokens ?? 0;

    // Transport OK even if content empty — do not treat as infra outage.
    void reportDeepSeekSuccess();

    if (!content) {
      logger.warn({
        finishReason: choice?.finish_reason,
        completionTokens,
        reasoningTokens: parsed.data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        hasReasoningContent: Boolean(choice?.message?.reasoning_content),
      }, `${input.logTag} empty content`);
      return { content: '', finishReason: choice?.finish_reason, promptTokens, completionTokens };
    }

    return { content, finishReason: choice?.finish_reason, promptTokens, completionTokens };
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : 'unknown' }, `${input.logTag} request failed`);
    void reportDeepSeekFailure(error instanceof Error ? error.message : 'conexion fallida');
    return null;
  }
}
