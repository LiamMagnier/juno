import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { driveResearchInBackground, readResearchRun } from "@/lib/research/run";
import { isWorkingResearchState } from "@/lib/research/domain";

export const runtime = "nodejs";

/**
 * The run, and everything that has happened since the client's cursor.
 *
 * Polled rather than streamed. The Work session stream is SSE because a coding
 * agent emits a line a second and latency is the whole experience; a research
 * run emits a handful of events a minute, and an SSE endpoint held open for the
 * ten minutes one takes costs a server connection per viewer to deliver about
 * forty rows. The panel polls on an interval that follows the run's own state.
 *
 * `after` is the last `seq` the client rendered. State and events come back in
 * the same response deliberately: a client that read events at t and state at
 * t+1 renders a finished run still showing a live stage, which is exactly the
 * confusion the stage list exists to remove.
 */

const EVENT_PAGE = 200;

/**
 * How long a working run may go without its row being touched before this
 * route assumes nobody is driving it.
 *
 * Every step writes — a state move, an event, a spend — so a working run whose
 * `updatedAt` has not moved in this long has lost its driver: the process that
 * held it was recycled, redeployed or killed mid-fetch. Picking it back up here
 * is what makes the job durable in practice rather than only in principle,
 * because the alternative is a run that sits in `searching` for ever with the
 * user watching a stage that will never advance. Generous enough that a slow
 * model call is never mistaken for a dead process.
 */
const STALE_AFTER_MS = 3 * 60_000;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const url = new URL(req.url);
  const rawAfter = Number(url.searchParams.get("after") ?? "0");
  const after = Number.isFinite(rawAfter) && rawAfter > 0 ? Math.floor(rawAfter) : 0;

  const view = await readResearchRun({ runId: id, userId: user.id, after, limit: EVENT_PAGE });
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (isWorkingResearchState(view.run.state)) {
    const row = await prisma.researchRun.findFirst({
      where: { id, userId: user.id },
      select: { updatedAt: true },
    });
    if (row && Date.now() - row.updatedAt.getTime() > STALE_AFTER_MS) {
      // Fire and forget. `drive` re-reads the run before every step, so a
      // second driver that turns out not to be needed loses the conditional
      // state write and stops without having spent anything.
      driveResearchInBackground({ runId: id, userId: user.id });
    }
  }

  return NextResponse.json(view);
}
