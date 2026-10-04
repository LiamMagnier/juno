/**
 * The work ledger's task board: one durable vocabulary over Work sessions.
 *
 * Work already persists everything a durable task needs (src/lib/work/store.ts):
 * an append-only event log per run, lease-fenced claims renewed by the
 * executor's heartbeat, checkpoints, attempts, write-once terminal reasons and
 * a sweep that ends runs whose executor died. What it did not have was the
 * board's vocabulary, dependencies, deadlines and completion criteria. This
 * module is the vocabulary, as a pure projection of the rows, so there is one
 * queue (the Work runs) and one place that decides what a task "is".
 *
 *   pending                 queued or drafted, free to start
 *   claimed                 an executor holds the lease and is preparing
 *   running                 an executor holds the lease and is working
 *   waiting_for_user        a question, an approval, or a pause the person chose
 *   waiting_for_dependency  a task it depends on has not completed yet
 *   blocked                 cannot progress without a decision: a dependency
 *                           failed, the host is offline, the budget ran out, or
 *                           the executor died after it had already done something
 *   completed | failed | cancelled
 *
 * Client-safe: no database, no server imports.
 */

export const TASK_BOARD_STATES = [
  "pending",
  "claimed",
  "running",
  "waiting_for_user",
  "waiting_for_dependency",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskBoardState = (typeof TASK_BOARD_STATES)[number];

export const TASK_BOARD_TERMINAL: readonly TaskBoardState[] = ["completed", "failed", "cancelled"];

/** At most this many dependencies per task, so a board cannot be made into an unbounded graph. */
export const MAX_TASK_DEPENDENCIES = 8;

export interface BoardTaskInput {
  id: string;
  /** WorkSession.status (denormalised from the current run). */
  status: string;
  dependsOnSessionIds?: readonly string[];
  deadlineAt?: Date | string | null;
  /** The current run's lease, when one is held. */
  leaseExpiresAt?: Date | string | null;
}

export interface BoardTask {
  id: string;
  state: TaskBoardState;
  /** True when a deadline has passed and the task is not finished. Nothing is killed for it. */
  overdue: boolean;
  /** True when a live run's lease has lapsed: the reclaim sweep will end it as interrupted. */
  stale: boolean;
  /** The dependencies still holding it, by id. */
  waitingOn: string[];
}

function time(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The board state of one Work status, before dependencies are considered. */
export function boardStateForWorkStatus(status: string): TaskBoardState {
  switch (status) {
    case "draft":
    case "queued":
      return "pending";
    case "preparing":
      return "claimed";
    case "running":
      return "running";
    case "waiting_input":
    case "waiting_approval":
    case "paused":
      return "waiting_for_user";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
      return "failed";
    // A run that was interrupted, ran out of budget or lost its host stopped
    // without deciding anything; it waits for a decision with an owner.
    case "interrupted":
    case "budget_exceeded":
    case "host_offline":
      return "blocked";
    default:
      return "blocked";
  }
}

/**
 * Every task's board state, with dependencies resolved against the others in
 * the same list. A dependency outside the list is treated as unmet (the
 * caller should pass it in); a cycle cannot form because
 * `validateDependencies` refuses it on write.
 */
export function projectTaskBoard(tasks: readonly BoardTaskInput[], now = new Date()): BoardTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => {
    let state = boardStateForWorkStatus(task.status);
    const waitingOn: string[] = [];
    if (state === "pending") {
      for (const depId of task.dependsOnSessionIds ?? []) {
        const dep = byId.get(depId);
        const depState = dep ? boardStateForWorkStatus(dep.status) : "pending";
        if (depState === "completed") continue;
        if (depState === "failed" || depState === "cancelled") {
          state = "blocked";
        } else if (state !== "blocked") {
          state = "waiting_for_dependency";
        }
        waitingOn.push(depId);
      }
    }
    const deadline = time(task.deadlineAt);
    const lease = time(task.leaseExpiresAt);
    return {
      id: task.id,
      state,
      overdue: deadline !== null && deadline < now.getTime() && !TASK_BOARD_TERMINAL.includes(state),
      stale: (state === "claimed" || state === "running" || state === "waiting_for_user") && lease !== null && lease < now.getTime(),
      waitingOn,
    };
  });
}

/**
 * Whether a task's dependencies let it start. `completed` (the default) needs
 * every dependency completed; `settled` needs every one ended, however it
 * ended. A dependency that no longer exists (deleted, or another account's id
 * that was never readable) is unmet: refusing is the safe reading.
 */
export function dependenciesSatisfied(input: {
  mode: string;
  expected: number;
  statuses: readonly string[];
}): boolean {
  if (input.expected === 0) return true;
  if (input.statuses.length < input.expected) return false;
  return input.statuses.every((status) => {
    const state = boardStateForWorkStatus(status);
    if (input.mode === "settled") return TASK_BOARD_TERMINAL.includes(state) || state === "blocked";
    return state === "completed";
  });
}

export type DependencyRefusal = "too_many" | "self" | "unknown" | "cycle";

/**
 * Whether `taskId` may depend on `dependsOn`, given every existing task's
 * dependencies (same account). Refuses self-dependency, unknown ids, more than
 * `MAX_TASK_DEPENDENCIES`, and anything that would close a cycle.
 */
export function validateDependencies(input: {
  taskId: string;
  dependsOn: readonly string[];
  existing: ReadonlyMap<string, readonly string[]>;
}): { ok: true; dependsOn: string[] } | { ok: false; reason: DependencyRefusal } {
  const deps = [...new Set(input.dependsOn)];
  if (deps.length > MAX_TASK_DEPENDENCIES) return { ok: false, reason: "too_many" };
  if (deps.includes(input.taskId)) return { ok: false, reason: "self" };
  if (deps.some((id) => !input.existing.has(id))) return { ok: false, reason: "unknown" };
  // Would any dependency (transitively) reach back to taskId?
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === input.taskId) return { ok: false, reason: "cycle" };
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of input.existing.get(id) ?? []) stack.push(next);
  }
  return { ok: true, dependsOn: deps };
}

/** "Waiting for your approval", "Blocked: a task it depends on failed". Plain words for a board row. */
export function boardStateSentence(task: Pick<BoardTask, "state" | "overdue" | "stale" | "waitingOn">): string {
  const base: Record<TaskBoardState, string> = {
    pending: "Ready to start",
    claimed: "Starting",
    running: "Working",
    waiting_for_user: "Waiting for you",
    waiting_for_dependency: task.waitingOn.length === 1 ? "Waiting for another task to finish" : `Waiting for ${task.waitingOn.length} other tasks to finish`,
    blocked: "Stopped, needs a decision",
    completed: "Done",
    failed: "Didn't finish",
    cancelled: "Cancelled",
  };
  let sentence = base[task.state];
  if (task.stale) sentence = "Lost contact with the worker; it will be marked interrupted";
  if (task.overdue) sentence += " · past its deadline";
  return sentence;
}
