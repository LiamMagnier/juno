import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { countChangedFiles, requireUser, serializeTask, serializeTaskEvent } from "@/lib/code-remote";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rawAfterSeq = Number(new URL(req.url).searchParams.get("afterSeq") ?? "0");
  const afterSeq = Number.isFinite(rawAfterSeq) ? rawAfterSeq : 0;

  const events = await prisma.codeTaskEvent.findMany({
    where: { taskId: task.id, seq: { gt: afterSeq } },
    orderBy: { seq: "asc" },
    take: 500,
  });
  const changed = await countChangedFiles([task.id]);
  return NextResponse.json({
    task: serializeTask(task, { changedFileCount: changed.get(task.id) ?? 0 }),
    events: events.map(serializeTaskEvent),
  });
}
