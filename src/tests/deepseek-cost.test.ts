import { describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { estimateDeepSeekCost } from '../services/deepseek-cost.js';

describe('estimateDeepSeekCost', () => {
  it('uses configured per-million input and output rates', () => {
    const cost = estimateDeepSeekCost(1_000_000, 1_000_000);

    expect(cost).toBe(
      env.DEEPSEEK_INPUT_COST_PER_MILLION_USD
      + env.DEEPSEEK_OUTPUT_COST_PER_MILLION_USD,
    );
  });
});
