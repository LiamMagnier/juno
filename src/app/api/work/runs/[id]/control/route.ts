import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { WORK_LIVE_STATUSES, type WorkCommandKind } from "@/lib/work/domain";
import { recordWorkAudit } from "@/lib/work/audit";
import {
  appendEvents,
  dispatchRunCommand,
  finishRun,
  setSessionAttention,
  type DispatchRunCommandResult,
} from "@/lib/work/store";
import { runCommandKey, startCommandPayload } from "@/lib/work/relay";
import { serializeCommand, serializeRun } from "@/lib/work/serializers";
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

/**
 * The run columns an instruction to the Mac is built from.
 *
 * `goal` is joined in because of `resume`, and only because of it.
 * `DesktopWorkRunHost.resumeRun` lifts the pause when it is already driving the
 * run — but a Mac that was relaunched in the meantime is not, and in that case
 * it starts the loop afresh and needs the goal in the payload exactly as
 * `start` does. Sending a resume without one would be refused with
 * `noGoal` by the one Mac that most needed to be told: the one that restarted.
 */
const RUN_FOR_CONTROL = {
  id: true,
  sessionId: true,
  status: true,
  hostId: true,
  effectiveTarget: true,
  effectiveModel: true,
  session: { select: { goal: true } },
} as const;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = runControlSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const run = await prisma.workRun.findFirst({
    where: { id, userId: user.id },
    select: RUN_FOR_CONTROL,
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  /**
   * Sends one instruction to the Mac executing this run, if it is on one.
   *
   * Every branch below calls this AFTER its own write has committed, and that
   * order is deliberate. The database is what every other surface reads, so a
   * command queued before the row moved would be a Mac pausing a run the web
   * still renders as running — and if the write then failed, a Mac paused for a
   * decision nobody took.
   *
   * A refusal never fails the request. By the time it can happen the decision
   * is committed, and answering with an error would tell the client nothing
   * happened when half of it did; the honest report is a `command` of null and
   * a row in the compliance log. The case that reaches it is a Mac revoked or
   * switched off since this run started, and that run is already over in every
   * sense that matters — the lease sweep is what will say so.
   */
  const tell = async (
    kind: WorkCommandKind,
    payload: Record<string, unknown>,
    discriminator?: string | number
  ): Promise<DispatchRunCommandResult> => {
    const result = await dispatchRunCommand({
      userId: user.id,
      sessionId: run.sessionId,
      runId: run.id,
      hostId: run.hostId,
      effectiveTarget: run.effectiveTarget,
      kind,
      payload,
      idempotencyKey: runCommandKey(run.id, kind, discriminator),
    });
    if (result.status === "refused") {
      await recordWorkAudit({
        userId: user.id,
        kind: result.refusal.audit,
        severity: result.refusal.severity,
        actor: "web",
        hostId: run.hostId,
        sessionId: run.sessionId,
        runId: run.id,
        detail: { commandKind: kind, reason: result.refusal.code },
      });
    }
    return result;
  };

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

    // A cancel is two separate facts and the terminal one still belongs to
    // `finishRun` alone: this is the second, which is that a Mac somewhere is
    // still running a model loop over somebody's folders and has to be told to
    // stop. Only the winner of the conditional update above gets here, so a
    // second cancel cannot queue a second stop — and the derived key would
    // resolve to the same row if it somehow did.
    const stopped = await tell("stop", { reason: "Cancelled by the user." });
    return NextResponse.json({
      run: serializeRun(finished.run),
      command: stopped.status === "queued" ? serializeCommand(stopped.command) : null,
    });
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
  const appended = await appendEvents({
    runId: run.id,
    userId: user.id,
    events: [{ kind: pausing ? "paused" : "resumed", payload: { actor: "web" } }],
  });
  await setSessionAttention({ sessionId: run.sessionId, userId: user.id, status });

  // Keyed on the seq of the event just appended, because a run can be paused
  // and resumed any number of times and each is a distinct instruction. A key
  // that named only the run would fold the third pause into the first, which
  // the upsert would answer with a command the Mac executed an hour ago.
  const told = await tell(
    pausing ? "pause" : "resume",
    // Nothing for a pause: the Mac parks the run it is already driving and
    // needs nothing said about it. A resume carries the whole start payload,
    // for the Mac that was relaunched while the run was parked and has no loop
    // left to lift the pause on.
    pausing ? {} : startCommandPayload({ goal: run.session.goal, model: run.effectiveModel }),
    appended.lastSeq
  );

  const updated = await prisma.workRun.findFirst({ where: { id: run.id, userId: user.id } });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    run: serializeRun(updated),
    command: told.status === "queued" ? serializeCommand(told.command) : null,
  });
}
