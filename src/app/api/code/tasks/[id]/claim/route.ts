import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { appendTaskEvents, requireUser, serializeTask } from "@/lib/code-remote";

export const runtime = "nodejs";

const schema = z.object({ deviceId: z.string().min(1).max(200) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const claimed = await prisma.codeTask.updateMany({
    where: { id, userId: user.id, deviceId: parsed.data.deviceId, status: "queued" },
    data: { status: "running" },
  });
  if (claimed.count === 0) {
    const exists = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ error: "not_queued" }, { status: 409 });
  }

  const { task } = await appendTaskEvents(id, [{ kind: "status", payload: { status: "running" } }]);
  return NextResponse.json({ task: serializeTask(task) });
}
