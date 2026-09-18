import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isOwnerEmail } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { serializeRun } from "@/lib/work/serializers";
import { runNowSchema } from "@/lib/work/schedule";
import { fireRefusalStatus, fireScheduleNow } from "@/lib/work/fire-now";
import { refusalForSelection } from "@/app/api/work/protocol";

export const runtime = "nodejs";

/** Max manual fires of any schedule per user per minute. A run holds an
 *  executor for as long as the work takes, so the cost of an unbounded client
 *  is not a wasted request. */
const RUN_NOW_RATE_LIMIT = 10;

/**
 * Runs a routine once, now, without moving it.
 *
 * The decisions — no write to `nextRunAt`, the routine's unattended policy
 * carried onto a run a person started, the concurrency cap honoured rather than
 * bypassed — live in `src/lib/work/fire-now.ts`, because an `api` trigger's
 * fire URL asks this same question and two implementations of it would disagree
 * about exactly those three things. This route is the half that is only about
 * the browser: who is asking, how often they may ask, and what the answer looks
 * like on the wire.
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

  const fired = await fireScheduleNow({
    schedule,
    userId: user.id,
    // `manual`, not `schedule`. A person asked for this one, and labelling it
    // otherwise would put it in the routine's fired-on-time history and make
    // the routine look like it ran when it did not.
    origin: "manual",
    // True: a person is here, so the executor may ask them a question rather
    // than checkpointing on the first one. It does NOT relax the unattended
    // policy, which is about what may be done without being asked.
    attended: true,
    // A person pressing a button sends no text. Only a token fire does.
    fireText: null,
    now: new Date(),
    idempotencyKey,
  });

  if (fired.outcome === "refused") {
    // `refusalForSelection` writes the sentence the rest of Work shows for an
    // absent Mac, including which capabilities were missing, so a refusal about
    // a target keeps its detail rather than being flattened to one string.
    const refusal = fired.selection ? refusalForSelection(fired.selection) : null;
    return NextResponse.json(
      refusal ?? {
        error: fired.reason,
        message: fired.message,
        // Present only on the window refusal, and worth carrying: it is what
        // lets the button say WHICH limit and when it frees up rather than a
        // bare "could not start".
        ...(fired.window ? { window: fired.window, resetsAtMs: fired.resetsAtMs ?? null } : {}),
      },
      { status: fireRefusalStatus(fired.reason) }
    );
  }

  if (fired.outcome === "code_run") {
    return NextResponse.json(
      {
        // A Code routine's run is a Code session, not a `WorkRun`, so it is
        // named as one: the client opens the conversation rather than looking
        // for a run row that does not exist.
        codeRun: { taskId: fired.taskId, conversationId: fired.conversationId },
        nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
        ...(fired.replay ? { replay: true } : {}),
      },
      { status: fired.replay ? 200 : 201 }
    );
  }

  return NextResponse.json(
    {
      run: serializeRun(fired.run),
      selection: {
        target: fired.selection.target,
        hostId: fired.selection.hostId,
        explanation: fired.selection.explanation,
        missing: fired.selection.missing,
        degradation: fired.selection.degradation,
      },
      // Stated back so a client never has to infer it from the absence of a
      // change: this route deliberately leaves the routine exactly as it was.
      nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
      ...(fired.replay ? { replay: true } : {}),
    },
    { status: fired.replay ? 200 : 201 }
  );
}
