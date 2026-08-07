/**
 * Ceiling enforcement for a Work run: tokens, spend and wall-clock runtime.
 *
 * The whole of this module exists to produce one value — `'stop'` from
 * `AgentLoopOptions.onStep` — at the right moment and for a nameable reason.
 * The loop already has that seam and `SubagentManager` already uses it, so
 * nothing here forks the loop; it wraps the callback.
 *
 * Which ceiling was hit is carried through to the run's terminal reason rather
 * than flattened into "budget_exceeded". A run stopped by the clock and a run
 * stopped by spend are different problems: the first is usually a task that
 * needs splitting, the second is usually a limit that needs raising, and a
 * user shown the wrong one goes and changes the wrong setting.
 *
 * Runtime is measured against an injected clock. A test that has to sleep for
 * a real timeout is a test that either takes minutes or is flaky, and the
 * awkward case here — that time spent waiting for a person must not count —
 * cannot be exercised at all without controlling the clock.
 */

import type { Usage } from '../types.js';
import {
  budgetExceeded,
  type BudgetUsage,
  type WorkBudget,
  type WorkTerminalReason,
} from './types.js';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Per-million-token prices in micro-USD, so the arithmetic stays in integers.
 *
 * Floating-point currency accumulated over a few hundred steps drifts, and the
 * column it is compared against (`WorkRun.maxCostMicroUsd`) is an Int.
 */
export interface WorkModelPricing {
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
}

/** Fraction of a ceiling at which the user is warned, once, per limit. */
export const BUDGET_WARNING_FRACTION = 0.8;

export interface WorkBudgetWarning {
  limit: 'cost' | 'tokens' | 'runtime';
  detail: string;
  /** How much of the ceiling has gone, as a fraction of one. */
  fraction: number;
}

export interface WorkBudgetOutcome {
  limit: 'cost' | 'tokens' | 'runtime';
  detail: string;
  terminalReason: WorkTerminalReason;
}

export interface WorkBudgetGuardOptions {
  budget: WorkBudget;
  clock?: Clock;
  pricing?: WorkModelPricing;
  onWarning?(warning: WorkBudgetWarning): void;
}

/** The guard's serialised form, so a resumed run keeps what it has spent. */
export interface WorkBudgetState {
  costMicroUsd: number;
  tokens: number;
  accumulatedMs: number;
  warned: Array<'cost' | 'tokens' | 'runtime'>;
  /** Optional so checkpoints written before this field shipped still restore. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * The terminal reason for each ceiling.
 *
 * Runtime maps to `timed_out` and not to `budget_exceeded`, because the
 * schema's terminal reasons already distinguish them and collapsing the two
 * loses the distinction at the only point it could have been recorded.
 */
function terminalReasonFor(limit: 'cost' | 'tokens' | 'runtime'): WorkTerminalReason {
  return limit === 'runtime' ? 'timed_out' : 'budget_exceeded';
}

export class WorkBudgetGuard {
  private readonly budget: WorkBudget;
  private readonly clock: Clock;
  private readonly pricing?: WorkModelPricing;
  private readonly onWarning?: (warning: WorkBudgetWarning) => void;
  private costMicroUsd = 0;
  private tokens = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  /** Runtime already banked from earlier running spells. */
  private accumulatedMs = 0;
  /** When the current running spell began; null while stopped or paused. */
  private runningSince: number | null = null;
  private warned = new Set<'cost' | 'tokens' | 'runtime'>();
  private hit: WorkBudgetOutcome | null = null;

  constructor(options: WorkBudgetGuardOptions) {
    this.budget = options.budget;
    this.clock = options.clock ?? systemClock;
    this.pricing = options.pricing;
    this.onWarning = options.onWarning;
  }

  static fromJSON(state: WorkBudgetState, options: WorkBudgetGuardOptions): WorkBudgetGuard {
    const guard = new WorkBudgetGuard(options);
    guard.restore(state);
    return guard;
  }

  /**
   * Load banked usage into a guard that already exists.
   *
   * The resume path needs this because the session builds its guard in its
   * constructor, before it has a checkpoint to build one from. Restoring the
   * warned set matters as much as the counters: a run that is resumed four
   * times should not warn the user four times about the same 80%.
   */
  restore(state: WorkBudgetState): void {
    this.costMicroUsd = state.costMicroUsd;
    this.tokens = state.tokens;
    this.inputTokens = state.inputTokens ?? 0;
    this.outputTokens = state.outputTokens ?? 0;
    this.accumulatedMs = state.accumulatedMs;
    this.warned = new Set(state.warned);
  }

  /** Begin (or resume) counting wall-clock time. Idempotent. */
  start(): void {
    if (this.runningSince === null) this.runningSince = this.clock.now();
  }

  /**
   * Stop counting wall-clock time without discarding what has been counted.
   *
   * Called when the run pauses for a question or an approval. Time a person
   * spends deciding is not time the run spent working, and a runtime ceiling
   * that includes it would kill exactly the runs that asked before acting.
   */
  suspend(): void {
    if (this.runningSince === null) return;
    this.accumulatedMs += Math.max(0, this.clock.now() - this.runningSince);
    this.runningSince = null;
  }

  get usage(): BudgetUsage {
    const live = this.runningSince === null ? 0 : Math.max(0, this.clock.now() - this.runningSince);
    return {
      costMicroUsd: this.costMicroUsd,
      tokens: this.tokens,
      runtimeMs: this.accumulatedMs + live,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }

  /** The ceiling that stopped the run, once one has. Sticky. */
  get outcome(): WorkBudgetOutcome | null {
    return this.hit;
  }

  toJSON(): WorkBudgetState {
    // Bank the live spell so a checkpoint taken mid-run does not lose it.
    const usage = this.usage;
    return {
      costMicroUsd: usage.costMicroUsd,
      tokens: usage.tokens,
      accumulatedMs: usage.runtimeMs,
      warned: [...this.warned],
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }

  /** Add one provider request's usage, priced if pricing was supplied. */
  record(step: Usage): void {
    this.inputTokens += step.inputTokens;
    this.outputTokens += step.outputTokens;
    this.tokens += step.inputTokens + step.outputTokens;
    if (!this.pricing) return;
    // Rounded once per step rather than once at the end: the run's recorded
    // cost has to match the sum of the steps a user can be shown, and a total
    // rounded separately from its parts is a total that does not add up.
    this.costMicroUsd += Math.round(
      (step.inputTokens * this.pricing.inputMicroUsdPerMillion) / 1_000_000 +
        (step.outputTokens * this.pricing.outputMicroUsdPerMillion) / 1_000_000,
    );
  }

  /**
   * Whether a ceiling has been reached, warning first if one is close.
   *
   * Safe to call at any point, not only after a provider request: a run that
   * is stuck in long tool calls burns runtime without spending a token, and a
   * check that only ran on token accounting would never fire for it.
   */
  check(): WorkBudgetOutcome | null {
    if (this.hit) return this.hit;
    const usage = this.usage;
    const verdict = budgetExceeded(this.budget, usage);
    if (verdict.exceeded) {
      this.hit = {
        limit: verdict.limit,
        detail: verdict.detail,
        terminalReason: terminalReasonFor(verdict.limit),
      };
      return this.hit;
    }
    this.warnIfClose(usage);
    return null;
  }

  private warnIfClose(usage: BudgetUsage): void {
    if (!this.onWarning) return;
    const ceilings: Array<[('cost' | 'tokens' | 'runtime'), number, number]> = [
      ['cost', this.budget.maxCostMicroUsd, usage.costMicroUsd],
      ['tokens', this.budget.maxTokens, usage.tokens],
      ['runtime', this.budget.maxRuntimeMs, usage.runtimeMs],
    ];
    for (const [limit, ceiling, used] of ceilings) {
      if (ceiling <= 0 || this.warned.has(limit)) continue;
      const fraction = used / ceiling;
      if (fraction < BUDGET_WARNING_FRACTION) continue;
      this.warned.add(limit);
      this.onWarning({
        limit,
        fraction,
        detail: describeApproach(limit, used, ceiling),
      });
    }
  }

  /**
   * The value to pass as `AgentLoopOptions.onStep`.
   *
   * A bound property rather than a method so it can be handed straight to the
   * loop without the caller having to remember to bind it — an unbound method
   * passed here loses `this` and silently never stops anything.
   */
  readonly onStep = (stepUsage: Usage): void | 'stop' => {
    this.record(stepUsage);
    return this.check() ? 'stop' : undefined;
  };
}

function describeApproach(
  limit: 'cost' | 'tokens' | 'runtime',
  used: number,
  ceiling: number,
): string {
  const percent = Math.round((used / ceiling) * 100);
  switch (limit) {
    case 'cost':
      return `Spent ${(used / 1_000_000).toFixed(2)} of a ${(ceiling / 1_000_000).toFixed(2)} USD ceiling (${percent}%).`;
    case 'tokens':
      return `Used ${used} of ${ceiling} tokens (${percent}%).`;
    case 'runtime':
      return `Ran for ${Math.round(used / 1000)}s of a ${Math.round(ceiling / 1000)}s ceiling (${percent}%).`;
  }
}

/**
 * Compose the guard with another `onStep`.
 *
 * The budget's verdict wins: an inner callback that wants to keep going cannot
 * override a ceiling, and an inner callback that wants to stop is honoured.
 * The order matters — the guard runs first so the step's tokens are recorded
 * even when the inner callback ends the turn, otherwise the last step of every
 * stopped run is unaccounted for.
 */
export function withBudget(
  guard: WorkBudgetGuard,
  inner?: (stepUsage: Usage) => void | 'stop',
): (stepUsage: Usage) => void | 'stop' {
  return (stepUsage: Usage) => {
    const stopped = guard.onStep(stepUsage);
    const innerStop = inner?.(stepUsage);
    return stopped === 'stop' || innerStop === 'stop' ? 'stop' : undefined;
  };
}
