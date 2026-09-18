/**
 * The routine scheduler — the one process in Juno that answers "run this for me
 * later".
 *
 * Decides which routines are due, starts their runs, and adopts the legacy
 * `ScheduledTask` rows as it goes. Run it the way the other two workers are
 * run:
 *
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/work-scheduler.ts
 *
 * It dispatches; it does not execute. A Work routine firing produces a queued
 * `WorkRun`, which `scripts/work-runner.ts` (cloud) or the paired Mac (local)
 * claims through its own lease. A Code routine firing produces a `CodeTask` in
 * a conversation of its own and asks GitHub Actions for a runner. Keeping
 * dispatch and execution apart is what lets an executor be restarted, scaled or
 * replaced without any routine being missed, and what lets this process finish
 * a tick in milliseconds no matter how long the work it started takes.
 *
 * TWO KINDS OF FIRE, ONE CLOCK
 *
 * `WorkSchedule.runKind` decides what a fire produces. Everything before that
 * decision — the trigger set, the zone and its daylight-saving edges, the
 * catch-up policy, the lease, the pause, the concurrency caps, the budget
 * admission — is the same question for both, and the branch is one `if` in
 * `dispatchOne` plus a different table to count in flight. A second scheduler
 * for Code would have been a second implementation of the arithmetic in
 * `src/lib/work/schedule.ts`, which is the part that is genuinely hard to get
 * right and the part nobody would have ported twice.
 *
 * Four properties are the whole design, and each one is a bug in the scheduler
 * this replaces:
 *
 *   It leases. `lockedUntil` is taken with a conditional UPDATE whose WHERE
 *   contains the condition, so exactly one scheduler wins a fire, and the lease
 *   expires so a scheduler killed mid-dispatch does not strand the schedule.
 *   The legacy runner's only mechanism was an atomic `nextRunAt` bump, which
 *   cannot express "being worked on" at all.
 *
 *   It advances a schedule only when the fire has actually been dealt with. A
 *   run held back by concurrency, or by a Mac that is asleep, keeps its
 *   `nextRunAt`, so the fire stays owed instead of being silently consumed.
 *
 *   It distinguishes its outcomes. Delayed, skipped, budget-blocked and failed
 *   are four different things that need four different responses from the user,
 *   and three of them are not failures. The two that mean "this fire will not
 *   happen" are written down as finished runs, so a schedule that has been
 *   quietly skipping for a fortnight does not look identical to one that has
 *   been running fine.
 *
 *   It never widens what an unattended run may do. The policy on the schedule
 *   is stamped onto every run it starts, and `WORK_UNATTENDED_POLICIES` has no
 *   member that grants anything. Nobody watching is not consent.
 */

import "server-only";

import { prisma, prismaUnguarded } from "@/lib/db";
import { getUserPlan } from "@/lib/usage";
import { checkBudget } from "@/lib/spend";
import { unattendedRunCeiling } from "@/lib/spend-ceiling";
import { runBudgetForPlan } from "@/lib/work/budget";
import {
  createRun,
  createWorkSession,
  appendEvents,
  finishRun,
  recordRunInputsFromGrants,
  sweepExpiredCheckpoints,
} from "@/lib/work/store";
import {
  WORK_LIVE_STATUSES,
  defaultVisibilityFor,
  narrowestBudget,
  narrowestPolicy,
  type WorkTerminalReason,
} from "@/lib/work/domain";
import {
  DEFAULT_USER_CONCURRENCY_CAP,
  SCHEDULE_LOCK_MS,
  hostCapabilityView,
  hostOfflinePolicyOf,
  missedRunPolicyOf,
  nextFireForTriggers,
  parseScheduleRunConfig,
  permissionPolicyOf,
  planScheduleDispatch,
  planTaskMigration,
  scheduleRunIdempotencyKey,
  scheduleTargetOf,
  triggerOwningFire,
  unattendedPolicyOf,
  type JsonObject,
  type WorkTriggerRow,
} from "@/lib/work/schedule";
import { decryptField } from "@/lib/field-crypto";
import { LIVE_CODE_TASK_STATUSES, scheduleRunKindOf } from "@/lib/work/code-routine";
import { startCodeRoutineRun } from "@/lib/work/code-dispatch";
import { effectiveHostState } from "@/app/api/work/protocol";
import { Prisma, type Plan } from "@prisma/client";

/** How often to look for due schedules. Well under the shortest cadence a user
 *  can express (`hourly`), and short enough that `MISSED_RUN_GRACE_MS` is never
 *  reached by a scheduler that is simply busy. */
const TICK_MS = 15_000;
/**
 * How long to hold a routine whose `runKind` this build cannot read.
 *
 * Five minutes: long enough that a mixed-version deployment does not spend a
 * tick every fifteen seconds on rows it will never dispatch, short enough that
 * the fire is picked up promptly once the deployment that understands it is
 * the one holding the lease.
 */
const UNKNOWN_RUN_KIND_RETRY_MS = 5 * 60_000;
/** Schedules examined per tick. A cap, not a throughput target: the work of a
 *  tick is bounded so one account with a hundred schedules cannot starve the
 *  rest. */
const MAX_SCHEDULES_PER_TICK = 25;
/** How often to look for legacy tasks that have not been adopted yet. */
const MIGRATION_SWEEP_MS = 5 * 60_000;
/** Legacy tasks examined per sweep. */
const MIGRATION_PAGE = 100;
/**
 * How often to expire the checkpoints of resumable runs nobody came back to.
 *
 * Hourly, against a retention window measured in days: the sweep only has to be
 * frequent enough that the window is roughly the window, and every extra pass is
 * a table scan bought for nothing.
 */
const CHECKPOINT_SWEEP_MS = 60 * 60_000;

/** A stable identity for this scheduler, recorded on everything it decides. */
const SCHEDULER_ID = `work-scheduler:${process.pid}:${process.env.HOSTNAME ?? "local"}`;

let stopping = false;
let nextMigrationSweepAt = 0;
let nextCheckpointSweepAt = 0;
/** Where the last migration sweep stopped. See `sweepMigrations`. */
let migrationCursor: string | null = null;

function log(message: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[work-scheduler] ${message}${suffix}`);
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** One account's two dispatch-time facts, read together. */
interface AccountLimits {
  plan: Plan;
  remainingMicroUsd: number | null;
}

/**
 * What each account is on, and what it may still spend, for the length of one
 * tick.
 *
 * Ten schedules belonging to one user become one read rather than ten, and the
 * staleness that buys is bounded by the tick. Nothing here enforces the budget
 * — the executor does, per token — so a figure a few seconds old can only
 * affect whether a run is started, never whether it overspends.
 *
 * The plan is kept rather than discarded, and that is why this cache holds a
 * record instead of a number. `runBudgetForPlan` needs it at dispatch, and a
 * second `getUserPlan` there would be a second read of the same row — worse, a
 * read that could disagree with the one the admission check was made against if
 * the subscription lapsed between them.
 */
async function accountLimits(
  userId: string,
  cache: Map<string, AccountLimits>
): Promise<AccountLimits> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  const plan = await getUserPlan(userId);
  const status = await checkBudget(userId, plan);
  const limits: AccountLimits = { plan, remainingMicroUsd: status.remainingMicroUsd };
  cache.set(userId, limits);
  return limits;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * The session id a migrated task lands on.
 *
 * Derived from the task rather than allocated, so two schedulers adopting the
 * same task at once collide on the primary key instead of producing two
 * sessions for one task. Prefixed and bounded like the ids the sessions route
 * mints, and containing the task id verbatim, so a support question about
 * "which session is this task now" is answerable by looking.
 */
function migratedSessionId(taskId: string): string {
  return `wsi_task_${taskId}`.slice(0, 190);
}

/**
 * Adopts legacy `ScheduledTask` rows that have no `WorkSchedule` yet.
 *
 * Runs periodically rather than once at startup. `/api/tasks` no longer creates
 * anything — the surface is retired and the route answers 410 — so the set this
 * walks is now closed, but a sweep that ran only at boot would still be wrong:
 * a deployment restarted between two adoptions would leave the rest of the
 * table to the next restart, and the rows it had not reached would be running
 * on a worker that no longer exists.
 *
 * Re-running is safe by construction. The unique index on
 * `WorkSchedule.legacyScheduledTaskId` is what makes it so, not this function's
 * pre-read: the read is an optimisation that keeps the common sweep from
 * attempting inserts it knows will fail.
 *
 * One page per sweep, walked by a cursor that wraps at the end. Reading only
 * the oldest page every time would be worse than useless once those are all
 * adopted — the sweep would find nothing to do for ever while newer tasks it
 * never reaches go unmigrated — and reading the whole table every five minutes
 * to avoid that is a full scan in exchange for nothing.
 */
async function sweepMigrations(): Promise<void> {
  // Cross-account by nature: this walks every user's legacy tasks, so it says
  // so rather than tripping a guard whose entire job is to notice a query that
  // forgot its userId.
  const tasks = await prismaUnguarded.scheduledTask.findMany({
    // By id rather than by creation time, because the cursor needs a total
    // order it can resume from and two tasks created in the same millisecond
    // would otherwise be an ambiguous resume point.
    orderBy: { id: "asc" },
    ...(migrationCursor ? { cursor: { id: migrationCursor }, skip: 1 } : {}),
    take: MIGRATION_PAGE,
  });
  // A short page is the end of the table; the next sweep starts again from the
  // beginning, which is what picks up tasks created since the last pass.
  migrationCursor = tasks.length < MIGRATION_PAGE ? null : tasks[tasks.length - 1].id;
  if (tasks.length === 0) return;

  // Also cross-account, and for the same reason: the page above spans users, so
  // the question "which of these are already adopted" cannot be scoped to one.
  // Nothing but the ids leaves this query.
  const adopted = await prismaUnguarded.workSchedule.findMany({
    where: { legacyScheduledTaskId: { in: tasks.map((task) => task.id) } },
    select: { legacyScheduledTaskId: true },
  });
  // The column is nullable in the schema but cannot be null here — the query
  // above filters on it — so the narrowing is a type formality, not a filter.
  const already = new Set(
    adopted.map((row) => row.legacyScheduledTaskId).filter((id): id is string => id !== null)
  );

  // The adopted rows this deployment did not adopt. Switching the legacy row
  // off used to be missing entirely, so every task a PREVIOUS deployment
  // adopted still reads `enabled: true` — and the loop below can never reach
  // them, because it skips anything in `already` before it gets to the
  // transaction. No double dispatch results (the legacy worker is deleted), but
  // `GET /api/tasks` reports those rows to the native clients as running, which
  // is the opposite of true. One statement, and it is a no-op from the sweep
  // after the first.
  if (already.size > 0) {
    const closed = await prismaUnguarded.scheduledTask.updateMany({
      where: { id: { in: [...already] }, enabled: true },
      data: { enabled: false },
    });
    if (closed.count > 0) {
      log("switched off legacy tasks a previous deployment adopted", { count: closed.count });
    }
  }

  let migrated = 0;
  let unmappable = 0;
  for (const task of tasks) {
    if (stopping) break;
    if (already.has(task.id)) continue;

    // `prompt` is sealed at rest, and `planTaskMigration` plans a routine
    // whose goal and instructions ARE whatever string it is handed. Passing the
    // row straight through produced routines whose entire instruction was
    // `enc:v2:<base64>`: they fired every morning, spent real money and
    // returned nothing. `tests/field-encryption-coverage.test.ts` asserts this
    // call site by name.
    const planned = planTaskMigration({ ...task, prompt: decryptField(task.prompt) });
    if (!planned.ok) {
      // A task this build cannot express as a routine. Left alone deliberately
      // — enabled, untouched, and named in the log on every sweep — because
      // this is the one condition under which retiring the legacy worker would
      // take somebody's schedule down with it. A cadence mapped onto the
      // nearest one it is not would fire at a different time from the task it
      // claims to be, which the user has no way to notice.
      //
      // `tests/work-schedule.test.ts` walks the whole of `TaskCadence` and
      // proves this branch is unreachable for every value the enum has, which
      // is what makes the retirement safe rather than hopeful.
      unmappable += 1;
      log("a scheduled task could not be adopted and was left as it is", {
        taskId: task.id,
        blocker: planned.blocker,
        why: planned.message,
      });
      continue;
    }
    const plan = planned.plan;

    try {
      const sessionId = migratedSessionId(task.id);
      const existing = await prisma.workSession.findFirst({
        where: { id: sessionId, userId: task.userId },
        select: { id: true },
      });
      if (!existing) {
        await createWorkSession({
          id: sessionId,
          userId: task.userId,
          title: plan.session.title,
          // "manual" because the user named this task themselves. Leaving it
          // "default" would let an auto-titler rewrite a name they chose.
          titleSource: "manual",
          goal: plan.session.goal,
          conversationId: plan.session.conversationId,
          requestedTarget: plan.schedule.target,
          requestedModel: parseScheduleRunConfig(plan.schedule.runConfig).model,
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.workSchedule.create({
          data: {
            userId: task.userId,
            sessionId,
            name: plan.schedule.name,
            enabled: plan.schedule.enabled,
            instructions: plan.schedule.instructions,
            target: plan.schedule.target,
            timezone: plan.schedule.timezone,
            runConfig: plan.schedule.runConfig,
            unattendedPolicy: plan.schedule.unattendedPolicy,
            hostOfflinePolicy: plan.schedule.hostOfflinePolicy,
            missedRunPolicy: plan.schedule.missedRunPolicy,
            maxConcurrentRuns: plan.schedule.maxConcurrentRuns,
            notifyPolicy: plan.schedule.notifyPolicy,
            lastRunAt: plan.schedule.lastRunAt,
            // Verbatim. A task due at 09:00 being adopted at 09:04 has a fire
            // owed, and recomputing here would lose it inside the migration that
            // exists to preserve it.
            nextRunAt: plan.schedule.nextRunAt,
            legacyScheduledTaskId: plan.schedule.legacyScheduledTaskId,
            triggers: {
              create: {
                userId: task.userId,
                kind: plan.trigger.kind,
                config: plan.trigger.config,
              },
            },
          },
        });
        // Switched off in the same transaction that adopts it, and this is the
        // half the adopter was missing. Nothing has ever cleared
        // `ScheduledTask.enabled`, so from the moment a task was adopted BOTH
        // dispatchers held a live claim on the same 09:00: the legacy worker
        // ran the prompt and wrote to the task thread, and this one started a
        // run for the same fire. Two runs, two charges and two results a day,
        // for every task that had ever been through this sweep.
        //
        // Inside the transaction rather than after it, because the failure that
        // ordering guards against is the worse one: a task switched off by a
        // write that then rolled back is a schedule that stops running with no
        // routine to take it over.
        await tx.scheduledTask.updateMany({
          where: { id: task.id, userId: task.userId },
          data: { enabled: false },
        });
      });
      migrated += 1;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Another scheduler got between the read above and one of these two
        // inserts. Both keys are derived from the task, so whichever row it
        // created is the row this sweep was going to create; if it won the
        // session and lost the schedule, the next sweep finds the session and
        // completes the adoption.
        continue;
      }
      // One task that cannot be adopted must not stop the sweep. Nothing was
      // written — the adoption is one transaction — so the task is exactly as
      // it was, still enabled, and the next sweep tries again.
      log("could not adopt a scheduled task", { taskId: task.id, error: String(error) });
    }
  }

  if (migrated > 0 || unmappable > 0) {
    log("adopted legacy scheduled tasks", { migrated, unmappable });
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Whether cloud Work is accepting runs.
 *
 * Named and passed to the planner rather than assumed, so turning cloud off — a
 * paused executor, a provider outage — is one edit here that produces the
 * honest `host_offline` outcome, instead of a growing queue of runs that
 * nothing will ever claim. Matches the constant the run-dispatch route holds
 * for the same reason.
 */
const CLOUD_WORK_AVAILABLE = true;

/**
 * Takes the dispatch lease on one schedule.
 *
 * The condition is in the WHERE, not in a preceding read: two schedulers that
 * both saw the same unlocked row issue the same UPDATE, and Postgres decides
 * which one matched. `enabled` is re-tested here as well, so a schedule paused
 * in the moment between the sweep and the claim is not dispatched by a
 * scheduler acting on a two-second-old snapshot.
 */
async function claimSchedule(
  schedule: { id: string; userId: string; lockedUntil: Date | null },
  now: Date
): Promise<boolean> {
  const claim = await prisma.workSchedule.updateMany({
    where: {
      id: schedule.id,
      userId: schedule.userId,
      enabled: true,
      ...(schedule.lockedUntil === null
        ? { lockedUntil: null }
        : { lockedUntil: schedule.lockedUntil }),
    },
    data: { lockedUntil: new Date(now.getTime() + SCHEDULE_LOCK_MS) },
  });
  return claim.count > 0;
}

interface MarkerRunInput {
  scheduleId: string;
  sessionId: string;
  userId: string;
  fireAt: Date;
  requestedTarget: string;
  reason: WorkTerminalReason;
  explanation: string;
}

/**
 * Writes down a fire that will not happen.
 *
 * A run row rather than a log line, because the console is not a surface any
 * user can see and this is information they need: a schedule blocked on budget
 * for a fortnight, or skipped every morning because the Mac is shut, is
 * otherwise indistinguishable from one that is running fine. The run is created
 * and finished in the same breath — no executor ever claims it — so it carries
 * an honest terminal reason and shows up in the schedule's history beside the
 * runs that did happen.
 *
 * It shares its idempotency key with the run this fire would have produced, so
 * a fire yields exactly one row whichever way it went.
 *
 * A `WorkRun` for BOTH kinds of routine, including a Code one whose real runs
 * are `CodeTask`s. That reads odd for a moment and is right: this row is the
 * scheduler's record that a fire was dealt with, not a record of a run, and the
 * alternative — minting a Code conversation and a failed task to say "the
 * budget was spent" — would put a session in the user's Code sidebar that never
 * cloned anything, opened nothing and read no prompt. The automation's history
 * shows both lists for exactly this reason.
 */
async function recordMarkerRun(input: MarkerRunInput): Promise<void> {
  const created = await createRun({
    sessionId: input.sessionId,
    userId: input.userId,
    origin: "schedule",
    scheduleId: input.scheduleId,
    requestedTarget: scheduleTargetOf(input.requestedTarget),
    // Null, and true: nothing ran anywhere. Naming a target here would put a
    // run against a machine that never saw it.
    effectiveTarget: null,
    spendReservation: false,
    idempotencyKey: scheduleRunIdempotencyKey(input.scheduleId, input.fireAt),
  });
  if (created.replay) return;

  await finishRun({
    runId: created.run.id,
    userId: input.userId,
    reason: input.reason,
    detail: input.explanation,
  });
  await appendEvents({
    runId: created.run.id,
    userId: input.userId,
    events: [
      {
        kind: "run_finished",
        payload: { reason: input.reason, explanation: input.explanation },
        visibility: defaultVisibilityFor("run_finished"),
        key: `${created.run.id}:${SCHEDULER_ID}:1`,
      },
    ],
  });
}

type ScheduleWithSession = Prisma.WorkScheduleGetPayload<{ include: { session: true } }>;

/**
 * How many runs this account has going from routines, of either kind.
 *
 * Two queries because the two kinds live in two tables and always will: a Work
 * run is claimed by an executor that reports back over `WorkEvent`, and a Code
 * run is a GitHub Actions job that reports over `CodeTaskEvent`. What must not
 * be two is the NUMBER — `DEFAULT_USER_CONCURRENCY_CAP` is a statement about
 * one account's budget and one person's attention, and an account whose
 * routines are half Work and half Code has neither of those twice over.
 */
async function countScheduledRunsInFlight(userId: string): Promise<number> {
  const [work, code] = await Promise.all([
    prisma.workRun.count({
      where: { userId, scheduleId: { not: null }, status: { in: [...WORK_LIVE_STATUSES] } },
    }),
    prisma.codeTask.count({
      where: { userId, scheduleId: { not: null }, status: { in: [...LIVE_CODE_TASK_STATUSES] } },
    }),
  ]);
  return work + code;
}

/**
 * Starts the Code runs a due routine owes, and says how many really started.
 *
 * One conversation and one cloud run per fire, keyed by the same
 * `scheduleRunIdempotencyKey` a Work fire uses, so a scheduler that dies
 * between the dispatch and the advance does not clone the repository twice.
 *
 * A refusal does not throw: a catch-up of three fires must not lose the third
 * because the first found GitHub unreachable for a second. But it is never only
 * logged either. When the refusal came late enough for a `CodeTask` to exist,
 * that row IS the record — it is in the routine's history, failed, with the
 * reason in its own event log. When it came earlier — no linked GitHub account,
 * no runner workflow — nothing exists to carry the news, so a marker run is
 * written for exactly the reason one is written for a fire the budget stopped:
 * a routine that has been unable to start for a fortnight must not look
 * identical to one that has been running fine.
 */
async function dispatchCodeFires(
  schedule: ScheduleWithSession,
  fires: readonly Date[]
): Promise<number> {
  let started = 0;
  for (const fireAt of fires) {
    const outcome = await startCodeRoutineRun({
      scheduleId: schedule.id,
      userId: schedule.userId,
      name: schedule.name,
      instructions: schedule.instructions,
      timezone: schedule.timezone,
      codeConfig: schedule.codeConfig,
      fireAt,
      // Null: a clock fire carries no text. Only an API fire does, and that
      // path has a caller to refuse when the routine has not opted in.
      fireText: null,
      idempotencyKey: scheduleRunIdempotencyKey(schedule.id, fireAt),
    });
    if (outcome.outcome === "started") started += 1;
    if (outcome.outcome === "refused") {
      log("a Code routine could not start a run", {
        scheduleId: schedule.id,
        fireAt: fireAt.toISOString(),
        reason: outcome.reason,
        recorded: outcome.recorded,
        why: outcome.message,
      });
      if (!outcome.recorded) {
        await recordMarkerRun({
          scheduleId: schedule.id,
          sessionId: schedule.sessionId,
          userId: schedule.userId,
          fireAt,
          requestedTarget: schedule.target,
          // `failed`, because it is: something the routine needs is not there,
          // and the person has to act. It is not `superseded`, which means the
          // routine moved past a fire deliberately, and not `host_offline`,
          // which would send a reader looking for a Mac that was never involved.
          reason: "failed",
          explanation: outcome.message,
        });
      }
    }
  }
  return started;
}

/**
 * Works out what one due schedule needs, and does it.
 *
 * The lease is already held when this is called. Every path either releases it
 * or sets it forward as a backoff, so a schedule cannot be left locked by a
 * decision that chose to do nothing.
 */
async function dispatchOne(
  schedule: ScheduleWithSession,
  now: Date,
  budgets: Map<string, AccountLimits>
): Promise<void> {
  const dueAt = schedule.nextRunAt;
  if (!dueAt) {
    await prisma.workSchedule.updateMany({
      where: { id: schedule.id, userId: schedule.userId },
      data: { lockedUntil: null },
    });
    return;
  }

  const triggers: WorkTriggerRow[] = await prisma.workTrigger.findMany({
    where: { scheduleId: schedule.id, userId: schedule.userId },
  });
  const owning = triggerOwningFire(triggers, schedule.timezone, dueAt);
  if (!owning) {
    // No enabled time trigger claims this fire, which means the triggers were
    // edited after it was computed. Re-deriving the column from the triggers as
    // they are now is the only honest answer: dispatching a fire that belongs
    // to a definition the user has replaced would run the schedule they
    // deliberately changed.
    const nextRunAt = nextFireForTriggers(triggers, schedule.timezone, now);
    await prisma.workSchedule.updateMany({
      where: { id: schedule.id, userId: schedule.userId },
      data: { nextRunAt, lockedUntil: null },
    });
    log("no trigger owns the due fire; re-derived the schedule", {
      scheduleId: schedule.id,
      dueAt: dueAt.toISOString(),
      nextRunAt: nextRunAt?.toISOString() ?? null,
    });
    return;
  }

  const runKind = scheduleRunKindOf(schedule.runKind);
  if (runKind === null) {
    // A routine whose kind this build has never heard of, which means a newer
    // deployment wrote it. The fire is left OWED — `nextRunAt` untouched, the
    // lease set forward as a backoff — because the deployment that understands
    // this routine can still run it, and the two wrong answers are both
    // expensive: guessing `work` would run somebody's Code routine as a Work
    // session, and advancing past the fire would drop it silently.
    await prisma.workSchedule.updateMany({
      where: { id: schedule.id, userId: schedule.userId },
      data: { lockedUntil: new Date(now.getTime() + UNKNOWN_RUN_KIND_RETRY_MS) },
    });
    log("a routine of an unknown kind was left owed", {
      scheduleId: schedule.id,
      runKind: schedule.runKind,
    });
    return;
  }
  const isCode = runKind === "code";

  const runConfig = parseScheduleRunConfig(schedule.runConfig);
  // A Code routine never reaches a Mac: one fire is a cloud session against a
  // repository. So there is no host to rank, no capability to match against one
  // — and the list is not even read, because a query per fire whose answer
  // cannot change the outcome is a query for nothing.
  const hosts = isCode
    ? []
    : await prisma.workHost.findMany({ where: { userId: schedule.userId } });
  // The schedule's chosen Mac first: `selectTarget` takes the first fully
  // capable host in the list, which is how "run it on the MacBook" is said to it.
  const ordered = schedule.hostId
    ? [...hosts].sort((left, right) =>
        left.id === schedule.hostId ? -1 : right.id === schedule.hostId ? 1 : 0
      )
    : hosts;

  // Read before the planner is called, because the planner is handed its
  // remaining budget and the dispatch below is handed its plan, and the two
  // must be the same account's answer from the same moment.
  const limits = await accountLimits(schedule.userId, budgets);

  const [inFlightForSchedule, inFlightForUser] = await Promise.all([
    // This routine's own in-flight runs, counted in the table its runs live in.
    // A Code routine has no `WorkRun` at all, so counting those for one would
    // read zero for ever and `maxConcurrentRuns` would mean nothing — which is
    // the setting that stops a nightly routine stacking eight cloud runs on one
    // repository while the first is still pushing.
    isCode
      ? prisma.codeTask.count({
          where: {
            userId: schedule.userId,
            scheduleId: schedule.id,
            status: { in: [...LIVE_CODE_TASK_STATUSES] },
          },
        })
      : prisma.workRun.count({
          where: {
            userId: schedule.userId,
            scheduleId: schedule.id,
            status: { in: [...WORK_LIVE_STATUSES] },
          },
        }),
    // Every routine of this account and both kinds of run, not just this one.
    // Ten routines each capped at one still start ten simultaneous runs, and
    // the budget and the user's attention are shared across all of them — a
    // Code run spends the same account's money as a Work run, so counting them
    // separately would make "as many as Juno will run at once" mean twice as
    // many for anybody who has both.
    countScheduledRunsInFlight(schedule.userId),
  ]);

  const decision = planScheduleDispatch({
    now,
    schedule: {
      enabled: schedule.enabled,
      // Cloud, stated rather than read, for a Code routine. The create and
      // patch routes refuse any other target for one, so the column already
      // says cloud; passing it explicitly means a row edited by hand cannot
      // send a routine pointed at a repository looking for a laptop.
      target: isCode ? "cloud" : scheduleTargetOf(schedule.target),
      hostId: isCode ? null : schedule.hostId,
      nextRunAt: dueAt,
      // Null rather than the lease this scheduler is holding. Passing the row's
      // own value back would make the planner report the schedule as contended
      // by the process that just claimed it.
      lockedUntil: null,
      missedRunPolicy: missedRunPolicyOf(schedule.missedRunPolicy),
      hostOfflinePolicy: hostOfflinePolicyOf(schedule.hostOfflinePolicy),
      maxConcurrentRuns: schedule.maxConcurrentRuns,
    },
    spec: owning.spec,
    inFlightForSchedule,
    inFlightForUser,
    userConcurrencyCap: DEFAULT_USER_CONCURRENCY_CAP,
    hosts: ordered.map((host) => hostCapabilityView(host, effectiveHostState(host, now))),
    // The capabilities on a Code routine's `runConfig` are Work's vocabulary —
    // local files, a browser, app control — and mean nothing to a cloud Code
    // run. Carrying them into `selectTarget` would make every target fail to
    // satisfy them and turn the routine into one that never runs anywhere.
    requiredCapabilities: isCode ? [] : runConfig.requiredCapabilities,
    cloudAvailable: CLOUD_WORK_AVAILABLE,
    remainingBudgetMicroUsd: limits.remainingMicroUsd,
  });

  /**
   * The next fire, taken across every trigger rather than from the one that
   * owned this fire.
   *
   * The planner reasons about a single spec, which is right for enumerating a
   * backlog and wrong for the column: a schedule that fires daily at 08:00 AND
   * every Monday at 17:00 has one `nextRunAt`, and writing the daily trigger's
   * answer into it would drop every Monday evening.
   */
  const advanced = (): Date | null => nextFireForTriggers(triggers, schedule.timezone, now);

  switch (decision.outcome) {
    case "dispatch": {
      if (isCode) {
        const started = await dispatchCodeFires(schedule, decision.fireAt);
        await prisma.workSchedule.updateMany({
          where: { id: schedule.id, userId: schedule.userId },
          data: {
            lastRunAt: decision.fireAt[decision.fireAt.length - 1],
            nextRunAt: advanced(),
            lockedUntil: null,
          },
        });
        log("dispatched", {
          scheduleId: schedule.id,
          runKind,
          started,
          dropped: decision.dropped,
        });
        return;
      }

      // The policy the executor will enforce, after narrowing. `narrowestPolicy`
      // is a `min`, so no layer can widen another: a Mac pinned to
      // `conservative` stays conservative under a `permissive` session, which is
      // what makes the toggle on that Mac mean anything at all.
      const host = decision.hostId
        ? ordered.find((candidate) => candidate.id === decision.hostId)
        : undefined;
      const sessionPolicy = permissionPolicyOf(schedule.session.permissionPolicy);
      const hostPolicy = host ? permissionPolicyOf(host.approvalPolicy) : null;
      const policy: JsonObject = {
        policy: narrowestPolicy(sessionPolicy, hostPolicy),
        session: sessionPolicy,
        host: hostPolicy,
        // The schedule's unattended policy, stamped onto the run so the
        // executor enforces it per action through `decideUnattendedAction`.
        // `unattendedPolicyOf` returns one of three values, none of which
        // grants anything — there is no fourth to write here even by mistake.
        unattended: unattendedPolicyOf(schedule.unattendedPolicy),
        // Explicit rather than implied by the origin. An executor reading this
        // blob should not have to know which origins mean nobody is watching.
        attended: false,
      };

      let started = 0;
      for (const fireAt of decision.fireAt) {
        const created = await createRun({
          sessionId: schedule.sessionId,
          userId: schedule.userId,
          origin: "schedule",
          scheduleId: schedule.id,
          requestedTarget: scheduleTargetOf(schedule.target),
          effectiveTarget: decision.effectiveTarget,
          hostId: decision.hostId,
          requestedModel: runConfig.model ?? schedule.session.requestedModel,
          requiredCapabilities: runConfig.requiredCapabilities,
          degradation: decision.degradation,
          permissionPolicy: policy,
          // 0 means UNLIMITED to `budgetExceeded`, and a schedule that never
          // set a figure defaulted to 0 — so the runs firing at 03:00 with
          // nobody watching were the only ones with no ceiling at all, while a
          // manually started run got a real one. The cost axis takes the
          // unattended default ($1) first; then every axis is narrowed against
          // this account's plan ceiling, which is what fills the token and
          // runtime ceilings a schedule left at zero. Substituted here rather
          // than in `budgetExceeded` because 0-means-unlimited is the persisted
          // contract the column and every client already speak.
          //
          // The plan is read through the same cache the admission check used,
          // so a schedule cannot be admitted against one plan and dispatched
          // under another's ceiling.
          budget: narrowestBudget(
            {
              maxCostMicroUsd: unattendedRunCeiling(schedule.maxCostMicroUsd),
              maxTokens: schedule.maxTokens,
              maxRuntimeMs: schedule.maxRuntimeMs,
            },
            runBudgetForPlan(limits.plan)
          ),
          // The same plan the ceiling above was built from, so spend admission
          // measures the run against it rather than reading the row a second
          // time and possibly getting a different answer.
          plan: limits.plan,
          idempotencyKey: scheduleRunIdempotencyKey(schedule.id, fireAt),
        });
        // A replay is a fire this process already made and is seeing again, so
        // it is neither counted nor re-manifested.
        //
        // The task's files are carried onto the attempt here because the runner
        // reads a run's attachments from its `WorkRunIO` input rows and from
        // nowhere else, and only the manual dispatch route wrote them — so a
        // schedule pointed at a session with three documents attached fired
        // every morning against none of them and said nothing about it. The run
        // behaved as though the task had no files, which from the reader's side
        // is a task that quietly stopped working.
        //
        // After `createRun` rather than inside it: the call needs the run id,
        // and `createMany` on a replayed key would double rows that already
        // exist. The manifest is a snapshot of the grants as they stand at this
        // fire, which is the point — a file revoked yesterday is not in today's
        // run.
        if (!created.replay) {
          started += 1;
          await recordRunInputsFromGrants({
            runId: created.run.id,
            sessionId: schedule.sessionId,
            userId: schedule.userId,
          });
        }
      }

      await prisma.workSchedule.updateMany({
        where: { id: schedule.id, userId: schedule.userId },
        data: {
          lastRunAt: decision.fireAt[decision.fireAt.length - 1],
          nextRunAt: advanced(),
          lockedUntil: null,
        },
      });
      log("dispatched", {
        scheduleId: schedule.id,
        started,
        dropped: decision.dropped,
        target: decision.effectiveTarget,
      });
      return;
    }

    case "delayed": {
      // `nextRunAt` is deliberately untouched: the fire is still owed, and when
      // the slot or the Mac comes back the missed-run policy decides what to do
      // with it. The lease doubles as the backoff, so the schedule is not
      // re-examined — by this scheduler or any other — until then.
      await prisma.workSchedule.updateMany({
        where: { id: schedule.id, userId: schedule.userId },
        data: { lockedUntil: decision.retryAt },
      });
      log("delayed", {
        scheduleId: schedule.id,
        cause: decision.cause,
        retryAt: decision.retryAt.toISOString(),
        why: decision.explanation,
      });
      return;
    }

    case "skipped": {
      const nextRunAt = advanced();
      await prisma.workSchedule.updateMany({
        where: { id: schedule.id, userId: schedule.userId },
        data: { nextRunAt, lockedUntil: null },
      });
      // `host_offline` when that is what happened, so the run lands in a status
      // `statusNeedsAttention` reports — waking the Mac or moving the work to
      // cloud is the user's decision, and it never gets made if the row reads
      // "cancelled". A fire the user's own missed-run policy told the schedule
      // to drop is `superseded`: the schedule moved past it deliberately, and
      // nothing about that needs anybody.
      await recordMarkerRun({
        scheduleId: schedule.id,
        sessionId: schedule.sessionId,
        userId: schedule.userId,
        fireAt: dueAt,
        requestedTarget: schedule.target,
        reason: decision.cause === "host_offline" ? "host_offline" : "superseded",
        explanation: decision.explanation,
      });
      log("skipped", {
        scheduleId: schedule.id,
        cause: decision.cause,
        dropped: decision.dropped,
        why: decision.explanation,
      });
      return;
    }

    case "budget_blocked": {
      await prisma.workSchedule.updateMany({
        where: { id: schedule.id, userId: schedule.userId },
        data: { nextRunAt: decision.nextRunAt, lockedUntil: null },
      });
      await recordMarkerRun({
        scheduleId: schedule.id,
        sessionId: schedule.sessionId,
        userId: schedule.userId,
        fireAt: dueAt,
        requestedTarget: schedule.target,
        reason: "budget_exceeded",
        explanation: decision.explanation,
      });
      log("budget blocked", { scheduleId: schedule.id, why: decision.explanation });
      return;
    }

    case "not_due":
    case "contended": {
      // Reachable when the row changed under the claim — paused, or edited to a
      // later fire, between the sweep and the lease. Releasing is right: there
      // is nothing owed and nothing to record.
      await prisma.workSchedule.updateMany({
        where: { id: schedule.id, userId: schedule.userId },
        data: { lockedUntil: null },
      });
      return;
    }
  }
}

/**
 * Finds schedules that are due and nobody is dispatching.
 *
 * Cross-account by nature, so it says so with `prismaUnguarded` rather than
 * tripping a guard whose entire job is to notice a query that forgot its
 * userId. Ordered by the fire they are owed, oldest first, so a schedule that
 * has been waiting longest is served before one that came due this second.
 */
async function findDueSchedules(now: Date, limit: number) {
  return prismaUnguarded.workSchedule.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    orderBy: { nextRunAt: "asc" },
    take: limit,
    include: { session: true },
  });
}

async function tick(): Promise<void> {
  const now = new Date();

  if (now.getTime() >= nextMigrationSweepAt) {
    nextMigrationSweepAt = now.getTime() + MIGRATION_SWEEP_MS;
    await sweepMigrations();
  }

  if (now.getTime() >= nextCheckpointSweepAt) {
    nextCheckpointSweepAt = now.getTime() + CHECKPOINT_SWEEP_MS;
    // Here rather than in `work-runner.ts`, and that placement is the point.
    // The runner is the process whose absence produces most of the rows worth
    // sweeping; a janitor that only runs when the thing it cleans up after is
    // healthy is not a janitor. The scheduler is the long-lived process that
    // does not hold runs, which makes it the right host for every sweep whose
    // trigger is "something else stopped".
    await sweepExpiredCheckpoints({ now }).then(
      (result) => {
        if (result.cleared > 0) log("checkpoints expired", { cleared: result.cleared });
      },
      (error: unknown) => {
        // A failed sweep is not worth stopping the tick for: nothing downstream
        // depends on it having run, and the next pass tries again.
        log("checkpoint sweep failed", { error: String(error) });
      }
    );
  }

  const budgets = new Map<string, AccountLimits>();
  for (const schedule of await findDueSchedules(now, MAX_SCHEDULES_PER_TICK)) {
    if (stopping) return;
    if (!(await claimSchedule(schedule, now))) continue;

    try {
      await dispatchOne(schedule, now, budgets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failure IS the fifth outcome, and it is the one that must not be
      // confused with the other four. `nextRunAt` is left alone so the fire is
      // still owed, and the lease is released so the next tick retries rather
      // than the schedule sitting locked until the lease lapses.
      log("dispatch failed", { scheduleId: schedule.id, error: message });
      await prisma.workSchedule
        .updateMany({
          where: { id: schedule.id, userId: schedule.userId },
          data: { lockedUntil: null },
        })
        .catch((releaseError: unknown) => {
          // Nothing further can be done in-process; the lease expires on its
          // own and the schedule is picked up then.
          log("could not release the lease", { scheduleId: schedule.id, error: String(releaseError) });
        });
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("started", { scheduler: SCHEDULER_ID, tickMs: TICK_MS });

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, finishing the current tick`);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      // One bad tick must not end the scheduler: the next one may well succeed,
      // and a scheduler that exits on a transient database error takes every
      // schedule in the deployment with it.
      log("tick failed", { error: String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }

  log("stopped");
}

void main();
