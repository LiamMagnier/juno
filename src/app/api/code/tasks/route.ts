import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { serializeMessage } from "@/lib/serializers";
import { requireUser, serializeTask, TASK_STATUSES } from "@/lib/code-remote";
import { isDefaultCodeSessionTitle } from "@/lib/title-ownership";

export const runtime = "nodejs";

const postSchema = z.object({
  deviceId: z.string().min(1).max(200),
  workspacePath: z.string().trim().min(1).max(1000),
  workspaceName: z.string().trim().max(200).optional(),
  // Stable workspace identity (CodeWorkspace.key). Optional — path stays
  // required and authoritative for execution (the device resolves its own
  // local folder); the key rides along for attribution that survives moves.
  workspaceKey: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(100_000),
  // The kind:"code" Conversation this task runs in (website sessions). Native
  // clients omit it and keep the pre-linkage behavior unchanged.
  conversationId: z.string().min(1).max(200).optional(),
});

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { searchParams } = new URL(req.url);
  const deviceId = searchParams.get("deviceId") ?? undefined;
  const conversationId = searchParams.get("conversationId") ?? undefined;
  const status = searchParams.get("status") ?? undefined;
  if (status && !(TASK_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const rawLimit = Number(searchParams.get("limit") ?? "30");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 100) : 30;

  const tasks = await prisma.codeTask.findMany({
    where: {
      userId: user.id,
      ...(deviceId ? { deviceId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(status ? { status } : {}),
    },
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

  const { deviceId, workspacePath, workspaceName, workspaceKey, title, prompt, conversationId } = parsed.data;
  const device = await prisma.codeDevice.findFirst({
    where: { id: deviceId, userId: user.id },
    select: { id: true },
  });
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let sessionTitleUpdate: string | null = null;
  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId: user.id, kind: "code" },
      select: { id: true, title: true, titleSource: true },
    });
    if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    // First prompt of a fresh session names it (never overrides a user rename).
    if (conversation.titleSource === "default" && isDefaultCodeSessionTitle(conversation.title)) {
      sessionTitleUpdate = prompt.slice(0, 48);
    }
  }

  const task = await prisma.codeTask.create({
    data: {
      userId: user.id,
      deviceId,
      workspacePath,
      workspaceName: workspaceName ?? "",
      workspaceKey: workspaceKey ?? null,
      title: title ?? prompt.slice(0, 60),
      prompt,
      conversationId: conversationId ?? null,
    },
  });

  // Linked sessions persist the prompt as a normal USER message immediately, so
  // the session's history is durable even if the run never starts (Mac offline).
  if (conversationId) {
    const userMessage = await prisma.message.create({
      data: { conversationId, role: "USER", content: encryptMessageText(prompt) },
      include: { attachments: true },
    });
    await prisma.conversation.updateMany({
      where: { id: conversationId, userId: user.id },
      data: { lastMessageAt: new Date(), ...(sessionTitleUpdate ? { title: sessionTitleUpdate } : {}) },
    });
    return NextResponse.json(
      { task: serializeTask(task), userMessage: await serializeMessage(userMessage) },
      { status: 201 }
    );
  }

  return NextResponse.json({ task: serializeTask(task) }, { status: 201 });
}
