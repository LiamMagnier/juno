import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { encryptMessageText } from "@/lib/message-crypto";
import { serializeMessage } from "@/lib/serializers";
import { appendTaskEvents, persistCodeTaskOutcome, requireUser, serializeTask, TASK_STATUSES } from "@/lib/code-remote";
import { mintTaskToken } from "@/lib/cloud-code-token";
import { dispatchCloudRunner } from "@/lib/cloud-code";
import { isDefaultCodeSessionTitle } from "@/lib/title-ownership";

export const runtime = "nodejs";

const postSchema = z.object({
  // Device tasks name a device + local path; cloud tasks omit both and name a
  // repo instead (validated per-target below).
  deviceId: z.string().min(1).max(200).optional(),
  workspacePath: z.string().trim().min(1).max(1000).optional(),
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
  // Cloud Juno Code: run on a GitHub Actions runner instead of a device.
  target: z.enum(["device", "cloud"]).optional(),
  repo: z
    .object({
      owner: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(200),
    })
    .optional(),
  baseRef: z.string().trim().min(1).max(200).optional(),
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

  const { deviceId, workspacePath, workspaceName, workspaceKey, title, prompt, conversationId, target, repo, baseRef } =
    parsed.data;
  const isCloud = target === "cloud";

  // Resolve conversation + first-prompt title (shared by both targets).
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

  let task;
  if (isCloud) {
    if (!repo) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    // A cloud run clones + opens a PR as the user, so it needs a linked GitHub
    // connector. No connector → honest 400, never a silent fake run.
    const github = await prisma.connection.findFirst({
      where: { userId: user.id, provider: "github" },
      select: { id: true },
    });
    if (!github) return NextResponse.json({ error: "github_not_connected" }, { status: 400 });
    // No dispatch credential → the runner can never be started. Fail loudly
    // BEFORE creating a task so nothing hangs queued.
    if (!env.githubDispatchToken) {
      return NextResponse.json({ error: "cloud_runner_not_configured" }, { status: 503 });
    }

    task = await prisma.codeTask.create({
      data: {
        userId: user.id,
        deviceId: null, // cloud tasks have no registered device
        target: "cloud",
        repoOwner: repo.owner,
        repoName: repo.name,
        baseRef: baseRef ?? null,
        // The repo IS the cloud workspace; keep these columns meaningful for the
        // session view without inventing a device path.
        workspacePath: `${repo.owner}/${repo.name}`,
        workspaceName: workspaceName ?? repo.name,
        workspaceKey: workspaceKey ?? null,
        title: title ?? prompt.slice(0, 60),
        prompt,
        conversationId: conversationId ?? null,
      },
    });
  } else {
    // Device (default) — unchanged behavior: a real device + local path.
    if (!deviceId || !workspacePath) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const device = await prisma.codeDevice.findFirst({
      where: { id: deviceId, userId: user.id },
      select: { id: true },
    });
    if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

    task = await prisma.codeTask.create({
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
  }

  // Linked sessions persist the prompt as a normal USER message immediately, so
  // the session's history is durable even if the run never starts (Mac offline,
  // or a cloud dispatch that fails below).
  let userMessage = null;
  if (conversationId) {
    const created = await prisma.message.create({
      data: { conversationId, role: "USER", content: encryptMessageText(prompt) },
      include: { attachments: true },
    });
    userMessage = await serializeMessage(created);
    await prisma.conversation.updateMany({
      where: { id: conversationId, userId: user.id },
      data: { lastMessageAt: new Date(), ...(sessionTitleUpdate ? { title: sessionTitleUpdate } : {}) },
    });
  }

  // Cloud: kick off the runner. The task token authenticates ONLY the runner's
  // first callback (runner-context), which then hands over the real credentials;
  // the workflow re-masks it. Never sent to the runner any other way.
  if (isCloud) {
    try {
      await dispatchCloudRunner({
        taskId: task.id,
        taskToken: mintTaskToken(task.id),
        repoOwner: task.repoOwner!,
        repoName: task.repoName!,
        baseRef: task.baseRef ?? "",
        callbackBase: env.appUrl.replace(/\/$/, ""),
      });
    } catch (err) {
      // Honest failure: mark the task failed (so it never hangs queued) and
      // persist the linked session's outcome, then report the error.
      console.error("[cloud-code] workflow_dispatch failed", err);
      const { task: failed } = await appendTaskEvents(
        task.id,
        [
          { kind: "error", payload: { message: "Failed to start the cloud runner." } },
          { kind: "status", payload: { status: "failed" } },
        ],
        { status: "failed" },
      );
      try {
        await persistCodeTaskOutcome(failed);
      } catch (persistErr) {
        console.error("[cloud-code] failed to persist dispatch-failure outcome", persistErr);
      }
      return NextResponse.json({ error: "cloud_dispatch_failed" }, { status: 502 });
    }
  }

  return NextResponse.json(
    { task: serializeTask(task), ...(userMessage ? { userMessage } : {}) },
    { status: 201 },
  );
}
