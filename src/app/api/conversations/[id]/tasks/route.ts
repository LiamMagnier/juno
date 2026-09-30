import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { serializeSession } from "@/lib/work/serializers";
import {
  CONVERSATION_LIVE_STATUSES,
  MAX_LIVE_TASKS_PER_CONVERSATION,
  tasksToDraw,
} from "@/lib/work/conversation-tasks";
import { WORK_TERMINAL_STATUSES } from "@/lib/work/domain";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Every task a conversation draws: all of its live ones, and the newest
 * finished one when there is room beside them, oldest first (the order the
 * cards stack in).
 *
 * The chat asks this instead of `GET /api/work/sessions?conversationId=&limit=1`
 * now that a conversation can carry several tasks. That route is unchanged, so
 * a client that follows only the newest task (the apps that shipped before
 * this) keeps getting exactly what it got.
 *
 * Two indexed reads on `conversationId`, scoped by `userId` like every Work
 * read: an id from another account selects nothing.
 */
const MAX_LIVE_READ = 20;

export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  if (!id || id.length > 200) {
    return NextResponse.json({ error: "invalid_input", message: "That conversation id is not valid." }, { status: 400 });
  }

  const [live, finished] = await Promise.all([
    prisma.workSession.findMany({
      where: {
        userId: user.id,
        conversationId: id,
        deletedAt: null,
        status: { in: [...CONVERSATION_LIVE_STATUSES] },
      },
      orderBy: { createdAt: "asc" },
      take: MAX_LIVE_READ,
    }),
    prisma.workSession.findFirst({
      where: {
        userId: user.id,
        conversationId: id,
        deletedAt: null,
        status: { in: [...WORK_TERMINAL_STATUSES] },
      },
      orderBy: { lastActivityAt: "desc" },
    }),
  ]);

  const serialized = [...live, ...(finished ? [finished] : [])].map(serializeSession);
  return NextResponse.json(
    {
      sessions: tasksToDraw(serialized),
      cap: MAX_LIVE_TASKS_PER_CONVERSATION,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
