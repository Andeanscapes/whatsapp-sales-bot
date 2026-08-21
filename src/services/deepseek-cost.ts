import { env } from '../config/env.js';

export function estimateDeepSeekCost(promptTokens: number, completionTokens: number): number {
  return (
    promptTokens * env.DEEPSEEK_INPUT_COST_PER_MILLION_USD
    + completionTokens * env.DEEPSEEK_OUTPUT_COST_PER_MILLION_USD
  ) / 1_000_000;
}
