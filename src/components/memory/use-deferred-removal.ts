"use client";

import * as React from "react";
import { toast } from "sonner";
import type { Memory } from "@/components/memory/memory-model";
import { createRemovalQueue, type RemovalKind } from "@/components/memory/removal-queue";
import { PRODUCT_NAME } from "@/lib/brand/names";

export type { RemovalKind } from "@/components/memory/removal-queue";

/*
 * Delete and Forget with an Undo, on an API that has no undo.
 *
 * A real server-side undo is not possible today: the forget PATCH returns
 * neither the suppression it wrote nor a way to lift it, and re-saving a
 * deleted fact would re-date it and lose its provenance. So the removal is
 * DEFERRED instead. The row leaves the page at once (the reader sees exactly
 * what they asked for, with the exit animation that says which row went), a
 * toast offers Undo, and the request is only sent once that toast has gone.
 * Undo within that window is therefore free and exact: nothing was ever sent.
 *
 * The window closes early in three places, and each sends what is pending
 * rather than dropping it: the toast is swiped or closed, the page unmounts
 * (a route change), or the tab is hidden. Hidden, not only `pagehide`: the
 * toast's timer pauses while the tab is in the background, so a removal made
 * just before switching away would otherwise wait for as long as the tab does,
 * and a backgrounded tab can be discarded (a phone reclaiming memory, the
 * browser's memory saver) without `pagehide` ever firing. `visibilitychange`
 * is the last event a page can count on. The requests go out with `keepalive`
 * (see useMemory), so one started as the tab closes still reaches the server.
 */

/** How long the Undo stays on offer. Sonner pauses it while hovered. */
const UNDO_WINDOW_MS = 5000;
/** How long a restored row keeps its re-entry flag, which is the length of the entrance. */
const RESTORE_FLAG_MS = 600;

export interface DeferredRemoval {
  /** Rows removed on screen but not yet on the server. */
  hiddenIds: ReadonlySet<string>;
  /** Rows just brought back by Undo, which re-enter rather than appear. */
  restoredIds: ReadonlySet<string>;
  remove: (memory: Memory, kind: RemovalKind) => void;
  /**
   * Drop every waiting removal without sending it, and take its Undo off the
   * screen. For a reset, which has already removed everything they would.
   */
  discardAll: () => void;
}

export function useDeferredRemoval(
  commit: (memory: Memory, kind: RemovalKind) => Promise<boolean>
): DeferredRemoval {
  const [hiddenIds, setHiddenIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [restoredIds, setRestoredIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [queue] = React.useState(() => createRemovalQueue<Memory>());
  const commitRef = React.useRef(commit);
  commitRef.current = commit;

  const setMember = React.useCallback(
    (setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, id: string, on: boolean) =>
      setter((prev) => {
        if (prev.has(id) === on) return prev;
        const next = new Set(prev);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    []
  );

  const send = React.useCallback(
    (entry: { memory: Memory; kind: RemovalKind }) => {
      // The row stays hidden until the server has answered: a delete has
      // already dropped it from the list by then, a forget has reloaded it into
      // the retired trail, and a failure brings it back where it was (the
      // memory hook explains the failure in its own toast).
      const id = entry.memory.id;
      void commitRef.current(entry.memory, entry.kind).finally(() => setMember(setHiddenIds, id, false));
    },
    [setMember]
  );

  const flush = React.useCallback(
    (id: string) => {
      const entry = queue.take(id);
      if (entry) send(entry);
    },
    [queue, send]
  );

  const undo = React.useCallback(
    (id: string) => {
      if (!queue.cancel(id)) return;
      setMember(setHiddenIds, id, false);
      setMember(setRestoredIds, id, true);
      window.setTimeout(() => setMember(setRestoredIds, id, false), RESTORE_FLAG_MS);
    },
    [queue, setMember]
  );

  const remove = React.useCallback(
    (memory: Memory, kind: RemovalKind) => {
      if (queue.has(memory.id)) return;
      setMember(setHiddenIds, memory.id, true);
      const options = {
        duration: UNDO_WINDOW_MS,
        action: { label: "Undo", onClick: () => undo(memory.id) },
        onAutoClose: () => flush(memory.id),
        onDismiss: () => flush(memory.id),
      };
      // Each verb says what it does NOT do as well as what it does: delete can
      // be relearned from the chat the fact came from, forget cannot.
      const toastId =
        kind === "forget"
          ? toast.success(`Forgotten. ${PRODUCT_NAME} won’t learn this again.`, options)
          : toast.success(`Deleted. ${PRODUCT_NAME} may learn it again from the chat it came from.`, options);
      queue.add({ memory, kind, toastId });
    },
    [flush, queue, setMember, undo]
  );

  const discardAll = React.useCallback(() => {
    const dropped = queue.discard();
    for (const entry of dropped) toast.dismiss(entry.toastId);
    if (dropped.length > 0) setHiddenIds(new Set());
  }, [queue]);

  React.useEffect(() => {
    const flushAll = () => {
      for (const entry of queue.takeAll()) {
        send(entry);
        // An Undo left on screen after its window has closed would be a lie.
        // The dismiss calls back into `flush`, which finds nothing left.
        toast.dismiss(entry.toastId);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushAll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushAll);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushAll);
      flushAll();
    };
  }, [queue, send]);

  return { hiddenIds, restoredIds, remove, discardAll };
}
