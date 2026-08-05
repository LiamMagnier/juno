import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { serializeRun } from "@/lib/work/serializers";
import { parseScheduleRunListQuery } from "@/lib/work/schedule";

export const runtime = "nodejs";

/**
 * What this schedule has actually done.
 *
 * Every fire that was dealt with appears here, including the ones that did not
 * run: the scheduler writes a finished run for a fire dropped because the Mac
 * was away or the budget was spent, so "it has been skipping every morning for
 * a fortnight" is visible rather than being the absence of something. Runs that
 * were merely delayed are not here, and should not be — they happen, a minute
 * or five minutes later, and a row for each attempt to start them would bury
 * the ones that matter.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = parseScheduleRunListQuery(new URL(req.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid input", parameter: parsed.parameter }, { status: 400 });
  }
  const { before, limit } = parsed.query;

  // The schedule is looked up first even though the run query is scoped by
  // `scheduleId` anyway, so an id belonging to somebody else answers 404 rather
  // than an empty list — an empty list is indistinguishable from a schedule
  // that has never run, and confirms the id exists.
  const schedule = await prisma.workSchedule.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const runs = await prisma.workRun.findMany({
    where: {
      userId: user.id,
      scheduleId: id,
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    // Newest first, which is what a history view opens on, and the direction
    // the `(scheduleId, createdAt)` index is built for.
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({
    runs: runs.map(serializeRun),
    // Absent on a short page. A client that pages until this is missing cannot
    // loop for ever, which is the failure a cursor echoed back unconditionally
    // produces on the last page.
    ...(runs.length === limit
      ? { nextBefore: runs[runs.length - 1].createdAt.toISOString() }
      : {}),
  });
}
