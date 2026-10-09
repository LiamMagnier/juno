/**
 * A hard token / cost budget shared by every child of a run (SPEC §3.4).
 *
 * One ledger per scope (a session turn's children, one workflow run). Every
 * provider request a child makes is charged here at its step boundary; once a
 * limit is reached the ledger is exhausted for good, new children are refused
 * and running ones stop at their next step. A request already in flight when
 * the line is crossed still lands, so a run can overshoot by at most one
 * request per running child — the ledger reports the true total either way.
 */

import type { Usage } from '../types.js';
import { estimateTierCostUsd, type ContextTier, type RunBudget } from '../contracts/code-v2.js';

export interface BudgetSnapshot {
  tokens: number;
  costUsd: number;
  maxTokens?: number;
  maxUsd?: number;
  exhausted: boolean;
  /** Plain-language reason once exhausted. */
  reason?: string;
}

export class BudgetLedger {
  private tokens = 0;
  private costUsd = 0;
  private stopReason: string | undefined;
  private readonly parent: BudgetLedger | undefined;
  private readonly listeners = new Set<(reason: string) => void>();

  constructor(
    readonly limits: RunBudget = {},
    parent?: BudgetLedger,
  ) {
    this.parent = parent;
  }

  /** A child ledger: charges roll up, and either one being exhausted stops it. */
  child(limits: RunBudget = {}): BudgetLedger {
    return new BudgetLedger(limits, this);
  }

  get exhausted(): boolean {
    return this.stopReason !== undefined || (this.parent?.exhausted ?? false);
  }

  get reason(): string | undefined {
    return this.stopReason ?? this.parent?.reason;
  }

  /** Called once, when this ledger (not its parent) runs out. */
  onExhausted(listener: (reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Record one request. Returns true when the budget is now exhausted, which
   * the caller turns into `'stop'`.
   */
  charge(usage: Usage, tier?: ContextTier): boolean {
    const tokens = usage.inputTokens + usage.outputTokens;
    const cost = tier
      ? estimateTierCostUsd(tier, {
          input: usage.inputTokens,
          output: usage.outputTokens,
          ...(usage.cacheReadTokens ? { cachedInput: usage.cacheReadTokens } : {}),
        })
      : 0;
    this.tokens += tokens;
    this.costUsd += cost;
    this.parent?.charge(usage, tier);
    if (this.stopReason === undefined) {
      const { maxTokens, maxUsd } = this.limits;
      if (maxTokens !== undefined && this.tokens >= maxTokens) {
        this.stopReason = `the run's token budget (${maxTokens.toLocaleString('en-US')} tokens) was reached`;
      } else if (maxUsd !== undefined && this.costUsd >= maxUsd) {
        this.stopReason = `the run's cost budget ($${maxUsd.toFixed(2)}) was reached`;
      }
      if (this.stopReason !== undefined) {
        for (const listener of this.listeners) listener(this.stopReason);
      }
    }
    return this.exhausted;
  }

  snapshot(): BudgetSnapshot {
    return {
      tokens: this.tokens,
      costUsd: Math.round(this.costUsd * 1_000_000) / 1_000_000,
      ...(this.limits.maxTokens === undefined ? {} : { maxTokens: this.limits.maxTokens }),
      ...(this.limits.maxUsd === undefined ? {} : { maxUsd: this.limits.maxUsd }),
      exhausted: this.exhausted,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}
