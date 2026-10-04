/**
 * Measured routing evidence, and how the router is allowed to believe it
 * (BRIEF §26).
 *
 * Telemetry rows (`RoutingOutcome`) aggregate into one cell per
 * (model, task class). The router never reads a cell raw: a model that
 * answered three everyday prompts well has not shown it is better than its
 * prior, it has shown three prompts. So:
 *
 *   - below `MIN_SAMPLES` a cell is ignored entirely (the prior stands);
 *   - above it, every rate is shrunk toward the prior with a pseudo-count of
 *     `PRIOR_STRENGTH` — a Beta/Bayesian average. 30 observations move the
 *     estimate halfway to the measured rate; 300 move it 90%.
 *
 * Pure: the database read that fills `EvidenceTable` lives in
 * `telemetry-store.ts`.
 */

import type { TaskClass } from "@/lib/router/task-class";

export const MIN_SAMPLES = 20;
export const PRIOR_STRENGTH = 30;

/** One aggregate cell. Sums, not means, so cells merge exactly. */
export interface EvidenceCell {
  modelId: string;
  taskClass: TaskClass;
  /** Turns observed. */
  n: number;
  /** Turns that completed and were kept (not regenerated, switched, edited, thumbed down). */
  successes: number;
  toolRoundsSum: number;
  retriesSum: number;
  latencyMsSum: number;
  /** Turns that had a latency measurement. */
  latencyN: number;
  costMicroUsdSum: number;
  /** Turns that had a cost. */
  costN: number;
}

export type EvidenceTable = ReadonlyMap<string, EvidenceCell>;

export function evidenceKey(modelId: string, taskClass: TaskClass): string {
  return `${modelId}\u0000${taskClass}`;
}

export function emptyEvidence(): EvidenceTable {
  return new Map();
}

/** Shrink an observed rate toward the prior. */
export function shrink(observedSum: number, n: number, prior: number, strength = PRIOR_STRENGTH): number {
  if (n <= 0) return prior;
  return (observedSum + strength * prior) / (n + strength);
}

export interface Posterior {
  success: number;
  toolRounds: number;
  retries: number;
  /** True when evidence moved the numbers; false when the prior stood alone. */
  measured: boolean;
  n: number;
}

export function posterior(
  cell: EvidenceCell | undefined,
  prior: { success: number; toolRounds: number; retries: number }
): Posterior {
  if (!cell || cell.n < MIN_SAMPLES) {
    return { ...prior, measured: false, n: cell?.n ?? 0 };
  }
  return {
    success: shrink(cell.successes, cell.n, prior.success),
    toolRounds: shrink(cell.toolRoundsSum, cell.n, prior.toolRounds),
    retries: shrink(cell.retriesSum, cell.n, prior.retries),
    measured: true,
    n: cell.n,
  };
}

/** What a telemetry row contributes to success. The one definition, shared with the store. */
export function outcomeSucceeded(row: {
  completionState: string;
  userRegenerated: boolean;
  userSwitchedModel: boolean;
  userEdited: boolean;
  feedback: string | null;
}): boolean {
  return (
    row.completionState === "completed" &&
    !row.userRegenerated &&
    !row.userSwitchedModel &&
    !row.userEdited &&
    row.feedback !== "DOWN"
  );
}

/** Fold rows into cells (used by tests, the eval harness and the store's in-memory path). */
export function aggregateOutcomes(
  rows: ReadonlyArray<{
    modelId: string;
    taskClass: TaskClass;
    completionState: string;
    userRegenerated: boolean;
    userSwitchedModel: boolean;
    userEdited: boolean;
    feedback: string | null;
    toolRounds: number;
    retryCount: number;
    latencyMs: number | null;
    costMicroUsd: number | null;
  }>
): Map<string, EvidenceCell> {
  const table = new Map<string, EvidenceCell>();
  for (const row of rows) {
    const key = evidenceKey(row.modelId, row.taskClass);
    const cell =
      table.get(key) ??
      ({
        modelId: row.modelId,
        taskClass: row.taskClass,
        n: 0,
        successes: 0,
        toolRoundsSum: 0,
        retriesSum: 0,
        latencyMsSum: 0,
        latencyN: 0,
        costMicroUsdSum: 0,
        costN: 0,
      } satisfies EvidenceCell);
    cell.n += 1;
    if (outcomeSucceeded(row)) cell.successes += 1;
    cell.toolRoundsSum += row.toolRounds;
    cell.retriesSum += row.retryCount;
    if (row.latencyMs != null) {
      cell.latencyMsSum += row.latencyMs;
      cell.latencyN += 1;
    }
    if (row.costMicroUsd != null) {
      cell.costMicroUsdSum += row.costMicroUsd;
      cell.costN += 1;
    }
    table.set(key, cell);
  }
  return table;
}
