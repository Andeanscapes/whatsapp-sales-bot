import type Database from 'better-sqlite3';
import { env } from '../config/env.js';

export interface BudgetResult {
  aiAllowed: boolean;
  reason?: string;
}

export function checkBudget(db: Database.Database, customerPhone: string): BudgetResult {
  if (!env.AI_ENABLED) return { aiAllowed: false, reason: 'ai_disabled' };

  const todayStart = new Date().toISOString().split('T')[0];
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const dailyCost = db.prepare(
    "SELECT COALESCE(SUM(estimated_cost_usd), 0) as cost FROM ai_usage WHERE created_at >= ?"
  ).get(todayStart) as { cost: number };
  if (dailyCost.cost >= env.DAILY_AI_BUDGET_USD) {
    return { aiAllowed: false, reason: 'daily_budget_exceeded' };
  }

  const monthlyCost = db.prepare(
    "SELECT COALESCE(SUM(estimated_cost_usd), 0) as cost FROM ai_usage WHERE created_at >= ?"
  ).get(monthStart) as { cost: number };
  if (monthlyCost.cost >= env.MONTHLY_AI_BUDGET_USD) {
    return { aiAllowed: false, reason: 'monthly_budget_exceeded' };
  }

  const customerCalls = db.prepare(
    "SELECT COUNT(*) as cnt FROM ai_usage WHERE customer_phone = ? AND created_at >= ?"
  ).get(customerPhone, todayStart) as { cnt: number };
  if (customerCalls.cnt >= env.MAX_AI_CALLS_PER_CUSTOMER_PER_DAY) {
    return { aiAllowed: false, reason: 'customer_daily_limit' };
  }

  const globalCalls = db.prepare(
    "SELECT COUNT(*) as cnt FROM ai_usage WHERE created_at >= ?"
  ).get(todayStart) as { cnt: number };
  if (globalCalls.cnt >= env.MAX_AI_CALLS_GLOBAL_PER_DAY) {
    return { aiAllowed: false, reason: 'global_daily_limit' };
  }

  return { aiAllowed: true };
}
