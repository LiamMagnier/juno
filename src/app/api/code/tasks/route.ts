import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { encryptMessageText } from "@/lib/message-crypto";
import { serializeMessage } from "@/lib/serializers";
import { requireUser, serializeTask, TASK_STATUSES } from "@/lib/code-remote";
import { dispatchCloudRunner } from "@/lib/cloud-code";
import { rateLimit } from "@/lib/rate-limit";
import { isDefaultCodeSessionTitle } from "@/lib/title-ownership";

// Abuse controls for cloud task creation (the dispatch fans out to a fresh CI VM
// that burns Actions minutes + plan budget, so it must not be floodable).
/** Max cloud dispatches per user per minute. */
const CLOUD_TASK_RATE_LIMIT = 10;
/** Max simultaneously-active (queued/running) cloud tasks per user. */
const CLOUD_TASK_CONCURRENCY_CAP = 3;

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

    // Abuse control 1 — burst rate limit (mirrors /api/agent). A cloud dispatch
    // spins up a whole CI VM + agent loop, so cap how fast one user can fire them.
    const rl = await rateLimit({ key: `code-cloud:${user.id}`, limit: CLOUD_TASK_RATE_LIMIT, windowSec: 60 });
    if (!rl.success) {
      return NextResponse.json({ error: "Too many cloud runs started. Try again shortly." }, { status: 429 });
    }
    // Abuse control 2 — concurrent-run cap. Refuse a new run when the user
    // already has CLOUD_TASK_CONCURRENCY_CAP cloud tasks in flight, so a runaway
    // client can't hold open an unbounded fleet of runners. The count and the
    // create run under a per-user advisory lock so the cap can't be raced: a
    // plain count()+create() is a TOCTOU (N parallel requests each read < cap
    // and all create). The xact lock serializes creation per user and releases
    // on commit; a hash collision only briefly serializes two unrelated users.
    try {
      task = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cloud-cap:${user.id}`}))`;
        const active = await tx.codeTask.count({
          where: { userId: user.id, target: "cloud", status: { in: ["queued", "running", "awaiting_approval"] } },
        });
        if (active >= CLOUD_TASK_CONCURRENCY_CAP) {
          throw Object.assign(new Error("cloud_cap_exceeded"), { activeCount: active });
        }
        return tx.codeTask.create({
          data: {
            userId: user.id,
            deviceId: null, // cloud tasks have no registered device
            target: "cloud",
            repoOwner: repo.owner,
            repoName: repo.name,
            baseRef: baseRef ?? null,
            // The repo IS the cloud workspace; keep these columns meaningful for
            // the session view without inventing a device path.
            workspacePath: `${repo.owner}/${repo.name}`,
            workspaceName: workspaceName ?? repo.name,
            workspaceKey: workspaceKey ?? null,
            title: title ?? prompt.slice(0, 60),
            prompt,
            conversationId: conversationId ?? null,
          },
        });
      });
    } catch (err) {
      if (err instanceof Error && err.message === "cloud_cap_exceeded") {
        const n = (err as Error & { activeCount?: number }).activeCount ?? CLOUD_TASK_CONCURRENCY_CAP;
        return NextResponse.json(
          { error: `You already have ${n} cloud runs in progress. Let one finish first.` },
          { status: 429 },
        );
      }
      throw err;
    }

    // Dispatch BEFORE persisting the user message (below), so a dispatch failure
    // leaves nothing orphaned — no half-created session turn to reconcile, and a
    // retry starts clean. NO credential rides the dispatch inputs: the runner
    // authenticates runner-context with a GitHub Actions OIDC token it fetches at
    // runtime (audience "juno-cloud-code"), which is never logged. The taskId
    // binding is safe because only this server can dispatch the workflow.
    try {
      await dispatchCloudRunner({
        taskId: task.id,
        repoOwner: task.repoOwner!,
        repoName: task.repoName!,
        baseRef: task.baseRef ?? "",
        callbackBase: env.appUrl.replace(/\/$/, ""),
      });
    } catch (err) {
      // Honest failure with NO orphan: drop the task we just created (no user
      // message was written yet) so a client retry can't accumulate duplicates.
      console.error("[cloud-code] workflow_dispatch failed", err);
      await prisma.codeTask.deleteMany({ where: { id: task.id, userId: user.id } }).catch((delErr) => {
        console.error("[cloud-code] failed to roll back task after dispatch failure", delErr);
      });
      return NextResponse.json({ error: "cloud_dispatch_failed" }, { status: 502 });
    }
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

  // Linked sessions persist the prompt as a normal USER message. For device
  // tasks this makes the session durable even if the run never starts (Mac
  // offline). For cloud tasks we are PAST a successful dispatch here, so persist
  // only now — a failed dispatch returned above without ever writing a message,
  // leaving nothing to reconcile on a retry.
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

  return NextResponse.json(
    { task: serializeTask(task), ...(userMessage ? { userMessage } : {}) },
    { status: 201 },
  );
}
