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
  /*
   * `steer` ({ requestId, text }) is a new instruction for a task that is
   * ALREADY RUNNING — the web composer's "Send to running task". The host
   * injects `text` as the next user message of its live session and answers
   * with a `steer_ack` ({ requestId }) event, which is what moves the
   * composer's lifecycle from "queued" to "delivered". Same delivery channel
   * as every other control here, and the same backwards-compatibility: a host
   * that predates the verb swallows it, sends no ack, and the web shows the
   * instruction as queued rather than as done.
   */
  "steer",
];

export type TaskEventInput = {
  kind: string;
  payload: Prisma.InputJsonValue;
  /** Producer-supplied idempotency key; see `CodeTaskEvent.eventKey`. */
  key?: string | null;
};

/**
 * A pull request URL a run may report, and nothing else.
 *
 * `prUrl` is lifted from ANY event of any kind and rendered as the session
 * banner's one call to action. Only the task's owner (or its own runner) can
 * post events, so the exposure was bounded — but a host is still a process
 * running model-authored code, and "starts with https://" let it put any link
 * at all under a button that says "View pull request". Pull requests live on
 * github.com; that is the whole check.
 */
export function isGithubPullUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === "github.com" && /\/pull\/\d+/.test(url.pathname);
}

/**
 * How many `file_change` events each task has reported.
 *
 * `CodeTask` has no `changedFileCount` column, and adding one is a migration
 * this pass does not make — so rather than maintaining a counter inside
 * `appendTaskEvents` that could drift from the events it summarises, the
 * count is DERIVED from the events themselves when a list is read. One
 * grouped query for the whole page, never one per row. Callers pass ids they
 * have already ownership-filtered, which is why this reads unguarded.
 *
 * It counts events, not distinct paths: a host that reports the same file
 * twice counts twice. The consumer (`hasOutcome` in lib/code-runs.ts) only
 * asks whether it is above zero, and for that the two are the same question.
 */
export async function countChangedFiles(taskIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (taskIds.length === 0) return counts;
  const rows = await prismaUnguarded.codeTaskEvent.groupBy({
    by: ["taskId"],
    where: { taskId: { in: [...taskIds] }, kind: "file_change" },
    _count: { _all: true },
  });
  for (const row of rows) counts.set(row.taskId, row._count._all);
  return counts;
}

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
    /*
     * The pull request URL, lifted out of the event that carries it.
     *
     * The cloud runner opens the PR and reports it INSIDE a `done` payload
     * (scripts/cloud-code-runner.mjs). Nothing ever copied it onto the task, so
     * `CodeTask.prUrl` was written by no code path in the product and stayed
     * null forever — which silently killed everything downstream of it: the PR
     * chip on the session banner (the cloud run's only call to action), the PR
     * button in the run list, `hasOutcome`, and therefore the entire "Ready to
     * review" bucket, which could never contain a run. Every finished cloud run
     * fell straight into the collapsed "Wrapped up" group, and the list's decay
     * rule — which waits for a PR to settle — never ran either.
     *
     * Read from any event that carries one rather than from `done` alone: a
     * host that reports the URL earlier (on push, say) should not have to wait
     * for the run to finish before the link appears.
     *
     * FIRST WRITE WINS. A run opens one pull request; a later event carrying a
     * different URL is a retry or a replay, and the value already shown to the
     * user is the one they may have clicked.
     */
    let prUrl: string | undefined;
    for (const event of events) {
      const payload = event.payload as { prUrl?: unknown } | null;
      const candidate = payload && typeof payload === "object" ? payload.prUrl : undefined;
      if (typeof candidate === "string" && isGithubPullUrl(candidate)) {
        prUrl = candidate;
        break;
      }
    }

    // Guarded on `prUrl: null` so this is genuinely first-write-wins rather
    // than last: putting it in the update below would let a replayed `done`
    // overwrite the link the user may already have opened.
    if (prUrl) {
      await tx.codeTask.updateMany({ where: { id: taskId, prUrl: null }, data: { prUrl } });
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
