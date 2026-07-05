import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, serializeTask, TASK_STATUSES } from "@/lib/code-remote";

export const runtime = "nodejs";

const postSchema = z.object({
  deviceId: z.string().min(1).max(200),
  workspacePath: z.string().trim().min(1).max(1000),
  workspaceName: z.string().trim().max(200).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(100_000),
});

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { searchParams } = new URL(req.url);
  const deviceId = searchParams.get("deviceId") ?? undefined;
  const status = searchParams.get("status") ?? undefined;
  if (status && !(TASK_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const rawLimit = Number(searchParams.get("limit") ?? "30");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 100) : 30;

  const tasks = await prisma.codeTask.findMany({
    where: { userId: user.id, ...(deviceId ? { deviceId } : {}), ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ tasks: tasks.map(serializeTask) });
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { deviceId, workspacePath, workspaceName, title, prompt } = parsed.data;
  const device = await prisma.codeDevice.findFirst({
    where: { id: deviceId, userId: user.id },
    select: { id: true },
  });
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const task = await prisma.codeTask.create({
    data: {
      userId: user.id,
      deviceId,
      workspacePath,
      workspaceName: workspaceName ?? "",
      title: title ?? prompt.slice(0, 60),
      prompt,
    },
  });
  return NextResponse.json({ task: serializeTask(task) }, { status: 201 });
}
