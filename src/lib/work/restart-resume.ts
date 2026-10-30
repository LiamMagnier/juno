import "server-only";
import { prisma, prismaUnguarded } from "@/lib/db";
import {
  WORK_LEASED_STATUSES,
  appendEvents,
  finishRun,
  parkRun,
  type WorkRunUsage,
} from "@/lib/work/store";
import {
  RESTART_EVENT_CAUSE,
  RESTART_NOT_RESUMED_DETAIL,
  RESTART_PAUSE_REASON,
  RESTART_RESUME_OFF_DETAIL,
  restartCheckpointVerdict,
} from "@/lib/work/restart-resume-rules";

export * from "@/lib/work/restart-resume-rules";

/*
 * The reads and writes of a cloud run across a restart of its runner. The
 * rules, and the order of events, are in restart-resume-rules.ts.
 */

/** How long the sweep holds a parked run while it ends it (its lease on the row). */
const END_CLAIM_MS = 60_000;

/**
 * Parks a run the runner stopped at a step boundary for a restart:
 * `paused`, `pauseReason: "server_restart"`, lease released.
 *
 * Two fenced writes, in order. The reason is set first, and only on a run this
 * executor still holds, in a leased status, that nobody paused: a person who
 * pressed Pause a moment before (the control route writes `pauseReason:
 * "user"`) keeps their pause, and a run another worker or the sweep has taken
 * is not touched. Then `parkRun` releases the lease under the same fence;
 * it leaves an existing reason alone, and only the executor's own wait for a
 * person puts the task in Needs you, so this one does not.
 *
 * Returns whether the run was parked by this call.
 */
export async function parkRunForRestart(input: {
  runId: string;
  userId: string;
  executorId: string;
  usage?: WorkRunUsage;
}): Promise<boolean> {
  await prisma.workRun.updateMany({
    where: {
      id: input.runId,
      userId: input.userId,
      claimedBy: input.executorId,
      status: { in: [...WORK_LEASED_STATUSES] },
      pauseReason: null,
    },
    data: { pauseReason: RESTART_PAUSE_REASON },
  });
  return parkRun({ runId: input.runId, userId: input.userId, executorId: input.executorId, usage: input.usage });
}

/** The rows the sweep may act on: parked for a restart, cloud, held by nobody (or by a sweep that died). */
function parkedForRestartWhere(now: Date) {
  return {
    status: "paused",
    pauseReason: RESTART_PAUSE_REASON,
    effectiveTarget: "cloud",
    OR: [{ claimedBy: null }, { leaseExpiresAt: { lt: now } }],
  };
}

export interface ResumeParkedRunsResult {
  /** Put back in the queue, to be continued by whichever runner claims them. */
  requeued: string[];
  /** Ended `interrupted`, with why. */
  ended: Array<{ runId: string; userId: string; why: "switched_off" | "missing" | "unreadable" | "unanswered_call" | "tool_in_flight" }>;
}

/**
 * Deals with the runs a runner set aside for a restart: each one is put back
 * in the queue when the switch is on and its checkpoint proves nothing was in
 * flight (`restartCheckpointVerdict`), and ended `interrupted` otherwise, its
 * checkpoint kept so the person can continue it.
 *
 * Called by every runner on every tick, before it claims anything, so a run
 * set aside by the runner that is going away is continued by the one that
 * replaces it. Every write is a compare-and-set on the row as the sweep read
 * it: a person who resumes or cancels the run in between wins, and two runners
 * sweeping at once move each run once.
 */
export async function resumeRunsParkedForRestart(input: {
  executorId: string;
  enabled: boolean;
  now?: Date;
  limit?: number;
}): Promise<ResumeParkedRunsResult> {
  const now = input.now ?? new Date();
  const parked = await prismaUnguarded.workRun.findMany({
    where: parkedForRestartWhere(now),
    select: { id: true, userId: true, checkpoint: true },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(input.limit ?? 20, 1), 100),
  });
  const result: ResumeParkedRunsResult = { requeued: [], ended: [] };
  for (const run of parked) {
    const verdict = input.enabled ? restartCheckpointVerdict(run.checkpoint, run.id) : null;
    if (verdict?.clean) {
      if (await requeueRunParkedForRestart({ runId: run.id, userId: run.userId, now })) result.requeued.push(run.id);
      continue;
    }
    const why = verdict === null ? "switched_off" : verdict.why;
    const ended = await endRunParkedForRestart({
      runId: run.id,
      userId: run.userId,
      executorId: input.executorId,
      detail: why === "switched_off" ? RESTART_RESUME_OFF_DETAIL : RESTART_NOT_RESUMED_DETAIL,
      now,
    });
    if (ended) result.ended.push({ runId: run.id, userId: run.userId, why });
  }
  return result;
}

/**
 * `paused` (for a restart) back to `queued`, once. The session follows only
 * while this is its newest attempt, as `requeueParkedRun` does, and it is not
 * put in Needs you: nobody is being asked anything.
 */
async function requeueRunParkedForRestart(input: { runId: string; userId: string; now: Date }): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.workRun.updateMany({
      where: { id: input.runId, userId: input.userId, ...parkedForRestartWhere(input.now) },
      data: { status: "queued", pauseReason: null, claimedBy: null, claimedAt: null, leaseExpiresAt: null },
    });
    if (moved.count !== 1) return false;
    const run = await tx.workRun.findFirst({
      where: { id: input.runId, userId: input.userId },
      select: { sessionId: true, attempt: true },
    });
    if (!run) return true;
    const newer = await tx.workRun.findFirst({
      where: { sessionId: run.sessionId, userId: input.userId, attempt: { gt: run.attempt } },
      select: { id: true },
    });
    if (!newer) {
      await tx.workSession.updateMany({
        where: { id: run.sessionId, userId: input.userId },
        data: { status: "queued", lastActivityAt: input.now },
      });
    }
    return true;
  });
}

/**
 * Ends a run parked for a restart as `interrupted`, with the sentence that
 * says why it was not continued, and closes its timeline with the ending.
 *
 * The row is first taken for this sweep (a short lease on the paused row,
 * compare-and-set), then ended through `finishRun` fenced to that claim, so a
 * person who resumes the run in between (which clears the claim) keeps it.
 * The checkpoint stays: `interrupted` is resumable.
 */
async function endRunParkedForRestart(input: {
  runId: string;
  userId: string;
  executorId: string;
  detail: string;
  now: Date;
}): Promise<boolean> {
  const claimed = await prisma.workRun.updateMany({
    where: { id: input.runId, userId: input.userId, ...parkedForRestartWhere(input.now) },
    data: { claimedBy: input.executorId, claimedAt: input.now, leaseExpiresAt: new Date(input.now.getTime() + END_CLAIM_MS) },
  });
  if (claimed.count !== 1) return false;
  const ended = await finishRun({
    runId: input.runId,
    userId: input.userId,
    reason: "interrupted",
    detail: input.detail,
    executorId: input.executorId,
    now: input.now,
  });
  if (!ended.finished) return false;
  await appendEvents({
    runId: input.runId,
    userId: input.userId,
    events: [
      {
        kind: "run_finished",
        payload: { reason: "interrupted", detail: input.detail, cause: RESTART_EVENT_CAUSE },
        visibility: "user",
        key: `${input.runId}:restart-ended`,
      },
    ],
  }).catch((error: unknown) => {
    console.error("[work] could not close the timeline of a run ended after a restart", {
      runId: input.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
}

/**
 * Whether the run about to be continued was set aside for a restart and is
 * coming back from it: its newest `paused` or `resumed` event is the runner's
 * own restart pause. A person who resumed it writes a `resumed` event of their
 * own first, so their resume is never labelled a restart.
 */
export async function resumingAfterRestart(input: { runId: string; userId: string }): Promise<boolean> {
  const latest = await prisma.workEvent.findFirst({
    where: { runId: input.runId, userId: input.userId, kind: { in: ["paused", "resumed"] } },
    orderBy: { seq: "desc" },
    select: { kind: true, payload: true },
  });
  if (latest?.kind !== "paused") return false;
  const payload = latest.payload;
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).cause === RESTART_EVENT_CAUSE
  );
}
