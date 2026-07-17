import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { appendTaskEvents, requireTaskAuth, type TaskEventInput } from "@/lib/code-remote";

export const runtime = "nodejs";

const schema = z.object({ requestId: z.string().min(1).max(200), approve: z.boolean() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireTaskAuth(id, req);
  if (!user) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true, status: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const resume = task.status === "awaiting_approval";
  const events: TaskEventInput[] = [
    { kind: "approval_response", payload: { requestId: parsed.data.requestId, approve: parsed.data.approve } },
  ];
  if (resume) events.push({ kind: "status", payload: { status: "running" } });

  const { lastSeq } = await appendTaskEvents(
    task.id,
    events,
    resume ? { status: "running", fromStatus: "awaiting_approval" } : {},
  );
  return NextResponse.json({ lastSeq });
}
