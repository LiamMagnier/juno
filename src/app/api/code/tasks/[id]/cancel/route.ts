import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  appendTaskEvents,
  persistCodeTaskOutcome,
  requireUser,
  serializeTask,
  type TaskEventInput,
} from "@/lib/code-remote";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true, status: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const events: TaskEventInput[] = [{ kind: "cancel_request", payload: {} }];
  const cancelNow = task.status === "queued";
  if (cancelNow) events.push({ kind: "status", payload: { status: "cancelled" } });

  const { task: updated } = await appendTaskEvents(task.id, events, cancelNow ? { status: "cancelled" } : {});
  if (cancelNow) {
    // A queued task cancels server-side (no host involved), so the linked
    // session's outcome message is written here. Best-effort, idempotent.
    try {
      await persistCodeTaskOutcome(updated);
    } catch (err) {
      console.error("[code-remote] failed to persist cancelled task outcome", err);
    }
  }
  return NextResponse.json({ task: serializeTask(updated) });
}
