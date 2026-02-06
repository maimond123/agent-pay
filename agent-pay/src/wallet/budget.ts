/**
 * Budget Management
 *
 * Budget-capped autonomous signing. Configurable limits stored at ~/.agent-pay/budget.json.
 * Tracks per-transaction, daily, and total spending to keep the agent within safe bounds.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BUDGET_DIR = join(homedir(), ".agent-pay");
const BUDGET_PATH = join(BUDGET_DIR, "budget.json");

/**
 * Budget configuration — editable limits
 */
export interface BudgetConfig {
  maxTransactionUsd: number;   // Max per-transaction (default: 50)
  maxDailyUsd: number;         // Max per-day (default: 100)
  maxTotalUsd: number;         // Lifetime cap (default: 500)
  requireApprovalAboveUsd: number; // Prompt user above this amount (default: 25)
}

/**
 * A single spending record
 */
export interface SpendRecord {
  timestamp: string;   // ISO 8601
  amountUsd: number;
  type: string;        // e.g. "bridge", "deploy", "evm-tx"
  description: string;
  txHash?: string;
}

/**
 * Full budget state persisted to disk
 */
export interface BudgetState {
  config: BudgetConfig;
  records: SpendRecord[];
}

const DEFAULT_CONFIG: BudgetConfig = {
  maxTransactionUsd: 50,
  maxDailyUsd: 100,
  maxTotalUsd: 500,
  requireApprovalAboveUsd: 25,
};

/**
 * Load budget state from disk (or return defaults)
 */
export function loadBudget(): BudgetState {
  if (!existsSync(BUDGET_PATH)) {
    return { config: { ...DEFAULT_CONFIG }, records: [] };
  }
  try {
    const raw = readFileSync(BUDGET_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BudgetState>;
    return {
      config: { ...DEFAULT_CONFIG, ...parsed.config },
      records: parsed.records || [],
    };
  } catch {
    return { config: { ...DEFAULT_CONFIG }, records: [] };
  }
}

/**
 * Save budget state to disk atomically
 */
export function saveBudget(state: BudgetState): void {
  if (!existsSync(BUDGET_DIR)) {
    mkdirSync(BUDGET_DIR, { recursive: true });
  }
  const tmpPath = BUDGET_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  // Atomic rename
  const { renameSync } = require("fs");
  renameSync(tmpPath, BUDGET_PATH);
}

/**
 * Get total spent today (UTC)
 */
function todaySpend(records: SpendRecord[]): number {
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return records
    .filter((r) => r.timestamp.startsWith(todayStr))
    .reduce((sum, r) => sum + r.amountUsd, 0);
}

/**
 * Get total lifetime spend
 */
function totalSpend(records: SpendRecord[]): number {
  return records.reduce((sum, r) => sum + r.amountUsd, 0);
}

/**
 * Check whether a spend is allowed under current budget
 */
export function canSpend(
  amountUsd: number,
  type: string,
  state: BudgetState
): { allowed: boolean; reason?: string; requiresApproval?: boolean } {
  const { config, records } = state;

  // Per-transaction limit
  if (amountUsd > config.maxTransactionUsd) {
    return {
      allowed: false,
      reason: `Amount $${amountUsd.toFixed(2)} exceeds per-transaction limit of $${config.maxTransactionUsd.toFixed(2)}`,
    };
  }

  // Daily limit
  const dailyTotal = todaySpend(records) + amountUsd;
  if (dailyTotal > config.maxDailyUsd) {
    return {
      allowed: false,
      reason: `Would exceed daily limit: $${todaySpend(records).toFixed(2)} spent today + $${amountUsd.toFixed(2)} = $${dailyTotal.toFixed(2)} (limit: $${config.maxDailyUsd.toFixed(2)})`,
    };
  }

  // Total lifetime limit
  const lifetimeTotal = totalSpend(records) + amountUsd;
  if (lifetimeTotal > config.maxTotalUsd) {
    return {
      allowed: false,
      reason: `Would exceed lifetime limit: $${totalSpend(records).toFixed(2)} total + $${amountUsd.toFixed(2)} = $${lifetimeTotal.toFixed(2)} (limit: $${config.maxTotalUsd.toFixed(2)})`,
    };
  }

  // Approval threshold
  if (amountUsd > config.requireApprovalAboveUsd) {
    return { allowed: true, requiresApproval: true };
  }

  return { allowed: true };
}

/**
 * Record a spend and save to disk
 */
export function recordSpend(record: SpendRecord, state: BudgetState): BudgetState {
  const updated = {
    ...state,
    records: [...state.records, record],
  };
  saveBudget(updated);
  return updated;
}

/**
 * Get a summary of current budget usage
 */
export function getBudgetSummary(state: BudgetState): {
  dailySpent: number;
  dailyRemaining: number;
  totalSpent: number;
  totalRemaining: number;
  config: BudgetConfig;
} {
  const dailySpent = todaySpend(state.records);
  const totalSpentVal = totalSpend(state.records);
  return {
    dailySpent,
    dailyRemaining: Math.max(0, state.config.maxDailyUsd - dailySpent),
    totalSpent: totalSpentVal,
    totalRemaining: Math.max(0, state.config.maxTotalUsd - totalSpentVal),
    config: state.config,
  };
}
