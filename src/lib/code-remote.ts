import { NextResponse } from "next/server";
import type { CodeDevice, CodeTask, CodeTaskEvent, Prisma } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { getCurrentUser, type SessionUser } from "@/lib/session";
import { readTaskToken, verifyTaskToken } from "@/lib/cloud-code-token";
import type { ClientActivityEvent } from "@/types/chat";

export const ONLINE_WINDOW_MS = 120_000;

export const TASK_STATUSES = ["queued", "running", "awaiting_approval", "done", "failed", "cancelled"] as const;

export const TERMINAL_TASK_STATUSES = ["done", "failed", "cancelled"] as const;

export function isTerminalTaskStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export const EVENT_KINDS = [
  "status",
  "user",
  "text",
  "tool",
  "file_change",
  "approval_request",
  "approval_response",
  "cancel_request",
  "error",
  "done",
] as const;

const CONTROL_KINDS = ["approval_response", "cancel_request"];

export async function requireUser(): Promise<
  { user: SessionUser; error: null } | { user: null; error: NextResponse }
> {
  const user = await getCurrentUser();
  if (!user) {
    return { user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { user, error: null };
}

// A cloud-code task bearer looks like `Bearer cct_<payload>.<sig>`. Matching the
// prefix lets us route it to task-token auth instead of native-bearer auth,
// which would otherwise 401 a perfectly valid task token.
const CCT_BEARER_RE = /^Bearer (cct_[A-Za-z0-9._-]+)$/;

export type TaskAuthResult =
  | { user: SessionUser; viaTaskToken: boolean; error: null }
  | { user: null; viaTaskToken: false; error: NextResponse };

/**
 * Authorize a request against ONE specific task. Succeeds either:
 *  - via a normal user session / native bearer (requireUser — UNCHANGED), or
 *  - via a valid Cloud Code task bearer ("Authorization: Bearer cct_…") whose
 *    audience is EXACTLY this taskId — so the GitHub Actions runner can drive
 *    the task it was dispatched for and nothing else.
 *
 * Task-token requests resolve to the task's owner (loaded from the DB) so the
 * routes' existing ownership-scoped queries (`where: { id, userId }`) keep
 * working untouched. The cct_ branch is tried first: a task bearer must never
 * fall through to native-bearer auth. `viaTaskToken` lets a route tighten
 * behavior (e.g. runner-context is task-token-ONLY).
 */
export async function requireTaskAuth(taskId: string, req: Request): Promise<TaskAuthResult> {
  const authorization = req.headers.get("authorization");
  const match = authorization ? CCT_BEARER_RE.exec(authorization) : null;
  if (match) {
    const unauthorized = {
      user: null,
      viaTaskToken: false as const,
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
    if (!verifyTaskToken(match[1], taskId)) return unauthorized;
    // Intentional cross-user lookup: the verified task token IS the authorization,
    // so we resolve the owner by bare id (the ownership guard requires a userId
    // filter it can't have here) via the unguarded client.
    const task = await prismaUnguarded.codeTask.findUnique({ where: { id: taskId }, select: { userId: true } });
    if (!task) return unauthorized;
    return { user: { id: task.userId }, viaTaskToken: true, error: null };
  }
  const { user, error } = await requireUser();
  if (!user) return { user: null, viaTaskToken: false, error };
  return { user, viaTaskToken: false, error: null };
}

/**
 * Resolve a Cloud Code task bearer to its task's owner WITHOUT binding to a
 * known taskId — for surfaces that have no taskId in their path (the provider
 * proxy). Returns null when the Authorization header is absent, not a task
 * token, or invalid/expired. The token's own embedded audience selects the
 * task, so it can only ever resolve to that one task's owner.
 */
export async function taskTokenUser(req: Request): Promise<SessionUser | null> {
  const authorization = req.headers.get("authorization");
  const match = authorization ? CCT_BEARER_RE.exec(authorization) : null;
  if (!match) return null;
  const taskId = readTaskToken(match[1]);
  if (!taskId) return null;
  // Unguarded by design — the token's verified audience selects the task and
  // authorizes resolving its owner (see requireTaskAuth).
  const task = await prismaUnguarded.codeTask.findUnique({ where: { id: taskId }, select: { userId: true } });
  return task ? { id: task.userId } : null;
}

export function serializeDevice(device: CodeDevice, online?: boolean) {
  const base = {
    id: device.id,
    name: device.name,
    platform: device.platform,
    workspaces: device.workspaces,
    lastSeenAt: device.lastSeenAt.toISOString(),
  };
  return online === undefined ? base : { ...base, online };
}

export function serializeTask(task: CodeTask) {
  return {
    id: task.id,
    deviceId: task.deviceId,
    workspacePath: task.workspacePath,
    workspaceName: task.workspaceName,
    workspaceKey: task.workspaceKey,
    title: task.title,
    prompt: task.prompt,
    status: task.status,
    lastSeq: task.lastSeq,
    conversationId: task.conversationId,
    // Cloud Juno Code: "device" (default) runs on a registered host; "cloud"
    // runs on a GitHub Actions runner against repoOwner/repoName and opens a PR.
    target: task.target,
    repoOwner: task.repoOwner,
    repoName: task.repoName,
    baseRef: task.baseRef,
    prUrl: task.prUrl,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function serializeTaskEvent(event: CodeTaskEvent) {
  return {
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

export type TaskEventInput = { kind: string; payload: Prisma.InputJsonValue };

/** Deterministic Message id for the assistant turn a linked task produced —
 *  one task, one message, so repeated terminal posts upsert instead of piling
 *  up duplicates, and the web client can address the row without a join. */
export function codeTaskMessageId(taskId: string): string {
  return `codetask_${taskId}`;
}

type EventPayload = Record<string, unknown>;

const payloadStr = (payload: Prisma.JsonValue, key: string): string | null => {
  const value = (payload as EventPayload | null)?.[key];
  return typeof value === "string" ? value : null;
};
const payloadNum = (payload: Prisma.JsonValue, key: string): number | null => {
  const value = (payload as EventPayload | null)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * Persist the outcome of a conversation-linked task as a normal ASSISTANT
 * Message, so the code session's history reloads exactly like chat history.
 * Idempotent (deterministic id + upsert) and a no-op for unlinked tasks or
 * tasks that are still running. Call after any status write that can be
 * terminal; failures must never break the host's event ack, so callers wrap
 * this in try/catch (it also swallows a vanished conversation itself).
 */
export async function persistCodeTaskOutcome(task: CodeTask): Promise<void> {
  if (!task.conversationId || !isTerminalTaskStatus(task.status)) return;
  const conversation = await prisma.conversation.findFirst({
    where: { id: task.conversationId, userId: task.userId },
    select: { id: true },
  });
  if (!conversation) return; // deleted independently of the task — nothing to write to

  const events = await prisma.codeTaskEvent.findMany({
    where: { taskId: task.id },
    orderBy: { seq: "asc" },
  });

  const textParts: string[] = [];
  const activity: ClientActivityEvent[] = [];
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let errorMessage: string | null = null;
  const push = (event: CodeTaskEvent, entry: Omit<ClientActivityEvent, "id" | "createdAt">) =>
    activity.push({ id: `evt-${event.seq}`, createdAt: event.createdAt.toISOString(), ...entry });

  for (const event of events) {
    switch (event.kind) {
      case "text": {
        const text = payloadStr(event.payload, "text");
        if (text) textParts.push(text);
        break;
      }
      case "tool": {
        const summary = payloadStr(event.payload, "summary") ?? payloadStr(event.payload, "name");
        if (summary) push(event, { kind: "tool", title: summary, detail: payloadStr(event.payload, "detail") ?? undefined });
        break;
      }
      case "file_change": {
        const path = payloadStr(event.payload, "path");
        if (!path) break;
        const changeKind = payloadStr(event.payload, "changeKind") ?? "edit";
        const added = payloadNum(event.payload, "added") ?? 0;
        const removed = payloadNum(event.payload, "removed") ?? 0;
        push(event, { kind: "write", title: `${changeKind} ${path}`, detail: `+${added} −${removed}` });
        break;
      }
      case "approval_request": {
        const summary = payloadStr(event.payload, "summary");
        if (summary) push(event, { kind: "warning", title: "Approval requested", detail: summary });
        break;
      }
      case "error": {
        errorMessage = payloadStr(event.payload, "message") ?? errorMessage;
        break;
      }
      case "done": {
        promptTokens = payloadNum(event.payload, "promptTokens") ?? promptTokens;
        completionTokens = payloadNum(event.payload, "completionTokens") ?? completionTokens;
        break;
      }
      default:
        break; // status/user/approval_response/cancel_request carry no transcript content
    }
  }

  if (task.status === "failed") {
    activity.push({
      id: "evt-outcome",
      kind: "warning",
      title: "Task failed",
      detail: errorMessage ?? undefined,
      createdAt: task.updatedAt.toISOString(),
    });
  } else if (task.status === "cancelled") {
    activity.push({ id: "evt-outcome", kind: "warning", title: "Stopped by user", createdAt: task.updatedAt.toISOString() });
  }

  const base = {
    content: encryptMessageText(textParts.join("")),
    model: null,
    promptTokens,
    completionTokens,
    activity: activity as unknown as Prisma.InputJsonValue,
  };
  await prisma.message.upsert({
    where: { id: codeTaskMessageId(task.id) },
    create: { id: codeTaskMessageId(task.id), conversationId: conversation.id, role: "ASSISTANT", ...base },
    update: base,
  });
  await prisma.conversation.updateMany({
    where: { id: conversation.id, userId: task.userId },
    data: { lastMessageAt: new Date() },
  });
}

/** Callers MUST have ownership-checked `taskId` (findFirst with userId) before
 *  calling — the transaction below updates the task by bare id, so it uses the
 *  unguarded client. */
export async function appendTaskEvents(
  taskId: string,
  events: TaskEventInput[],
  opts: { status?: string; afterControlSeq?: number; fromStatus?: string } = {},
): Promise<{
  task: CodeTask;
  lastSeq: number;
  control: { seq: number; kind: string; payload: Prisma.JsonValue }[];
}> {
  return prismaUnguarded.$transaction(async (tx) => {
    // Conditional status transition: only apply opts.status when the task is
    // still in opts.fromStatus, so a concurrently-finished task cannot be
    // flipped back (e.g. a late approval reviving a completed run).
    let applyStatus = opts.status;
    if (opts.status && opts.fromStatus) {
      const moved = await tx.codeTask.updateMany({
        where: { id: taskId, status: opts.fromStatus },
        data: { status: opts.status },
      });
      if (moved.count === 0) applyStatus = undefined;
    }
    const task = await tx.codeTask.update({
      where: { id: taskId },
      data: {
        lastSeq: { increment: events.length },
        ...(applyStatus && !opts.fromStatus ? { status: applyStatus } : {}),
      },
    });
    const firstSeq = task.lastSeq - events.length + 1;
    if (events.length > 0) {
      await tx.codeTaskEvent.createMany({
        data: events.map((event, i) => ({
          taskId,
          seq: firstSeq + i,
          kind: event.kind,
          payload: event.payload,
        })),
      });
    }
    const control =
      opts.afterControlSeq === undefined
        ? []
        : (
            await tx.codeTaskEvent.findMany({
              where: { taskId, kind: { in: CONTROL_KINDS }, seq: { gt: opts.afterControlSeq } },
              orderBy: { seq: "asc" },
            })
          ).map((event) => ({ seq: event.seq, kind: event.kind, payload: event.payload }));
    return { task, lastSeq: task.lastSeq, control };
  });
}
