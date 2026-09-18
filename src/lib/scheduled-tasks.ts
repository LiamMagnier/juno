import type { ScheduledTask, ScheduledTaskRun } from "@prisma/client";
import { resolveModel } from "@/lib/models";
import { decryptField } from "@/lib/field-crypto";

/*
 * Scheduled tasks — what is left of them.
 *
 * The feature is retired: Automations (`WorkSchedule`) is the one answer to
 * "run this for me later", `scripts/work-scheduler.ts` adopts every remaining
 * row into one, and `/api/tasks` no longer creates anything. The note at the
 * top of `src/app/api/tasks/route.ts` says what happened to the rows and why.
 *
 * What survives is the read side: the columns a client still lists, and the
 * cadence arithmetic the migration reads them through. Three things went with
 * the executor, and each is worth naming because each was a real thing.
 *
 *   `executeTask`, the second agent loop in this codebase — a prompt, a
 *   `streamChat` collected rather than forwarded, its own spend ledger entry
 *   and its own push notification. Everything it did, a Work run does with a
 *   plan, a budget, an approval path and a transcript somebody can read.
 *
 *   `taskLimitForPlan` — FREE 0, PRO 3, MAX 10 — the only cap Juno had on how
 *   many things could be running for you on a clock. `WorkSchedule` has never
 *   had one, so retiring this retires the cap: what an account may spend is
 *   its usage window, not a count of automations.
 *
 *   The `juno-scheduler` PM2 worker, which was the second dispatcher. Two
 *   dispatchers holding one fire is how an adopted task ran twice a day.
 */

// ---------------------------------------------------------------------------
// Cadence math (pure — lives in scheduled-task-cadence.ts, re-exported here so
// routes and the worker keep a single import site for the whole feature)
// ---------------------------------------------------------------------------

export {
  DEFAULT_TASK_TIMEZONE,
  computeNextRunAt,
  isValidTimezone,
  onceRunInstant,
} from "@/lib/scheduled-task-cadence";
export type { TaskScheduleInput } from "@/lib/scheduled-task-cadence";

// ---------------------------------------------------------------------------
// API serialization (shared by /api/tasks and /api/tasks/[id])
// ---------------------------------------------------------------------------

export type TaskWithLatestRun = ScheduledTask & { runs: ScheduledTaskRun[] };

export function serializeTask(task: TaskWithLatestRun) {
  const run = task.runs[0] ?? null;
  return {
    id: task.id,
    name: task.name,
    // Encrypted at rest (field-crypto.ts) — a task prompt is a standing
    // instruction the user wrote, often naming people, accounts or projects.
    prompt: decryptField(task.prompt),
    model: task.model,
    modelName: resolveModel(task.model)?.name ?? task.model,
    cadence: task.cadence,
    hour: task.hour,
    minute: task.minute,
    weekday: task.weekday,
    monthday: task.monthday,
    onDate: task.onDate,
    timezone: task.timezone,
    webSearch: task.webSearch,
    enabled: task.enabled,
    lastRunAt: task.lastRunAt?.toISOString() ?? null,
    nextRunAt: task.nextRunAt.toISOString(),
    conversationId: task.conversationId,
    createdAt: task.createdAt.toISOString(),
    latestRun: run
      ? {
          id: run.id,
          status: run.status,
          error: run.error,
          costMicroUsd: run.costMicroUsd,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/** Prisma include that pairs each task with its most recent run. */
export const LATEST_RUN_INCLUDE = {
  runs: { orderBy: { startedAt: "desc" as const }, take: 1 },
};
