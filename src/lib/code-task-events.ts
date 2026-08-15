import type { CodeTask, Prisma } from "@prisma/client";
import { prismaUnguarded } from "@/lib/db";

// This module is deliberately database-only. The long-lived task workers use
// it outside a Next request, so it must not pull in `next/server`, navigation,
// sessions, or the React server condition.
/*
 * Kinds delivered to the executing host as CONTROL rather than transcript: the
 * events POST hands these back in its response so the host can act on them
 * mid-run, instead of them merely being logged.
 *
 * The three rollback verbs join the list because that response is the ONLY
 * channel a running host reads — there is no inbound socket, and
 * `CodeSessionCommand` (which does have one) belongs to the separate
 * CodeRemoteSession subsystem and cannot address a CodeTask at all: its
 * `remoteSessionId` FK is required and points at a table the task workbench
 * never writes. Two earlier attempts stalled on exactly that, having looked at
 * the command table rather than at how `cancel_request` — already shipped, and
 * already consumed by the cloud runner's control loop — actually reaches a host.
 *
 * A host that does not recognise a kind here must ignore it and keep advancing
 * its control cursor, which is what every deployed host already does (see
 * scripts/cloud-code-runner.mjs). So adding kinds is backwards-compatible by
 * construction: an older host swallows the verb, sends no `rollback_result`,
 * and the web — which only ever shows a rollback as done on that result —
 * shows nothing.
 */
const CONTROL_KINDS = [
  "approval_response",
  "cancel_request",
  "accept_change",
  "reject_change",
  "undo_change",
];

export type TaskEventInput = {
  kind: string;
  payload: Prisma.InputJsonValue;
  /** Producer-supplied idempotency key; see `CodeTaskEvent.eventKey`. */
  key?: string | null;
};

/** Callers MUST have ownership-checked `taskId` before calling. The transaction
 * updates the task by bare id, so it intentionally uses the unguarded client. */
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
    // Drop events this task has already stored. Filtering before assigning
    // sequence numbers keeps the stream contiguous when a retried POST lost
    // its response after the original transaction committed.
    const keyed = events.filter((event) => typeof event.key === "string" && event.key.length > 0);
    let deliverable = events;
    if (keyed.length > 0) {
      const seen = await tx.codeTaskEvent.findMany({
        where: { taskId, eventKey: { in: keyed.map((event) => event.key as string) } },
        select: { eventKey: true },
      });
      if (seen.length > 0) {
        const already = new Set(seen.map((row) => row.eventKey));
        deliverable = events.filter((event) => !event.key || !already.has(event.key));
      }
    }
    events = deliverable;

    // Conditional status transition: a concurrently-finished task wins over a
    // late runner update, rather than being revived by the sweeper or runner.
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
          eventKey: event.key ?? null,
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
