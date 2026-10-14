/**
 * Cost per accepted result: what it costs, per task class, to get one answer
 * the person kept.
 *
 * A cheaper request is not a cheaper result when it needs a regenerate, a
 * model switch or a rewritten prompt to land. This divides EVERYTHING spent on
 * a task class (accepted turns and the discarded attempts alike) by the turns
 * that were accepted.
 *
 * "Accepted" is not a new quality signal. It is the router's existing outcome
 * rule, `outcomeSucceeded` (src/lib/router/evidence.ts): the turn completed and
 * was not regenerated, switched away from, edited and re-sent, or thumbed down.
 * The inputs are the router's existing aggregate cells (`EvidenceCell`, from
 * `RoutingOutcome` rows: saved chats only, no content, no user link), so the
 * metric needs no new collection.
 *
 * Turns without a recorded cost are not counted as free: the cost total is
 * scaled up from the turns that have one (`costCoverage` says how many did),
 * and is null when none did.
 *
 * Pure.
 */
import type { EvidenceCell } from "@/lib/router/evidence";

export interface CostPerAcceptedRow {
  taskClass: string;
  /** null on the per-task rollup; the model id on a per-model row. */
  modelId: string | null;
  turns: number;
  accepted: number;
  acceptanceRate: number | null;
  /** Estimated USD spent on all turns (see coverage). */
  totalCostUsd: number | null;
  /** totalCostUsd / accepted, or null with nothing accepted or no cost. */
  costPerAcceptedUsd: number | null;
  /** Share of turns that carried a recorded cost. */
  costCoverage: number;
}

function row(taskClass: string, modelId: string | null, cells: readonly EvidenceCell[]): CostPerAcceptedRow {
  let turns = 0;
  let accepted = 0;
  let costMicro = 0;
  let costN = 0;
  for (const cell of cells) {
    turns += cell.n;
    accepted += cell.successes;
    costMicro += cell.costMicroUsdSum;
    costN += cell.costN;
  }
  const totalCostUsd = costN > 0 ? (costMicro / 1_000_000) * (turns / costN) : null;
  return {
    taskClass,
    modelId,
    turns,
    accepted,
    acceptanceRate: turns > 0 ? accepted / turns : null,
    totalCostUsd,
    costPerAcceptedUsd: totalCostUsd != null && accepted > 0 ? totalCostUsd / accepted : null,
    costCoverage: turns > 0 ? costN / turns : 0,
  };
}

/**
 * One rollup row per task class, each followed by its per-model rows (most
 * turns first), sorted by task class.
 */
export function costPerAcceptedResult(cells: Iterable<EvidenceCell>): CostPerAcceptedRow[] {
  const byTask = new Map<string, EvidenceCell[]>();
  for (const cell of cells) {
    const list = byTask.get(cell.taskClass) ?? [];
    list.push(cell);
    byTask.set(cell.taskClass, list);
  }
  const out: CostPerAcceptedRow[] = [];
  for (const taskClass of [...byTask.keys()].sort()) {
    const list = byTask.get(taskClass)!;
    out.push(row(taskClass, null, list));
    const byModel = new Map<string, EvidenceCell[]>();
    for (const cell of list) byModel.set(cell.modelId, [...(byModel.get(cell.modelId) ?? []), cell]);
    const models = [...byModel.entries()].map(([modelId, group]) => row(taskClass, modelId, group));
    models.sort((a, b) => b.turns - a.turns || a.modelId!.localeCompare(b.modelId!));
    out.push(...models);
  }
  return out;
}
