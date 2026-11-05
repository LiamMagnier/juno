/**
 * The one place a run's state is decided. Everything that reports a result
 * reads it from here, so "passed" means the same thing in every table.
 */

import type { CheckResult, RunState } from "./types";

export type ExecutorOutcome =
  | { kind: "completed" }
  | { kind: "errored"; error: string }
  | { kind: "timeout"; error: string };

export interface Verdict {
  state: RunState;
  reason: string;
}

/**
 * completed + every check passed                → passed
 * completed + any check failed                  → failed  (the deliverable is wrong)
 * completed + no failure, some check not_run    → unverified (could not fully check)
 * completed + no checks at all                  → unverified (nothing judged it)
 * errored / timeout                             → failed  (the product did not deliver)
 */
export function deriveVerdict(outcome: ExecutorOutcome, checks: CheckResult[]): Verdict {
  if (outcome.kind !== "completed") {
    return { state: "failed", reason: outcome.kind === "timeout" ? `timed out: ${outcome.error}` : `product error: ${outcome.error}` };
  }
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length) {
    return { state: "failed", reason: `${failed.length} check(s) failed — ${failed.slice(0, 3).map((c) => `${c.id}: ${c.detail}`).join("; ")}` };
  }
  const pending = checks.filter((c) => c.status === "not_run");
  if (pending.length) {
    return { state: "unverified", reason: `${checks.length - pending.length}/${checks.length} checks passed; not run: ${pending.map((c) => c.detail).join("; ")}` };
  }
  if (checks.length === 0) return { state: "unverified", reason: "no validator applied to this run" };
  return { state: "passed", reason: `${checks.length}/${checks.length} checks passed` };
}
