import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { serializeSession } from "@/lib/work/serializers";
import { createWorkSession } from "@/lib/work/store";
import { createSessionSchema, parseSessionListQuery } from "@/app/api/work/protocol";

export const runtime = "nodejs";

/**
 * The primary key a retried create lands on.
 *
 * `WorkSession` has no `(userId, idempotencyKey)` index — the column does not
 * exist on the model — so the primary key is the only uniqueness constraint a
 * session has, and deriving it from the caller's key is what turns "create this
 * session" into "create this session once". Both inputs are hashed together, so
 * two accounts using the same key cannot collide, and a key cannot be used to
 * guess or occupy another account's session id.
 *
 * `createWorkSession` takes this as its optional `id`, so the columns a session
 * starts life with are still written in exactly one place. Without idempotency
 * the normal outcome on mobile is a second session for every retried tap on a
 * flaky connection, not an exotic one.
 */
function idempotentSessionId(userId: string, key: string): string {
  return `wsi_${createHash("sha256").update(`${userId}\n${key}`, "utf8").digest("hex").slice(0, 32)}`;
}

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = parseSessionListQuery(new URL(req.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid input", parameter: parsed.parameter }, { status: 400 });
  }
  const { status, needsAttention, pinned, archived, projectId, limit } = parsed.query;

  const sessions = await prisma.workSession.findMany({
    where: {
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
    },
    // Pinned first so a session the user pinned does not fall off the end of a
    // clamped page, then most recently active — which is the order the indexes
    // on (userId, lastActivityAt) are built for.
    orderBy: [{ pinned: "desc" }, { lastActivityAt: "desc" }],
    take: limit,
  });

  return NextResponse.json({ sessions: sessions.map(serializeSession) });
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = createSessionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { goal, title, requestedTarget, preferredHostId, projectId, model, idempotencyKey } = parsed.data;

  // Cross-entity ownership is re-checked here rather than trusted from the
  // body: a host id or a project id in a request is a claim, and the only thing
  // that makes it true is a row that also carries this user's id.
  if (preferredHostId) {
    const host = await prisma.workHost.findFirst({
      where: { id: preferredHostId, userId: user.id },
      select: { id: true },
    });
    if (!host) return NextResponse.json({ error: "Host not found" }, { status: 404 });
  }
  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const sessionId = idempotencyKey ? idempotentSessionId(user.id, idempotencyKey) : undefined;
  if (sessionId) {
    // Turns the common sequential retry into a clean replay instead of a 500
    // from the unique violation. The catch below is what handles the two
    // requests that raced past this read.
    const existing = await prisma.workSession.findFirst({ where: { id: sessionId, userId: user.id } });
    if (existing) {
      return NextResponse.json({ session: serializeSession(existing), replay: true }, { status: 200 });
    }
  }

  try {
    const session = await createWorkSession({
      ...(sessionId ? { id: sessionId } : {}),
      userId: user.id,
      // The goal doubles as the name until the user or the planner picks a
      // better one; `titleSource` stays "default" so an auto-title may still
      // replace it, and a user rename sets it to "manual" and stops that.
      title: title ?? goal.slice(0, 60),
      goal,
      projectId: projectId ?? null,
      requestedTarget,
      preferredHostId: preferredHostId ?? null,
      requestedModel: model ?? null,
    });
    return NextResponse.json({ session: serializeSession(session) }, { status: 201 });
  } catch (err) {
    // Two identical creates raced past the pre-check above: the primary key
    // rejects the loser, which then reads the winner. From the caller's point
    // of view the session it asked for now exists, which is what it wanted.
    if (
      sessionId &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await prisma.workSession.findFirst({ where: { id: sessionId, userId: user.id } });
      if (winner) {
        return NextResponse.json({ session: serializeSession(winner), replay: true }, { status: 200 });
      }
    }
    throw err;
  }
}
