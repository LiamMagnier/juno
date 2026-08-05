import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { WORK_LIVE_STATUSES } from "@/lib/work/domain";
import { appendEvents, finishRun, setSessionAttention } from "@/lib/work/store";
import { serializeRun } from "@/lib/work/serializers";
import { runControlSchema } from "@/app/api/work/protocol";

export const runtime = "nodejs";

/**
 * Statuses a run can be paused from.
 *
 * Derived from the live set rather than listed, so a status added to
 * `domain.ts` is pausable the day it ships. That is the safe direction: the
 * cost of being able to pause something unexpected is a run that stops, and the
 * cost of the other mistake is a user watching a run they have no way to
 * interrupt. `draft` is excluded because no run is ever in it — sessions are.
 */
const PAUSABLE_STATUSES = WORK_LIVE_STATUSES.filter(
  (status) => status !== "paused" && status !== "draft"
);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = runControlSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const run = await prisma.workRun.findFirst({
    where: { id, userId: user.id },
    select: { id: true, sessionId: true, status: true },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.action === "cancel") {
    // `finishRun` is the single writer of a terminal state, and its WHERE
    // excludes every terminal status — so a cancel racing the run's own failure
    // path cannot rewrite why the run ended. Count zero means somebody else got
    // there first, which is a 409 rather than a silent success: the client asked
    // to cancel a run that had already stopped for another reason, and telling
    // it otherwise would have it report the wrong cause to the user.
    const finished = await finishRun({
      runId: run.id,
      userId: user.id,
      reason: "cancelled",
      detail: "Cancelled by the user.",
    });
    if (!finished.finished) {
      return NextResponse.json(
        {
          error: "run_not_live",
          message: "This run has already stopped.",
          status: finished.run?.status ?? run.status,
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ run: serializeRun(finished.run) });
  }

  const pausing = parsed.data.action === "pause";
  // The condition lives in the WHERE, not in an if above it. Reading the status,
  // deciding, and then writing leaves a window in which the executor moves the
  // run underneath the decision — and the write lands anyway, dragging a
  // finished run back into `paused` or handing a running one to a second
  // claimer. Postgres re-evaluates this against the committed row, so exactly
  // one caller sees a count of 1.
  const moved = await prisma.workRun.updateMany({
    where: {
      id: run.id,
      userId: user.id,
      status: { in: pausing ? [...PAUSABLE_STATUSES] : ["paused"] },
    },
    data: pausing
      ? { status: "paused" }
      : {
          // Back to `queued`, with the lease released. A resumed run has to be
          // claimable again, and the executor that held it before the pause may
          // well be gone; leaving the lease in place would strand the run until
          // it expired on its own.
          status: "queued",
          claimedBy: null,
          claimedAt: null,
          leaseExpiresAt: null,
        },
  });

  if (moved.count === 0) {
    return NextResponse.json(
      {
        error: pausing ? "run_not_pausable" : "run_not_paused",
        message: pausing ? "This run is not running." : "This run is not paused.",
        status: run.status,
      },
      { status: 409 }
    );
  }

  const status = pausing ? "paused" : "queued";
  // The transcript records who stopped it. Without this the user comes back to
  // a run that halted with nothing in its own history saying why.
  await appendEvents({
    runId: run.id,
    userId: user.id,
    events: [{ kind: pausing ? "paused" : "resumed", payload: { actor: "web" } }],
  });
  await setSessionAttention({ sessionId: run.sessionId, userId: user.id, status });

  const updated = await prisma.workRun.findFirst({ where: { id: run.id, userId: user.id } });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ run: serializeRun(updated) });
}
