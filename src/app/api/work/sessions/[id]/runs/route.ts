import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { serializeRun } from "@/lib/work/serializers";
import { startWorkRunForUser } from "@/lib/work/dispatch";
import { parseSessionRunListQuery, startRunSchema } from "@/app/api/work/protocol";

export const runtime = "nodejs";

/**
 * Every attempt this task has made.
 *
 * A retry is an experiment, and the attempts panel on the detail page is the
 * only place the previous conditions are readable: did it get further this
 * time, did it cost more, did it run somewhere else, was it the same model.
 * Every one of those attempts has always existed as its own `WorkRun` row —
 * nothing new is recorded here, it is only read back. Until this handler
 * existed the panel's fetch answered 405 on every multi-attempt task and the
 * panel fell back to a sentence apologising for history it was sitting on.
 *
 * Ordered by `attempt` rather than by `createdAt`, which is the one deliberate
 * difference from the sibling schedule handler. `attempt` is what a person
 * means by "the second try", it is what the panel labels each row with, and
 * `@@unique([sessionId, attempt])` both guarantees it is a total order within
 * the session and serves the sort from an index. `createdAt` is the right key
 * for a schedule, whose runs belong to no numbered sequence; here it would be a
 * second, weaker answer to a question `attempt` already answers exactly.
 *
 * The current attempt is included rather than filtered out. The panel marks it
 * "this one" and needs it in the same list to do so, and a client asking for a
 * task's attempts and getting all but one of them would be the more surprising
 * contract.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const { limit } = parseSessionRunListQuery(new URL(req.url).searchParams);

  // The session is looked up first even though the run query is scoped by
  // `sessionId` and `userId` anyway, so an id belonging to somebody else
  // answers 404 rather than an empty list — an empty list is indistinguishable
  // from a task that has never run, and confirms the id exists. Soft-deleted
  // sessions are 404 here for the same reason they are in POST and in the
  // detail route: the page that would render this panel is already gone.
  const session = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const runs = await prisma.workRun.findMany({
    where: { userId: user.id, sessionId: id },
    // Newest attempt first, which is what the panel opens on and the direction
    // it reads backwards from.
    orderBy: { attempt: "desc" },
    take: limit,
  });

  return NextResponse.json({ runs: runs.map(serializeRun) });
}

/**
 * Starts an attempt at a task.
 *
 * The session is found and the body parsed here, in that order, so a missing
 * task still answers 404 before a malformed body answers 400. Everything after
 * that (the plan gate, the usage window, target and model selection, the cost
 * preflight, the rate limit, the concurrency cap and the run itself) is
 * `startWorkRunForUser` in src/lib/work/dispatch.ts, shared with the chat
 * model's `start_task` tool, and its response is written out as it comes back.
 */
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

  const result = await startWorkRunForUser(user, session, parsed.data);
  return NextResponse.json(result.body, { status: result.status });
}
