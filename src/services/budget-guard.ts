import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';

export interface BudgetResult {
  aiAllowed: boolean;
  reason?: string;
}

export function checkBudget(repos: Repositories, customerPhone: string): BudgetResult {
  if (!env.AI_ENABLED) return { aiAllowed: false, reason: 'ai_disabled' };

  const todayStart = new Date().toISOString().split('T')[0];
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const dailyCost = repos.aiUsage.getDailyCost(todayStart);
  if (dailyCost >= env.DAILY_AI_BUDGET_USD) {
    return { aiAllowed: false, reason: 'daily_budget_exceeded' };
  }

  const monthlyCost = repos.aiUsage.getMonthlyCost(monthStart);
  if (monthlyCost >= env.MONTHLY_AI_BUDGET_USD) {
    return { aiAllowed: false, reason: 'monthly_budget_exceeded' };
  }

  const customerCalls = repos.aiUsage.countCustomerDaily(customerPhone, todayStart);
  if (customerCalls >= env.MAX_AI_CALLS_PER_CUSTOMER_PER_DAY) {
    return { aiAllowed: false, reason: 'customer_daily_limit' };
  }

  const globalCalls = repos.aiUsage.countGlobalDaily(todayStart);
  if (globalCalls >= env.MAX_AI_CALLS_GLOBAL_PER_DAY) {
    return { aiAllowed: false, reason: 'global_daily_limit' };
  }

  return { aiAllowed: true };
}
