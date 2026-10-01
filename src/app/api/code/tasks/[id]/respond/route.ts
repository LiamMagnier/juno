import { NextResponse } from "next/server";
import { codeTaskInputSchema, codeTaskInputControl } from "@/lib/code-task-input";
import { prisma } from "@/lib/prisma";
import { appendTaskEvents, isTerminalTaskStatus, requireTaskAuth, type TaskEventInput } from "@/lib/code-remote";

export const runtime = "nodejs";



export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, viaTaskToken, error } = await requireTaskAuth(id, req);
  if (!user) return error;

  if (viaTaskToken) return NextResponse.json({ error: "Only the task owner can answer a request." }, { status: 403 });

  const parsed = codeTaskInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true, status: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A finished task takes no more input from the untrusted runner.
  if (isTerminalTaskStatus(task.status)) {
    return NextResponse.json({ error: "Task is no longer active." }, { status: 409 });
  }

  const resume = task.status === "awaiting_approval";
  const events: TaskEventInput[] = [
    codeTaskInputControl(parsed.data),
  ];
  if (resume) events.push({ kind: "status", payload: { status: "running" } });

  const { lastSeq } = await appendTaskEvents(
    task.id,
    events,
    resume ? { status: "running", fromStatus: "awaiting_approval" } : {},
  );
  return NextResponse.json({ lastSeq });
}
