import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { WORK_LIVE_STATUSES } from "@/lib/work/domain";
import { finishRun } from "@/lib/work/store";
import { serializeRun, serializeSession } from "@/lib/work/serializers";
import { pendingApprovalsForRun } from "@/lib/work/approvals";
import { patchSessionSchema } from "@/app/api/work/protocol";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const session = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The current run is the highest attempt, not the most recently updated: a
  // superseded run finishing after its replacement started would otherwise be
  // handed back as the current one, and the client would render the new run's
  // session with the old run's terminal reason.
  const run = await prisma.workRun.findFirst({
    where: { sessionId: session.id, userId: user.id },
    orderBy: { attempt: "desc" },
  });

  // Approvals travel with the run, not separately.
  //
  // The clients decode an `approvals` key here and this route never sent one,
  // so a task that had stopped to ask permission looked, on the Mac and the
  // phone, exactly like a task that was still working. See
  // `pendingApprovalsForRun`.
  return NextResponse.json({
    session: serializeSession(session),
    run: run ? serializeRun(run) : null,
    approvals: await pendingApprovalsForRun(run?.id, user.id),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = patchSessionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const existing = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { title, pinned, archived } = parsed.data;
  const session = await prisma.workSession.update({
    where: { id, userId: user.id },
    data: {
      // A rename claims the title for the user: `titleSource: "manual"` is what
      // stops an auto-titler from overwriting it on the next run, which is the
      // same guarantee `canAutoRenameChatTitle` gives a chat.
      ...(title !== undefined ? { title, titleSource: "manual" } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(archived !== undefined ? { archived } : {}),
    },
  });

  return NextResponse.json({ session: serializeSession(session) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const session = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Stop anything that is still executing BEFORE the row disappears from the
  // user's list. A deleted session whose run is still going keeps spending the
  // plan's budget, keeps touching granted folders, and is invisible in every
  // surface that could be used to stop it.
  const live = await prisma.workRun.findMany({
    where: { sessionId: session.id, userId: user.id, status: { in: [...WORK_LIVE_STATUSES] } },
    select: { id: true },
  });
  for (const run of live) {
    await finishRun({
      runId: run.id,
      userId: user.id,
      reason: "cancelled",
      detail: "The session was deleted.",
    });
  }

  // Soft delete: the audit log keeps referring to this session for years, and a
  // hard delete would leave every one of those rows pointing at nothing exactly
  // when somebody is trying to reconstruct what happened.
  await prisma.workSession.updateMany({
    where: { id, userId: user.id, deletedAt: null },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
