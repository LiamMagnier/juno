import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isOwnerEmail } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { WORK_LIVE_STATUSES, narrowestPolicy, selectTarget } from "@/lib/work/domain";
import { createRun } from "@/lib/work/store";
import { serializeRun } from "@/lib/work/serializers";
import {
  hostCapabilityView,
  parseScheduleRunConfig,
  permissionPolicyOf,
  runNowSchema,
  scheduleTargetOf,
  unattendedPolicyOf,
  type JsonObject,
} from "@/lib/work/schedule";
import { effectiveHostState, refusalForSelection } from "@/app/api/work/protocol";

export const runtime = "nodejs";

/** Max manual fires of any schedule per user per minute. A run holds an
 *  executor for as long as the work takes, so the cost of an unbounded client
 *  is not a wasted request. */
const RUN_NOW_RATE_LIMIT = 10;

/** Matches the constant the run-dispatch route holds, and for the same reason:
 *  turning cloud off should produce an honest refusal here rather than a queue
 *  of runs nothing will ever claim. */
const CLOUD_WORK_AVAILABLE = true;

/**
 * Runs a schedule once, now, without moving it.
 *
 * The absence of any write to `nextRunAt`, `lastRunAt` or `lockedUntil` is the
 * entire point of this route rather than an omission. The legacy `executeTask`
 * calls `advance()` on every exit path, so wiring a Run-now button to it would
 * mean pressing "run it now" quietly cancels this evening's scheduled run —
 * a button that appears to do one thing and also does the opposite of another.
 * Here the schedule is read and never written: whatever it was going to do
 * next, it still does.
 *
 * The run is `manual` in origin, because a person asked for it, but it still
 * carries the schedule's unattended policy. Pressing a button is not agreeing
 * in advance to whatever the run decides to delete; the person who pressed it
 * has very likely closed the tab, and the policy they set for this schedule is
 * the last thing they actually said about that.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = runNowSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const schedule = await prisma.workSchedule.findFirst({
    where: { id, userId: user.id },
    include: { session: true },
  });
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Scoped to the schedule so a manual fire of one cannot be replayed as a
  // manual fire of another, and prefixed so it can never collide with the key a
  // scheduled fire of this same schedule mints.
  const idempotencyKey = parsed.data.idempotencyKey ? `wnow:${id}:${parsed.data.idempotencyKey}` : null;
  // Checked before the rate limit, so a client retrying a dispatch whose
  // response it never saw gets its run back rather than a 429 for asking twice.
  if (idempotencyKey) {
    const existing = await prisma.workRun.findFirst({ where: { userId: user.id, idempotencyKey } });
    if (existing) {
      return NextResponse.json({ run: serializeRun(existing), replay: true }, { status: 200 });
    }
  }

  const live = await prisma.workRun.count({
    where: { userId: user.id, scheduleId: id, status: { in: [...WORK_LIVE_STATUSES] } },
  });
  if (live >= Math.max(1, schedule.maxConcurrentRuns)) {
    // The same cap the scheduler honours. Bypassing it here would let a person
    // start by hand exactly the pile-up the schedule's own setting exists to
    // prevent, against the same granted folders.
    return NextResponse.json(
      {
        error: "schedule_already_running",
        message: "This schedule is already running. Let it finish before starting another.",
      },
      { status: 409 }
    );
  }

  const now = new Date();
  const runConfig = parseScheduleRunConfig(schedule.runConfig);
  const hosts = await prisma.workHost.findMany({ where: { userId: user.id } });
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

  // A manual fire refuses rather than falling back on `hostOfflinePolicy`. That
  // policy answers "what should happen at 07:00 while I am asleep"; somebody
  // who has just pressed a button is here to be told the Mac is off, and to
  // decide for themselves.
  const refusal = refusalForSelection(selection);
  if (refusal) return NextResponse.json(refusal, { status: 409 });

  if (!isOwnerEmail(user.email)) {
    const limited = await rateLimit({
      key: `work-schedule-run-now:${user.id}`,
      limit: RUN_NOW_RATE_LIMIT,
      windowSec: 60,
    });
    if (!limited.success) {
      return NextResponse.json({ error: "Too many runs started. Try again shortly." }, { status: 429 });
    }
  }

  const host = selection.hostId ? ordered.find((candidate) => candidate.id === selection.hostId) : undefined;
  const sessionPolicy = permissionPolicyOf(schedule.session.permissionPolicy);
  const hostPolicy = host ? permissionPolicyOf(host.approvalPolicy) : null;
  const permissionPolicy: JsonObject = {
    // `narrowestPolicy` is a `min`, so no layer can widen another: a Mac pinned
    // to `conservative` stays conservative under a `permissive` session.
    policy: narrowestPolicy(sessionPolicy, hostPolicy),
    session: sessionPolicy,
    host: hostPolicy,
    unattended: unattendedPolicyOf(schedule.unattendedPolicy),
    // True: a person is here, so the executor may ask them a question rather
    // than checkpointing on the first one. It does NOT relax the unattended
    // policy above, which is about what may be done without being asked.
    attended: true,
  };

  const created = await createRun({
    sessionId: schedule.sessionId,
    userId: user.id,
    // `manual`, not `schedule`. A person asked for this one, and labelling it
    // otherwise would put it in the schedule's fired-on-time history and make
    // the schedule look like it ran when it did not.
    origin: "manual",
    // Still attributed to the schedule, so it appears in this schedule's run
    // history — which is where somebody who pressed the button will look.
    scheduleId: schedule.id,
    requestedTarget: scheduleTargetOf(schedule.target),
    effectiveTarget: selection.target,
    hostId: selection.hostId,
    requestedModel: runConfig.model ?? schedule.session.requestedModel,
    requiredCapabilities: runConfig.requiredCapabilities,
    availableCapabilities: selection.available,
    degradation: selection.degradation,
    permissionPolicy,
    budget: {
      maxCostMicroUsd: schedule.maxCostMicroUsd,
      maxTokens: schedule.maxTokens,
      maxRuntimeMs: schedule.maxRuntimeMs,
    },
    idempotencyKey,
  });

  return NextResponse.json(
    {
      run: serializeRun(created.run),
      selection: {
        target: selection.target,
        hostId: selection.hostId,
        explanation: selection.explanation,
        missing: selection.missing,
        degradation: selection.degradation,
      },
      // Stated back so a client never has to infer it from the absence of a
      // change: this route deliberately leaves the schedule exactly as it was.
      nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
      ...(created.replay ? { replay: true } : {}),
    },
    { status: created.replay ? 200 : 201 }
  );
}
