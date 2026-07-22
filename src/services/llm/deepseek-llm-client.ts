import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { type LlmClient, type LlmClientInput, type LlmTurn, type LlmResult } from './llm-client.js';
import { requestDeepSeekCompletion } from './deepseek-completion.js';

const DEEPSEEK_FETCH_TIMEOUT_MS = 30_000;

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
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly retryOnFail: boolean;

  constructor(retryOnFail = false) {
    this.maxTokens = env.DEEPSEEK_MAX_OUTPUT_TOKENS;
    this.temperature = env.DEEPSEEK_TEMPERATURE;
    this.retryOnFail = retryOnFail;
  }

  async complete(input: LlmClientInput): Promise<LlmResult | null> {
    const startTime = Date.now();

    const result = await this.callApi(input);
    input.onAttempt?.({ tokens: result?.tokens ?? { prompt: 0, completion: 0 }, success: result?.turn != null });
    if (result?.turn) {
      logger.info({ elapsed: Date.now() - startTime, tokens: result.tokens }, '[LLM] response');
      return { turn: result.turn, tokens: result.tokens };
    }

    if (this.retryOnFail) {
      logger.warn('[LLM] retry');
      const retry = await this.callApi(input);
      input.onAttempt?.({ tokens: retry?.tokens ?? { prompt: 0, completion: 0 }, success: retry?.turn != null });
      if (retry?.turn) {
        logger.info({ elapsed: Date.now() - startTime, tokens: retry.tokens }, '[LLM] response');
        return { turn: retry.turn, tokens: retry.tokens };
      }
    }

    return null;
  }

  private async callApi(input: LlmClientInput): Promise<{ turn: LlmTurn | null; tokens: { prompt: number; completion: number } } | null> {
    const systemContent = input.systemPromptSuffix
      ? `${input.systemPrompt}\n\n${input.systemPromptSuffix}`
      : input.systemPrompt;
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemContent },
    ];

    for (const h of input.history) {
      messages.push({ role: h.role, content: h.content });
    }

    messages.push({ role: 'user', content: `<customer_message>${input.message.replace(/<\/customer_message>/gi, '')}</customer_message>` });

    const result = await requestDeepSeekCompletion({
      messages,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      timeoutMs: DEEPSEEK_FETCH_TIMEOUT_MS,
      logTag: '[LLM]',
    });
    if (!result) return null;

    const tokens = { prompt: result.promptTokens, completion: result.completionTokens };

    if (result.content.length < 2) {
      logger.warn({ contentLen: result.content.length }, '[LLM] content too short');
      return { turn: null, tokens };
    }

    const turn = parsePlainTextContent(result.content);
    if (!turn) {
      logger.warn({ contentLen: result.content.length }, '[LLM] failed to parse content');
      return { turn: null, tokens };
    }

    return { turn, tokens };
  }
}
