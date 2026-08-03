/**
 * Reconciles Juno Code tasks whose runner died before it could say so.
 *
 * A cloud run posts its own terminal `completed`/`failed` status. If the runner
 * is hard-killed first — OOM, a cancelled workflow, the job hitting GitHub's
 * six-hour ceiling, the VM being reclaimed — that post never happens and the
 * task stays `running` forever. The workflow already said so in a comment:
 * "the task simply stays 'running'". Nothing ever moved it, so the UI showed a
 * spinner indefinitely and the row was invisible to every "what failed" query.
 *
 * The rule is deliberately conservative. A task is only swept when it has been
 * silent for longer than any legitimate gap between its events — not merely
 * long-running. A build that streams nothing for eight minutes is normal; one
 * that has streamed nothing for an hour is not coming back.
 *
 * Pure decision logic, free of Prisma and `server-only`, so the policy is
 * testable without a database.
 */

/** Statuses a task can be swept out of. Terminal states are never touched. */
export const SWEEPABLE_STATUSES = ["queued", "running"] as const;
export type SweepableStatus = (typeof SWEEPABLE_STATUSES)[number];

/**
 * How long a task may be silent before it is presumed dead.
 *
 * `running` gets the longer window because a running task legitimately goes
 * quiet — a long compile, a slow test suite, a model call against an
 * overloaded provider. `queued` gets a shorter one because a queued task that
 * nothing has claimed is not doing anything at all.
 */
export const SILENCE_LIMIT_MS: Record<SweepableStatus, number> = {
  queued: 30 * 60 * 1000,
  running: 60 * 60 * 1000,
};

/**
 * The hard ceiling on a cloud run, past which it cannot still be alive.
 *
 * GitHub cancels a job at six hours. A task still `running` beyond that plus a
 * margin has definitively lost its runner, however recently it last spoke.
 */
export const ABSOLUTE_RUN_LIMIT_MS = 7 * 60 * 60 * 1000;

export type StopReason =
  | "runner_lost"
  | "never_claimed"
  | "exceeded_time_limit";

export interface SweepCandidate {
  id: string;
  status: string;
  createdAt: Date;
  /** Last time anything was written for this task. */
  updatedAt: Date;
  /** Null for a cloud task whose runner never exchanged its dispatch code. */
  runnerClaimedAt: Date | null;
  target: string;
}

export interface SweepVerdict {
  sweep: boolean;
  reason?: StopReason;
  /** Operator-facing sentence. Carries no prompt or output. */
  message?: string;
}

/**
 * Decides whether one task is stuck.
 *
 * Returning an authoritative reason rather than a bare "failed" is the point:
 * "the runner was lost" and "this was never picked up" are different problems
 * with different fixes, and collapsing them into one status is how a systemic
 * dispatch failure hides inside a pile of ordinary run failures.
 */
export function assessTask(task: SweepCandidate, now: Date = new Date()): SweepVerdict {
  if (!(SWEEPABLE_STATUSES as readonly string[]).includes(task.status)) {
    return { sweep: false };
  }

  const age = now.getTime() - task.createdAt.getTime();
  const silence = now.getTime() - task.updatedAt.getTime();

  if (task.status === "running" && age > ABSOLUTE_RUN_LIMIT_MS) {
    return {
      sweep: true,
      reason: "exceeded_time_limit",
      message:
        "The run passed the maximum time a cloud job can survive, so its runner no longer exists.",
    };
  }

  const limit = SILENCE_LIMIT_MS[task.status as SweepableStatus];
  if (silence <= limit) return { sweep: false };

  // A cloud task that never exchanged its dispatch code was never picked up by
  // any runner — the dispatch itself failed. That is a different failure from a
  // runner that started and then died.
  if (task.target === "cloud" && task.runnerClaimedAt === null) {
    return {
      sweep: true,
      reason: "never_claimed",
      message:
        "No runner ever claimed this task. The workflow dispatch did not reach a runner, or the run failed before it started.",
    };
  }

  return {
    sweep: true,
    reason: "runner_lost",
    message:
      "The runner stopped reporting and did not post a final status. It was most likely cancelled, killed, or ran out of memory.",
  };
}

/** Filters a batch, keeping only the tasks that should be swept. */
export function selectStuckTasks(
  tasks: readonly SweepCandidate[],
  now: Date = new Date()
): Array<{ task: SweepCandidate; verdict: SweepVerdict }> {
  return tasks
    .map((task) => ({ task, verdict: assessTask(task, now) }))
    .filter((entry) => entry.verdict.sweep);
}

/** The oldest `updatedAt` still considered alive — the sweeper's query bound. */
export function sweepCutoff(now: Date = new Date()): Date {
  const longest = Math.max(...Object.values(SILENCE_LIMIT_MS));
  return new Date(now.getTime() - longest);
}
