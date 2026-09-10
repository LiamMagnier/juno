import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { tallyTriageCounts } from "@/app/api/work/protocol";

export const runtime = "nodejs";

/**
 * `GET /api/work/sessions/counts` — how many tasks need the reader, are
 * running, are done, and exist at all, across the whole account.
 *
 * A route of its own rather than a widening of the list: the inbox polls the
 * list every few seconds while something runs, and the number a sidebar badge
 * wants is not a page of rows. One group-by over `(status, needsAttention)` is
 * the cheapest true answer, and it is the only one that cannot lose a task to
 * a page size — the failure the client-side tally had.
 *
 * Archived and soft-deleted sessions are excluded for the same reason the list
 * excludes them: the reader asked not to see them, and a badge that counted
 * them would be nagging about work they put away.
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;

  const rows = await prisma.workSession.groupBy({
    by: ["status", "needsAttention"],
    where: { userId: user.id, deletedAt: null, archived: false },
    _count: { _all: true },
  });

  return NextResponse.json({
    counts: tallyTriageCounts(
      rows.map((row) => ({
        status: row.status,
        needsAttention: row.needsAttention,
        count: row._count._all,
      }))
    ),
  });
}
