import { NextResponse } from "next/server";
import type { Prisma, WorkHost } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isOwnerEmail } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import {
  WORK_LIVE_STATUSES,
  WORK_PERMISSION_POLICIES,
  WORK_TARGETS,
  narrowestPolicy,
  selectTarget,
  type HostCapabilityView,
  type WorkCapability,
  type WorkPermissionPolicy,
  type WorkTarget,
} from "@/lib/work/domain";
import { createRun, type CreateRunResult } from "@/lib/work/store";
import { serializeRun } from "@/lib/work/serializers";
import { effectiveHostState, refusalForSelection, startRunSchema } from "@/app/api/work/protocol";

export const runtime = "nodejs";

// Abuse controls for run dispatch. A run holds an executor — a cloud container
// or a Mac the user is sitting at — for as long as the work takes, so the cost
// of an unbounded client is not a wasted request, it is a fleet.
/** Max runs a user may start per minute. */
const WORK_RUN_RATE_LIMIT = 10;
/** Max simultaneously live runs per user, across every session. */
const WORK_RUN_CONCURRENCY_CAP = 3;

/**
 * Whether cloud Work is accepting runs.
 *
 * A constant because there is one cloud executor and no kill switch in front of
 * it today. It is named and passed to `selectTarget` rather than assumed at the
 * call site so that turning cloud off — a paused executor, a provider outage —
 * is one edit here that produces the honest refusal `selectTarget` already
 * writes, instead of a queue of runs that nothing will ever claim.
 */
const CLOUD_WORK_AVAILABLE = true;

/**
 * What a host can currently do, from what the host itself advertised.
 *
 * Nothing is inferred. A capability the Mac did not claim is a capability it
 * does not have, because the failure of guessing is not a missing feature — it
 * is a run queued at a machine that cannot do the work, which looks exactly
 * like a run about to start.
 *
 * `local_apps` is the one derived entry, and it is derived from the list the
 * user filled in rather than from a toggle: app control with an empty allowlist
 * can drive nothing, so advertising it would offer a capability whose every
 * use is refused.
 */
function hostCapabilityView(host: WorkHost, now: Date): HostCapabilityView {
  const capabilities: WorkCapability[] = [];
  if (host.allowsFileWork) capabilities.push("local_files");
  if (host.allowsBrowser) capabilities.push("local_browser");
  if (host.allowsComputerUse) capabilities.push("local_computer_use");
  if (host.allowsShell) capabilities.push("local_shell");
  if (host.allowsBackground) capabilities.push("background_continuation");
  if (Array.isArray(host.allowedApps) && host.allowedApps.length > 0) capabilities.push("local_apps");

  return {
    hostId: host.id,
    displayName: host.displayName,
    state: effectiveHostState(host, now),
    enabled: host.enabled,
    revoked: host.revokedAt !== null,
    capabilities,
  };
}

/** Narrows a TEXT column to the vocabulary, falling back the way
 *  `serializers.ts` does: never widen a value this build cannot read. */
function targetOf(value: string): WorkTarget {
  return (WORK_TARGETS as readonly string[]).includes(value) ? (value as WorkTarget) : "automatic";
}

function policyOf(value: string): WorkPermissionPolicy {
  return (WORK_PERMISSION_POLICIES as readonly string[]).includes(value)
    ? (value as WorkPermissionPolicy)
    : "conservative";
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const session = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = startRunSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  // Idempotency is checked before the rate limit and before the cap, so a
  // client retrying a dispatch whose response it never saw gets its run back
  // rather than a 429 for asking twice. `createRun` re-checks the same key
  // under its own unique index; this read is what keeps the retry off the abuse
  // controls, which count attempts, not runs.
  if (body.idempotencyKey) {
    const existing = await prisma.workRun.findFirst({
      where: { userId: user.id, idempotencyKey: body.idempotencyKey },
    });
    if (existing) {
      return NextResponse.json({ run: serializeRun(existing), replay: true }, { status: 200 });
    }
  }

  const now = new Date();
  const hosts = await prisma.workHost.findMany({ where: { userId: user.id } });
  // Preferred host first: `selectTarget` picks the first fully capable host in
  // the list, so this is how "run it on the MacBook" is expressed to it.
  const ordered = session.preferredHostId
    ? [...hosts].sort((left, right) =>
        left.id === session.preferredHostId ? -1 : right.id === session.preferredHostId ? 1 : 0
      )
    : hosts;

  const requestedTarget = body.requestedTarget ?? targetOf(session.requestedTarget);
  const required = body.requiredCapabilities ?? [];
  const selection = selectTarget({
    requested: requestedTarget,
    required,
    hosts: ordered.map((host) => hostCapabilityView(host, now)),
    cloudAvailable: CLOUD_WORK_AVAILABLE,
  });

  // No executor can serve this. Refusing is the entire reason `selectTarget`
  // returns a null target: a queued run with nothing able to claim it is a
  // spinner that never resolves, and this 409 is the only moment anything in
  // the system is in a position to tell the user why. The explanation is passed
  // through untouched — it already names the Mac and its state, in the words
  // the user is shown.
  const refusal = refusalForSelection(selection);
  if (refusal) return NextResponse.json(refusal, { status: 409 });

  if (!isOwnerEmail(user.email)) {
    const limited = await rateLimit({
      key: `work-run:${user.id}`,
      limit: WORK_RUN_RATE_LIMIT,
      windowSec: 60,
    });
    if (!limited.success) {
      return NextResponse.json({ error: "Too many runs started. Try again shortly." }, { status: 429 });
    }
  }

  const host = selection.hostId ? hosts.find((candidate) => candidate.id === selection.hostId) : undefined;
  // The policy the executor will enforce, after narrowing. `narrowestPolicy` is
  // a `min`, so no layer can widen another: a host pinned to `conservative`
  // stays conservative under a `permissive` session, which is what makes the
  // toggle on the Mac mean anything at all. Stored with its inputs because the
  // approval digests are taken over this exact blob, and an approval granted
  // under one policy must be provably distinguishable from the same approval
  // under another.
  const permissionPolicy: Prisma.InputJsonValue = {
    policy: narrowestPolicy(policyOf(session.permissionPolicy), host ? policyOf(host.approvalPolicy) : null),
    session: policyOf(session.permissionPolicy),
    host: host ? policyOf(host.approvalPolicy) : null,
  };

  let created: CreateRunResult;
  try {
    created = await prisma.$transaction(async (tx) => {
      // The cap and the create are serialised per user by a transactional
      // advisory lock, because a plain count-then-create is a TOCTOU: N
      // parallel dispatches each read a count under the cap and all create.
      //
      // Two details are deliberate. It is the `try` variant, so a second
      // dispatch fails fast instead of queueing — a queue of waiters would each
      // hold a pooled connection while the holder needs a second one for
      // `createRun`, which exhausts the pool under exactly the burst this guard
      // exists for. And `createRun` is called from inside this callback even
      // though it opens its own transaction: that transaction commits before
      // this one releases the lock, so the next dispatch through here counts
      // the run this one just made. Moving the insert inline would mean
      // reimplementing attempt allocation and idempotency recovery, and those
      // are the two things that must never disagree with the store.
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`work-run-cap:${user.id}`})) AS locked
      `;
      if (!lock?.locked) throw new Error("dispatch_in_flight");

      const live = await tx.workRun.count({
        where: { userId: user.id, status: { in: [...WORK_LIVE_STATUSES] } },
      });
      if (live >= WORK_RUN_CONCURRENCY_CAP) {
        throw Object.assign(new Error("run_cap_exceeded"), { liveCount: live });
      }

      // One live run per session. A second attempt started while the first is
      // still going means two executors planning against one goal and writing
      // to the same granted folders, and the user watching one transcript while
      // two things happen. Retrying means cancelling first, which is a decision
      // only they can make.
      const alreadyLive = await tx.workRun.count({
        where: { sessionId: session.id, userId: user.id, status: { in: [...WORK_LIVE_STATUSES] } },
      });
      if (alreadyLive > 0) throw new Error("session_already_running");

      return createRun({
        sessionId: session.id,
        userId: user.id,
        origin: body.origin ?? "manual",
        requestedTarget,
        effectiveTarget: selection.target,
        hostId: selection.hostId,
        requestedModel: body.model ?? session.requestedModel,
        requiredCapabilities: required,
        availableCapabilities: selection.available,
        // Carried onto the run so the client can show, before any work starts,
        // that this attempt will do less than was asked. Recomputing it later
        // describes the fleet as it is then, not as it was at dispatch.
        degradation: selection.degradation,
        permissionPolicy,
        idempotencyKey: body.idempotencyKey ?? null,
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "dispatch_in_flight") {
      return NextResponse.json(
        { error: "dispatch_in_flight", message: "Another run is being started. Try again in a moment." },
        { status: 429 }
      );
    }
    if (err instanceof Error && err.message === "run_cap_exceeded") {
      const live = (err as Error & { liveCount?: number }).liveCount ?? WORK_RUN_CONCURRENCY_CAP;
      return NextResponse.json(
        {
          error: "run_cap_exceeded",
          message: `You already have ${live} runs in progress. Let one finish first.`,
        },
        { status: 429 }
      );
    }
    if (err instanceof Error && err.message === "session_already_running") {
      return NextResponse.json(
        {
          error: "session_already_running",
          message: "This session is already running. Cancel it before starting another attempt.",
        },
        { status: 409 }
      );
    }
    throw err;
  }

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
      ...(created.replay ? { replay: true } : {}),
    },
    { status: created.replay ? 200 : 201 }
  );
}
