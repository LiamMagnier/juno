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
 * Two kinds of measurement, believed at two levels:
 *
 *   - QUALITY (kept vs. regenerated, switched away from, edited and re-sent,
 *     thumbed down) depends on the task, so it is only read per cell.
 *   - RELIABILITY (the turn errored or was cut off) is mostly a property of
 *     the model and its provider, whatever was asked. A cell too thin to
 *     trust on its own still moves when the same model is failing across
 *     every task class: `modelReliability` pools errors per model, and
 *     `posterior` applies the shrunk error rate to the prior. Without it a
 *     model erroring on a third of all turns kept its catalogue odds until
 *     twenty of those failures landed in one class.
 *
 * Measured latency (completed turns only) replaces the latency prior the same
 * way: shrunk, and only above the sample guard (`posteriorLatency`).
 *
 * Pure: the database read that fills `EvidenceTable` lives in
 * `telemetry-store.ts`.
 */

import type { TaskClass } from "@/lib/router/task-class";

export const MIN_SAMPLES = 20;
export const PRIOR_STRENGTH = 30;
/**
 * The share of turns a healthy model is assumed to lose to an error or a cut
 * connection before anything is measured. The reliability adjustment is
 * relative to it, so a model measured at exactly this rate keeps its prior.
 */
export const PRIOR_ERROR_RATE = 0.03;

/** One aggregate cell. Sums, not means, so cells merge exactly. */
export interface EvidenceCell {
  modelId: string;
  taskClass: TaskClass;
  /** Turns observed. */
  n: number;
  /** Turns that completed and were kept (not regenerated, switched, edited, thumbed down). */
  successes: number;
  /** Turns that ended in an error or a cut-off connection (`outcomeErrored`). */
  errors: number;
  toolRoundsSum: number;
  retriesSum: number;
  /** Wall time of COMPLETED turns only: a turn that failed fast says nothing about speed. */
  latencyMsSum: number;
  /** Completed turns that had a latency measurement. */
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

/** Where a candidate's numbers came from. */
export type EvidenceSource = "prior" | "measured" | "reliability";

export interface Posterior {
  success: number;
  toolRounds: number;
  retries: number;
  /** True when this (model, task class) cell moved the numbers; false otherwise. */
  measured: boolean;
  /**
   * "measured": the cell itself. "reliability": the cell was too thin, but the
   * model's error rate across every task class moved the success odds.
   * "prior": nothing measured was believed.
   */
  source: EvidenceSource;
  /** Turns behind `source` (the cell's for measured, the model's for reliability). */
  n: number;
}

/** One model's reliability across every task class. */
export interface ModelReliability {
  modelId: string;
  n: number;
  errors: number;
}

/** Pool the cells per model (reliability does not depend on the task class). */
export function modelReliability(evidence: EvidenceTable): Map<string, ModelReliability> {
  const out = new Map<string, ModelReliability>();
  for (const cell of evidence.values()) {
    const entry = out.get(cell.modelId) ?? { modelId: cell.modelId, n: 0, errors: 0 };
    entry.n += cell.n;
    entry.errors += cell.errors;
    out.set(cell.modelId, entry);
  }
  return out;
}

/**
 * The multiplier a model's measured error rate puts on its prior success,
 * or null below the sample guard. Shrunk toward `PRIOR_ERROR_RATE`, so 20
 * clean turns barely move it and 300 erroring ones move it most of the way.
 */
export function reliabilityFactor(model: ModelReliability | undefined): number | null {
  if (!model || model.n < MIN_SAMPLES) return null;
  const errorRate = shrink(model.errors, model.n, PRIOR_ERROR_RATE);
  return (1 - errorRate) / (1 - PRIOR_ERROR_RATE);
}

export function posterior(
  cell: EvidenceCell | undefined,
  prior: { success: number; toolRounds: number; retries: number },
  model?: ModelReliability
): Posterior {
  if (!cell || cell.n < MIN_SAMPLES) {
    // The cell's own successes already count its errors, so the pooled
    // reliability only stands in when the cell is not believed — never both.
    const factor = reliabilityFactor(model);
    if (factor != null) {
      return {
        ...prior,
        success: Math.max(0.01, Math.min(0.99, prior.success * factor)),
        measured: false,
        source: "reliability",
        n: model!.n,
      };
    }
    return { ...prior, measured: false, source: "prior", n: cell?.n ?? 0 };
  }
  return {
    success: shrink(cell.successes, cell.n, prior.success),
    toolRounds: shrink(cell.toolRoundsSum, cell.n, prior.toolRounds),
    retries: shrink(cell.retriesSum, cell.n, prior.retries),
    measured: true,
    source: "measured",
    n: cell.n,
  };
}

/**
 * Seconds to a complete answer: the measured mean of this cell's completed
 * turns, shrunk toward the prior, once enough of them carry a measurement.
 */
export function posteriorLatency(cell: EvidenceCell | undefined, priorSeconds: number): { seconds: number; measured: boolean } {
  if (!cell || cell.latencyN < MIN_SAMPLES) return { seconds: priorSeconds, measured: false };
  return { seconds: shrink(cell.latencyMsSum / 1000, cell.latencyN, priorSeconds), measured: true };
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

/**
 * What a telemetry row contributes to reliability: the turn ended in an error
 * (provider error, stall, refusal filter, context overflow, length cut) or a
 * dropped connection that left only a partial answer. A Stop is the reader's
 * choice, not an error. The one definition, shared with the store's SQL.
 */
export function outcomeErrored(row: { completionState: string }): boolean {
  return row.completionState === "failed" || row.completionState === "partial";
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
        errors: 0,
        toolRoundsSum: 0,
        retriesSum: 0,
        latencyMsSum: 0,
        latencyN: 0,
        costMicroUsdSum: 0,
        costN: 0,
      } satisfies EvidenceCell);
    cell.n += 1;
    if (outcomeSucceeded(row)) cell.successes += 1;
    if (outcomeErrored(row)) cell.errors += 1;
    cell.toolRoundsSum += row.toolRounds;
    cell.retriesSum += row.retryCount;
    if (row.latencyMs != null && row.completionState === "completed") {
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
