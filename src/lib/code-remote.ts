import { NextResponse } from "next/server";
import type { CodeDevice, CodeTask, CodeTaskEvent, Prisma } from "@prisma/client";
import { prismaUnguarded } from "@/lib/prisma";
import { getCurrentUser, type SessionUser } from "@/lib/session";

export const ONLINE_WINDOW_MS = 120_000;

export const TASK_STATUSES = ["queued", "running", "awaiting_approval", "done", "failed", "cancelled"] as const;

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
    title: task.title,
    prompt: task.prompt,
    status: task.status,
    lastSeq: task.lastSeq,
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
