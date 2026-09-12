import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readPendingControls, requireTaskAuth } from "@/lib/code-remote";

export const runtime = "nodejs";

/**
 * The control events a host has not yet seen — the same list the events POST
 * hands back, readable without posting anything.
 *
 * Controls (cancel, steer, the rollback verbs) were delivered ONLY in the
 * response to a host's events POST. The cloud runner posts when it has
 * events to post, which during a two-minute test run is never — so an
 * instruction sent in that window sat unread until the agent's next tool
 * finished. The runner now reads this every couple of seconds when it has
 * been quiet, and a steer reaches it within that window instead of at the
 * end of whatever it was doing.
 *
 * `afterSeq` is the host's own control cursor, as on the POST. Same auth as
 * the POST — the task's own token or its owner's session — and nothing here
 * changes state, so a replayed read is harmless.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireTaskAuth(id, req);
  if (!user) return error;

  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true, status: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rawAfterSeq = Number(new URL(req.url).searchParams.get("afterSeq") ?? "0");
  const afterSeq = Number.isFinite(rawAfterSeq) && rawAfterSeq > 0 ? Math.floor(rawAfterSeq) : 0;
  const control = await readPendingControls(task.id, afterSeq);
  return NextResponse.json({ control, status: task.status }, { headers: { "Cache-Control": "no-store" } });
}
