import "server-only";

import type { Prisma, WorkRun } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getUserPlan } from "@/lib/usage";
import {
  WORK_LIVE_STATUSES,
  narrowestBudget,
  narrowestPolicy,
  selectTarget,
  type TargetSelection,
} from "@/lib/work/domain";
import { runBudgetForWindow } from "@/lib/work/budget";
import { checkUsageWindows } from "@/lib/spend";
import { windowLimitMessage, type UsageWindowName } from "@/lib/spend-ceiling";
import { createRun, recordRunInputsFromGrants } from "@/lib/work/store";
import {
  hostCapabilityView,
  parseScheduleRunConfig,
  permissionPolicyOf,
  scheduleTargetOf,
  unattendedPolicyOf,
  type JsonObject,
} from "@/lib/work/schedule";
import {
  LIVE_CODE_TASK_STATUSES,
  scheduleRunKindOf,
  type WorkScheduleRunKind,
} from "@/lib/work/code-routine";
import { startCodeRoutineRun, type CodeRunOutcome } from "@/lib/work/code-dispatch";
import { effectiveHostState } from "@/app/api/work/protocol";

/**
 * Running one routine once, now, without moving its clock.
 *
 * Two callers ask exactly this: the Run-now button, and an `api` trigger's fire
 * URL. They differ in who is asking and in one flag — a person is watching the
 * first and nobody is watching the second — and in nothing else, so they share
 * an implementation rather than two that drift. The drift would land on the
 * parts that are invisible until they are wrong: which policy the run is
 * stamped with, which plan its ceiling came from, and whether the routine's own
 * concurrency cap was honoured.
 *
 * NOTHING HERE WRITES TO THE ROUTINE. Not `nextRunAt`, not `lastRunAt`, not
 * `lockedUntil`. That absence is the point rather than an omission: the legacy
 * `executeTask` advanced the schedule on every exit path, so wiring a "run it
 * now" button to it meant pressing it quietly cancelled this evening's run — a
 * button that appears to do one thing and also does the opposite of another.
 * Whatever the routine was going to do next, it still does.
 *
 * Refusals are SYNCHRONOUS, unlike the poller's, and that is right for both
 * callers. `planTriggerDispatch` holds an event for later because a mailbox
 * will still have the message in two minutes and nobody is waiting on the
 * answer; here there is an HTTP response to write, and a caller told "not now,
 * this is why" can decide for itself whether to retry — where a silent hold
 * would leave a CI job believing it had started a run it had not.
 *
 * WHAT ADMITS THE SPEND, AND WHAT DOES NOT
 *
 * Stated here rather than left to be inferred from the absence of a call. A
 * Code fire starts a cloud run with no spend admission on this path at all:
 * `startCodeRoutineRun` is called directly, with no `createRun`, no
 * `reserveSpend` and no remaining-budget gate. Enforcement is `/api/agent`'s
 * `checkBudget`, which runs once the runner is already burning Actions minutes.
 *
 * That is deliberate and it is not this function's invention: `POST
 * /api/code/tasks` behaves identically, so a routine's Code run is admitted
 * exactly as a composer's is, and a gate here would make the two disagree about
 * what an account may start. It is also the shape the product wants — what
 * bounds an account is its usage window, not a per-run ceiling stamped on the
 * way in.
 *
 * What is new is the door: the fire URL is unattended and public, at
 * `FIRE_RATE_LIMIT` per routine per minute, where the composer needs a person
 * in a session. So the sentence a reader needs is that the RATE limit is the
 * only thing standing between a token and a queue of runs, and it is standing
 * there on purpose.
 */

export const FIRE_REFUSALS = [
  /** The routine is paused. */
  "paused",
  /** This routine already has as many runs going as it allows. */
  "already_running",
  /** A newer deployment's routine, which this build must not guess at. */
  "unknown_run_kind",
  /** No target can serve it — usually a Mac that is not there. */
  "no_target",
  /** A Code routine that cannot start: no repository, no GitHub, no runner. */
  "code_refused",
  /** The account is out of its 5-hour or weekly window — the only ceiling left. */
  "usage_window_exceeded",
] as const;

export type FireRefusal = (typeof FIRE_REFUSALS)[number];

export type FireOutcome =
  | { outcome: "work_run"; run: WorkRun; replay: boolean; selection: TargetSelection }
  | { outcome: "code_run"; taskId: string; conversationId: string | null; replay: boolean }
  | {
      outcome: "refused";
      reason: FireRefusal;
      message: string;
      selection?: TargetSelection;
      /** Which window binds, for the window refusal only. */
      window?: UsageWindowName;
      /** When it frees up, so a caller can retry then rather than spin. */
      resetsAtMs?: number | null;
    };

/**
 * The HTTP status a refusal deserves, shared so the two fire routes agree.
 *
 * Every refusal here used to be a 409, which was right while they were all
 * conflicts of state — paused, already running, no Mac. A spent window is not a
 * conflict: it is the caller having asked for more than their allowance, and a
 * CI job that reads 429 backs off where it would retry a 409 straight into the
 * same wall.
 */
export function fireRefusalStatus(reason: FireRefusal): number {
  return reason === "usage_window_exceeded" ? 429 : 409;
}

/** The routine, with the session a Work run needs. */
type ScheduleWithSession = Prisma.WorkScheduleGetPayload<{ include: { session: true } }>;

export interface FireNowInput {
  schedule: ScheduleWithSession;
  /** Whose routine it is. Taken from the row, never from a request. */
  userId: string;
  /**
   * `manual` for a person pressing the button, `trigger` for a token fire.
   *
   * It decides where the run appears in the routine's history, and history is
   * the reason it is not just cosmetic: a schedule's fired-on-time record is
   * about its clock, and a run somebody started by hand did not happen on time
   * or late — it happened because they asked.
   */
  origin: "manual" | "trigger";
  /**
   * Whether somebody is there to answer a question.
   *
   * True only for the button. A token fire at 03:00 has nobody behind it, so
   * the executor must checkpoint on the first question rather than wait for an
   * answer — and either way the routine's unattended policy, which says what
   * may be DONE without being asked, is unchanged.
   */
  attended: boolean;
  /**
   * Text an API caller sent, or null.
   *
   * Read by a Code routine only, and the fire route refuses it for any other
   * kind rather than passing it here to be dropped: a Work routine re-runs a
   * task whose goal is fixed at dispatch, so there is nowhere for a caller's
   * paragraph to go that the run would read. Untrusted either way — it is
   * wrapped and labelled as data by `codeRoutinePrompt`, never handed on as an
   * instruction.
   */
  fireText: string | null;
  now: Date;
  /** Scoped and prefixed by the caller, so one fire yields one run. */
  idempotencyKey: string | null;
}

export async function fireScheduleNow(input: FireNowInput): Promise<FireOutcome> {
  const { schedule, userId, now } = input;

  if (!schedule.enabled) {
    return {
      outcome: "refused",
      reason: "paused",
      message: "This automation is paused, so nothing starts it until you resume it.",
    };
  }

  const runKind: WorkScheduleRunKind | null = scheduleRunKindOf(schedule.runKind);
  if (runKind === null) {
    return {
      outcome: "refused",
      reason: "unknown_run_kind",
      message: "This automation was created by a newer version of Juno, so this one cannot run it.",
    };
  }

  // The same cap the scheduler honours, counted in the table this routine's
  // runs live in. Bypassing it here would let a caller start by hand — or by
  // token, ten times a second — exactly the pile-up the setting exists to
  // prevent, against the same repository or the same granted folders.
  const live =
    runKind === "code"
      ? await prisma.codeTask.count({
          where: {
            userId,
            scheduleId: schedule.id,
            status: { in: [...LIVE_CODE_TASK_STATUSES] },
          },
        })
      : await prisma.workRun.count({
          where: { userId, scheduleId: schedule.id, status: { in: [...WORK_LIVE_STATUSES] } },
        });
  if (live >= Math.max(1, schedule.maxConcurrentRuns)) {
    return {
      outcome: "refused",
      reason: "already_running",
      message: "This automation is already running. Let it finish before starting another.",
    };
  }

  if (runKind === "code") {
    const started: CodeRunOutcome = await startCodeRoutineRun({
      scheduleId: schedule.id,
      userId,
      name: schedule.name,
      instructions: schedule.instructions,
      timezone: schedule.timezone,
      codeConfig: schedule.codeConfig,
      fireAt: now,
      fireText: input.fireText,
      // A fire with no key of its own is still one fire: keyed by the instant so
      // a retry seconds later is a new run (which is what pressing the button
      // twice means) while a duplicate delivery of the same request is not.
      idempotencyKey: input.idempotencyKey ?? `wfire:${schedule.id}:${now.toISOString()}`,
    });
    if (started.outcome === "refused") {
      return {
        outcome: "refused",
        reason: "code_refused",
        message: started.message,
      };
    }
    return {
      outcome: "code_run",
      taskId: started.taskId,
      conversationId: started.conversationId,
      replay: started.outcome === "replay",
    };
  }

  const runConfig = parseScheduleRunConfig(schedule.runConfig);
  const hosts = await prisma.workHost.findMany({ where: { userId } });
  const ordered = schedule.hostId
    ? [...hosts].sort((left, right) =>
        left.id === schedule.hostId ? -1 : right.id === schedule.hostId ? 1 : 0
      )
    : hosts;

  const selection = selectTarget({
    requested: scheduleTargetOf(schedule.target),
    required: runConfig.requiredCapabilities,
    hosts: ordered.map((host) => hostCapabilityView(host, effectiveHostState(host, now))),
    cloudAvailable: CLOUD_WORK_AVAILABLE,
  });

  // A fire refuses rather than falling back on `hostOfflinePolicy`. That policy
  // answers "what should happen at 07:00 while I am asleep"; whoever is here
  // now — a person at the button or a caller holding a response — is here to be
  // told the Mac is off, and to decide for themselves.
  if (selection.target === null) {
    return { outcome: "refused", reason: "no_target", message: selection.explanation, selection };
  }

  const host = selection.hostId
    ? ordered.find((candidate) => candidate.id === selection.hostId)
    : undefined;
  const sessionPolicy = permissionPolicyOf(schedule.session.permissionPolicy);
  const hostPolicy = host ? permissionPolicyOf(host.approvalPolicy) : null;
  const permissionPolicy: JsonObject = {
    // `narrowestPolicy` is a `min`, so no layer can widen another: a Mac pinned
    // to `conservative` stays conservative under a `permissive` session.
    policy: narrowestPolicy(sessionPolicy, hostPolicy),
    session: sessionPolicy,
    host: hostPolicy,
    // Pressing a button is not agreeing in advance to whatever the run decides
    // to delete, and holding a token is even less so. The routine's own
    // unattended policy is the last thing its owner actually said about that.
    unattended: unattendedPolicyOf(schedule.unattendedPolicy),
    attended: input.attended,
  };

  // Read once and used twice: it shapes the ceiling below and it is what spend
  // admission measures the run against. Reading it separately in each place is
  // two chances for a subscription that lapsed mid-request to be refused
  // against one plan and dispatched under another's ceiling.
  const plan = await getUserPlan(userId);

  // What the account has left in the window that binds it — the only ceiling a
  // run has now. The same read refuses the fire and sizes the run's cost
  // ceiling; the reasoning is in `src/lib/work/budget.ts`.
  //
  // It sits on the WORK path, below the Code branch, for the symmetry the
  // header argues for: a Code fire is admitted exactly as `POST
  // /api/code/tasks` admits a composer's run, and a gate here alone would make
  // a routine stricter than the button that starts the same work by hand.
  const windows = await checkUsageWindows(userId, plan);
  if (!windows.allowed && windows.bound !== null) {
    return {
      outcome: "refused",
      reason: "usage_window_exceeded",
      message: `${windowLimitMessage(windows.bound, windows.resetsAtMs)} Nothing was started.`,
      window: windows.bound,
      resetsAtMs: windows.resetsAtMs,
    };
  }

  const created = await createRun({
    sessionId: schedule.sessionId,
    userId,
    origin: input.origin,
    // Still attributed to the routine, so it appears in this routine's history
    // — which is where whoever fired it will look.
    scheduleId: schedule.id,
    requestedTarget: scheduleTargetOf(schedule.target),
    effectiveTarget: selection.target,
    hostId: selection.hostId,
    requestedModel: runConfig.model ?? schedule.session.requestedModel,
    requiredCapabilities: runConfig.requiredCapabilities,
    availableCapabilities: selection.available,
    degradation: selection.degradation,
    permissionPolicy,
    // The routine's own figures, narrowed against what the account's binding
    // window has left. Zero on these columns means "no ceiling of the routine's
    // own" to `budgetExceeded`, and `narrowestBudget` skips the zeros rather
    // than clamping to them — which is what lets a routine ask for LESS than
    // the window and never for more.
    budget: narrowestBudget(
      {
        maxCostMicroUsd: schedule.maxCostMicroUsd,
        maxTokens: schedule.maxTokens,
        maxRuntimeMs: schedule.maxRuntimeMs,
      },
      runBudgetForWindow(windows.remainingMicroUsd)
    ),
    plan,
    idempotencyKey: input.idempotencyKey,
  });

  // The task's files, carried onto the attempt — the same call both dispatchers
  // make, and it was missing from this path. The runner reads a run's
  // attachments from its `WorkRunIO` input rows and from nowhere else, so a
  // routine pointed at a session with three documents attached ran against none
  // of them whenever it was started by hand, and said nothing about it. From
  // the reader's side that is a task that quietly stopped working.
  //
  // After `createRun` because the call needs the run id, and skipped on a replay
  // because `createMany` over a key that already exists would double the rows.
  // The manifest is a snapshot of the grants as they stand at this fire, which
  // is the point: a file revoked yesterday is not in today's run.
  if (!created.replay) {
    await recordRunInputsFromGrants({
      runId: created.run.id,
      sessionId: schedule.sessionId,
      userId,
    });
  }

  return { outcome: "work_run", run: created.run, replay: created.replay, selection };
}

/** Matches the constant the dispatchers hold, and for the same reason: turning
 *  cloud off should produce an honest refusal rather than a queue of runs
 *  nothing will ever claim. */
const CLOUD_WORK_AVAILABLE = true;
