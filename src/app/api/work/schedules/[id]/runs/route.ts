import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, serializeTask } from "@/lib/code-remote";
import { serializeRun } from "@/lib/work/serializers";
import { parseScheduleRunListQuery } from "@/lib/work/schedule";

export const runtime = "nodejs";

/**
 * What this automation has actually done.
 *
 * Every fire that was dealt with appears here, including the ones that did not
 * run: the scheduler writes a finished run for a fire dropped because the Mac
 * was away or the budget was spent, so "it has been skipping every morning for
 * a fortnight" is visible rather than being the absence of something. Runs that
 * were merely delayed are not here, and should not be — they happen, a minute
 * or five minutes later, and a row for each attempt to start them would bury
 * the ones that matter.
 *
 * TWO LISTS, BECAUSE A ROUTINE HAS TWO KINDS OF ROW
 *
 * A Code routine's runs are `CodeTask`s — there is no `WorkRun` behind them —
 * and they come back under `codeRuns`. `runs` still carries the scheduler's own
 * marker rows for both kinds, which are the record that a fire was dealt with
 * rather than a record of a run: a fire skipped for budget is a `WorkRun` even
 * on a Code routine, because inventing a Code session that cloned nothing to
 * say "the budget was spent" would put a run in the reader's Code sidebar that
 * never happened.
 *
 * Two keys rather than one merged list, because the two shapes are genuinely
 * different — a `WorkRun` has attempts and a terminal reason, a `CodeTask` has
 * a status, a branch and a pull request — and flattening them would mean
 * inventing a shape that is neither and that every reader has to un-flatten.
 * The client interleaves them by `createdAt`, which is the only ordering both
 * agree on.
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
    select: { id: true, runKind: true },
  });
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const where = { userId: user.id, scheduleId: id, ...(before ? { createdAt: { lt: before } } : {}) };
  const [runs, codeRuns] = await Promise.all([
    prisma.workRun.findMany({
      where,
      // Newest first, which is what a history view opens on, and the direction
      // the `(scheduleId, createdAt)` index is built for.
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    // Only asked of a Code routine. A Work routine has no Code runs by
    // construction, and a query per page that can only answer zero is a query
    // for nothing.
    schedule.runKind === "code"
      ? prisma.codeTask.findMany({ where, orderBy: { createdAt: "desc" }, take: limit })
      : Promise.resolve([]),
  ]);

  return NextResponse.json({
    runs: runs.map(serializeRun),
    // The prompt is left out: it is the automation's own instructions, already
    // on the page above this list, and repeating it once per row is the whole
    // text of the routine sent back as many times as it has fired.
    codeRuns: codeRuns.map((task) => serializeTask(task, { includePrompt: false })),
    // Absent on a short page. A client that pages until this is missing cannot
    // loop for ever, which is the failure a cursor echoed back unconditionally
    // produces on the last page. Taken from whichever list is full, so a
    // routine whose Code runs outnumber its marker rows still pages.
    ...(runs.length === limit || codeRuns.length === limit
      ? {
          nextBefore: newerOf(
            runs.length === limit ? runs[runs.length - 1].createdAt : null,
            codeRuns.length === limit ? codeRuns[codeRuns.length - 1].createdAt : null
          ),
        }
      : {}),
  });
}

/**
 * The NEWER of two page ends, which is the cursor that loses nothing.
 *
 * Both lists are paged by one `before`, so the next page has to start from the
 * newer of the two last rows. Starting from the older one would skip whatever
 * the other list still holds between them; starting from the newer repeats a
 * few rows the caller has already seen, and a repeated row is a cosmetic
 * problem where a skipped one is a run that never appears in the history.
 */
function newerOf(left: Date | null, right: Date | null): string | undefined {
  if (!left) return right?.toISOString();
  if (!right) return left.toISOString();
  return (left.getTime() > right.getTime() ? left : right).toISOString();
}
