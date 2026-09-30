import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { serializeSession } from "@/lib/work/serializers";
import { createWorkSessionForUser } from "@/lib/work/dispatch";
import {
  createSessionSchema,
  parseSessionListQuery,
  sessionListOrder,
} from "@/app/api/work/protocol";
import { CONVERSATION_WAITING_STATUSES, waitingTasksFirst } from "@/lib/work/conversation-tasks";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = parseSessionListQuery(new URL(req.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid input", parameter: parsed.parameter }, { status: 400 });
  }
  const { status, needsAttention, pinned, archived, projectId, conversationId, limit } =
    parsed.query;

  const where = {
    userId: user.id,
    // Soft-deleted sessions are never listed. The row survives so an audit
    // question about what ran can still be answered; the user asked for it to
    // be gone from their list, and that is what the list must honour.
    deletedAt: null,
    archived,
    ...(status ? { status } : {}),
    ...(needsAttention !== undefined ? { needsAttention } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(projectId ? { projectId } : {}),
    // The chat asking about its own run. Scoped by `userId` like every other
    // clause here, so an id guessed from another account selects nothing
    // rather than reading that account's task.
    ...(conversationId ? { conversationId } : {}),
  };
  // One conversation asking for its task (the apps that follow one task per
  // chat): a task waiting on the person comes before a newer one that is
  // running, or its question could not be answered from the chat
  // (`waitingTasksFirst`). Not when the caller asked for a status of its own.
  const waiting =
    conversationId && !status
      ? await prisma.workSession.findMany({
          where: { ...where, status: { in: [...CONVERSATION_WAITING_STATUSES] } },
          orderBy: { lastActivityAt: "desc" },
          take: limit,
        })
      : [];
  const listed = await prisma.workSession.findMany({
    where,
    // Pinned first, except when one conversation is being asked about its own
    // task — the argument is written out over `sessionListOrder`.
    orderBy: sessionListOrder(parsed.query),
    take: limit,
  });
  const sessions = waitingTasksFirst(waiting, listed, limit);

  /*
   * What each executing task is doing right now, for the row's status line.
   *
   * The inbox used to say "Working on it now." for every running row, which
   * is the pill restated. The plan step the run is on is the sentence a reader
   * triaging a list actually wants, and the executor already records it:
   * `step_started` carries the step's title. One query for the whole page — the
   * newest `step_started` per live run — rather than a join per row, and only
   * when a row is executing at all, so an idle inbox costs nothing extra.
   *
   * Scoped through the run rather than by run id: a session's status is
   * denormalised from its current attempt, and only one attempt per session can
   * be executing (`session_already_running`), so the executing run IS the
   * current one.
   */
  const executing = sessions
    .filter((session) => session.status === "preparing" || session.status === "running")
    .map((session) => session.id);
  const steps =
    executing.length === 0
      ? []
      : await prisma.workEvent.findMany({
          where: {
            userId: user.id,
            kind: "step_started",
            run: {
              userId: user.id,
              sessionId: { in: executing },
              status: { in: ["preparing", "running"] },
            },
          },
          orderBy: [{ runId: "asc" }, { seq: "desc" }],
          distinct: ["runId"],
          select: { payload: true, run: { select: { sessionId: true } } },
        });
  const currentStep = new Map<string, string>();
  for (const step of steps) {
    const payload = step.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const title = (payload as { title?: unknown }).title;
    if (typeof title === "string" && title.trim().length > 0) {
      currentStep.set(step.run.sessionId, title.trim());
    }
  }

  return NextResponse.json({
    sessions: sessions.map((session) => ({
      ...serializeSession(session),
      // Beside the serialised row rather than inside `serializeSession`: it is
      // a fact about the list view, read from another table, and the session
      // shape every other route and the native clients decode stays as it was.
      currentStep: currentStep.get(session.id) ?? null,
    })),
  });
}

/**
 * Creates a task, as a draft that costs nothing until a run is started.
 *
 * Everything after authentication and parsing lives in
 * `createWorkSessionForUser` (src/lib/work/dispatch.ts), which the chat
 * model's `start_task` tool also calls: the same checks, the same idempotent
 * replay, and the same response bodies, which this handler writes out as they
 * come back.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = createSessionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const result = await createWorkSessionForUser(user, parsed.data);
  return NextResponse.json(result.body, { status: result.status });
}
