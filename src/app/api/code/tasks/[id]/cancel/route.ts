import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  appendTaskEvents,
  isTerminalTaskStatus,
  persistCodeTaskOutcome,
  requireTaskAuth,
  serializeTask,
  type TaskEventInput,
} from "@/lib/code-remote";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, viaTaskToken, error } = await requireTaskAuth(id, req);
  if (!user) return error;

  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true, status: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A finished task can't be cancelled again by the untrusted runner.
  if (viaTaskToken && isTerminalTaskStatus(task.status)) {
    return NextResponse.json({ error: "Task is no longer active." }, { status: 409 });
  }

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
