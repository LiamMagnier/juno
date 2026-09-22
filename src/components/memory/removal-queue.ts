/*
 * The bookkeeping behind Delete and Forget with an Undo (see
 * use-deferred-removal.ts), kept free of React and of the toast library so the
 * one promise it makes can be tested on its own: every removal the reader asked
 * for is sent exactly once, unless they took it back first.
 *
 * An entry leaves the queue in exactly one way. `take` hands it out to be sent
 * (the toast closed, the page is going away), `cancel` drops it (Undo), and
 * `discard` drops everything (a reset has already removed it all). Whichever
 * comes first wins and the others find nothing, which is what makes the many
 * ways a toast can close (timer, swipe, close button, a programmatic dismiss
 * that follows a flush) safe to wire to the same send.
 */

export type RemovalKind = "forget" | "delete";

export interface PendingRemoval<T extends { id: string }> {
  memory: T;
  kind: RemovalKind;
  toastId: string | number;
}

export interface RemovalQueue<T extends { id: string }> {
  has: (id: string) => boolean;
  /** Queue a removal; false when that row already has one waiting. */
  add: (entry: PendingRemoval<T>) => boolean;
  /** Hand a removal out to be sent, once; null when it was sent, undone or discarded. */
  take: (id: string) => PendingRemoval<T> | null;
  /** Undo: drop a removal that has not been sent. False when it already was. */
  cancel: (id: string) => boolean;
  /** Every removal still waiting, handed out to be sent, oldest first. */
  takeAll: () => PendingRemoval<T>[];
  /** Drop every waiting removal unsent, returning what was dropped. */
  discard: () => PendingRemoval<T>[];
}

export function createRemovalQueue<T extends { id: string }>(): RemovalQueue<T> {
  const pending = new Map<string, PendingRemoval<T>>();
  const drain = () => {
    const all = [...pending.values()];
    pending.clear();
    return all;
  };
  return {
    has: (id) => pending.has(id),
    add: (entry) => {
      if (pending.has(entry.memory.id)) return false;
      pending.set(entry.memory.id, entry);
      return true;
    },
    take: (id) => {
      const entry = pending.get(id);
      if (!entry) return null;
      pending.delete(id);
      return entry;
    },
    cancel: (id) => pending.delete(id),
    takeAll: drain,
    discard: drain,
  };
}
