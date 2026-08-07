/**
 * The Work scheduler.
 *
 * Decides which schedules are due, starts their runs, and adopts the legacy
 * `ScheduledTask` rows into `WorkSchedule` as it goes. Run it the way the other
 * two workers are run:
 *
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/work-scheduler.ts
 *
 * It dispatches; it does not execute. A schedule firing produces a queued
 * `WorkRun`, which `scripts/work-runner.ts` (cloud) or the paired Mac (local)
 * claims through its own lease. Keeping the two apart is what lets the executor
 * be restarted, scaled or replaced without any schedule being missed, and what
 * lets this process finish a tick in milliseconds no matter how long the work
 * it started takes.
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
import {
  createRun,
  createWorkSession,
  appendEvents,
  finishRun,
  sweepExpiredCheckpoints,
} from "@/lib/work/store";
import {
  WORK_LIVE_STATUSES,
  defaultVisibilityFor,
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
import { effectiveHostState } from "@/app/api/work/protocol";
import { Prisma } from "@prisma/client";

/** How often to look for due schedules. Well under the shortest cadence a user
 *  can express (`hourly`), and short enough that `MISSED_RUN_GRACE_MS` is never
 *  reached by a scheduler that is simply busy. */
const TICK_MS = 15_000;
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

/**
 * What each account may still spend, remembered for the length of one tick.
 *
 * Ten schedules belonging to one user become one budget read rather than ten,
 * and the staleness that buys is bounded by the tick. Nothing here enforces the
 * budget — the executor does, per token — so a figure a few seconds old can
 * only affect whether a run is started, never whether it overspends.
 */
async function remainingBudgetMicroUsd(
  userId: string,
  cache: Map<string, number | null>
): Promise<number | null> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  const plan = await getUserPlan(userId);
  const status = await checkBudget(userId, plan);
  cache.set(userId, status.remainingMicroUsd);
  return status.remainingMicroUsd;
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
 * Runs periodically rather than once at startup, because `/api/tasks` still
 * creates tasks and the native client still writes to it: a migration that ran
 * only at boot would adopt everything that existed that morning and nothing
 * created afterwards, which is a slow, silent split-brain rather than a clean
 * cutover.
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
  const already = new Set(adopted.map((row) => row.legacyScheduledTaskId));

  let migrated = 0;
  let unmappable = 0;
  for (const task of tasks) {
    if (stopping) break;
    if (already.has(task.id)) continue;

    const plan = planTaskMigration(task);
    if (!plan) {
      // A cadence this build cannot express. Left alone deliberately: the task
      // keeps running on the legacy runner, which is strictly better than a
      // schedule that claims to be it and fires at a different time.
      unmappable += 1;
      continue;
    }

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

      await prisma.workSchedule.create({
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
      // One task that cannot be adopted must not stop the sweep. It keeps
      // running on the legacy runner and the next sweep tries again.
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
 * Works out what one due schedule needs, and does it.
 *
 * The lease is already held when this is called. Every path either releases it
 * or sets it forward as a backoff, so a schedule cannot be left locked by a
 * decision that chose to do nothing.
 */
async function dispatchOne(
  schedule: ScheduleWithSession,
  now: Date,
  budgets: Map<string, number | null>
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

  const runConfig = parseScheduleRunConfig(schedule.runConfig);
  const hosts = await prisma.workHost.findMany({ where: { userId: schedule.userId } });
  // The schedule's chosen Mac first: `selectTarget` takes the first fully
  // capable host in the list, which is how "run it on the MacBook" is said to it.
  const ordered = schedule.hostId
    ? [...hosts].sort((left, right) =>
        left.id === schedule.hostId ? -1 : right.id === schedule.hostId ? 1 : 0
      )
    : hosts;

  const [inFlightForSchedule, inFlightForUser] = await Promise.all([
    prisma.workRun.count({
      where: {
        userId: schedule.userId,
        scheduleId: schedule.id,
        status: { in: [...WORK_LIVE_STATUSES] },
      },
    }),
    // Every schedule of this account, not just this one. Ten schedules each
    // capped at one still start ten simultaneous runs, and the budget and the
    // user's attention are shared across all of them.
    prisma.workRun.count({
      where: {
        userId: schedule.userId,
        scheduleId: { not: null },
        status: { in: [...WORK_LIVE_STATUSES] },
      },
    }),
  ]);

  const decision = planScheduleDispatch({
    now,
    schedule: {
      enabled: schedule.enabled,
      target: scheduleTargetOf(schedule.target),
      hostId: schedule.hostId,
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
    requiredCapabilities: runConfig.requiredCapabilities,
    cloudAvailable: CLOUD_WORK_AVAILABLE,
    remainingBudgetMicroUsd: await remainingBudgetMicroUsd(schedule.userId, budgets),
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
          budget: {
            maxCostMicroUsd: schedule.maxCostMicroUsd,
            maxTokens: schedule.maxTokens,
            maxRuntimeMs: schedule.maxRuntimeMs,
          },
          idempotencyKey: scheduleRunIdempotencyKey(schedule.id, fireAt),
        });
        if (!created.replay) started += 1;
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

  const budgets = new Map<string, number | null>();
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
