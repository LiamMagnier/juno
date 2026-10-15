/**
 * The queued messages of a Mac thread, as the composer shows them.
 *
 * The env server on the Mac owns the queue (`SessionSnapshot.queue`, updated
 * by `queue.updated` for every device). Remove, Edit, reorder and Steer now
 * are requests to it (`queue.remove`, `queue.edit`, `queue.move`,
 * `queue.promote`); until its answer shows up in the queue, the change is
 * drawn optimistically on top of what the server last said. Nothing here
 * keeps a second copy of the queue, which is what made Remove do nothing and
 * Edit send a message twice: the old code changed a local list the composer
 * never read on a Mac thread.
 *
 * An optimistic op leaves the overlay when the server's queue reflects it,
 * when its row has left the queue anyway (it started, or another device took
 * it), or when its request fails (the caller drops it and says so).
 */
import type { QueueRow } from "./composer";

export type QueueOp =
  | { opId: string; kind: "remove"; id: string }
  | { opId: string; kind: "edit"; id: string; text: string }
  | { opId: string; kind: "move"; id: string; to: number };

/** The server's queue with the not-yet-reflected ops drawn on top, in the order they were made. */
export function overlayQueue(server: readonly QueueRow[], ops: readonly QueueOp[]): QueueRow[] {
  let rows = [...server];
  for (const op of ops) {
    const at = rows.findIndex((r) => r.id === op.id);
    if (at < 0) continue;
    if (op.kind === "remove") rows = rows.filter((r) => r.id !== op.id);
    else if (op.kind === "edit") rows = op.text.trim() ? rows.map((r) => (r.id === op.id ? { ...r, text: op.text } : r)) : rows.filter((r) => r.id !== op.id);
    else {
      const to = Math.max(0, Math.min(rows.length - 1, op.to));
      const next = [...rows];
      const [row] = next.splice(at, 1);
      next.splice(to, 0, row);
      rows = next;
    }
  }
  return rows;
}

/** Whether the server's queue already shows `op` (or its row is gone, which settles it too). */
export function opSettled(server: readonly QueueRow[], op: QueueOp): boolean {
  const at = server.findIndex((r) => r.id === op.id);
  if (at < 0) return true;
  if (op.kind === "remove") return false;
  if (op.kind === "edit") return op.text.trim() ? server[at].text === op.text : false;
  return at === Math.max(0, Math.min(server.length - 1, op.to));
}

/** The ops still waiting for the server, after a new queue arrived. Same array when nothing settled. */
export function reconcileQueueOps(server: readonly QueueRow[], ops: readonly QueueOp[]): QueueOp[] {
  if (!ops.length) return ops as QueueOp[];
  const left = ops.filter((op) => !opSettled(server, op));
  return left.length === ops.length ? (ops as QueueOp[]) : left;
}

// Named *_MESSAGE so the i18n extractor catalogues them (scripts/generate-i18n-catalog.mjs).
const QUEUE_OLD_MAC_MESSAGE = "Update Alevr on your Mac to change queued messages from here.";
const QUEUE_UNREACHABLE_MESSAGE = "Your Mac could not be reached. The queue is unchanged.";
const QUEUE_FAILED_MESSAGE = "Could not change the queue on your Mac.";
const PROMOTED_NEXT_MESSAGE = "This runtime cannot steer a running turn, so the message runs next.";
const PROMOTED_GONE_MESSAGE = "That message had already left the queue.";

/** What a failed queue request tells the reader. */
export function queueErrorMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "unsupported") return QUEUE_OLD_MAC_MESSAGE;
  if (code === "not_ready") return QUEUE_UNREACHABLE_MESSAGE;
  return error instanceof Error && error.message ? error.message : QUEUE_FAILED_MESSAGE;
}

/** The sentence for a Steer now that could not join the running turn. */
export function promoteOutcomeMessage(outcome: string): string | null {
  if (outcome === "next") return PROMOTED_NEXT_MESSAGE;
  if (outcome === "gone") return PROMOTED_GONE_MESSAGE;
  return null;
}
