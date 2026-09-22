"use client";

import * as React from "react";
import { toast } from "sonner";
import type { Memory } from "@/components/memory/memory-model";

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
 * (a route change), or the tab is being hidden for good (`pagehide`, best
 * effort, since a request started during unload may not complete).
 */

export type RemovalKind = "forget" | "delete";

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
}

export function useDeferredRemoval(
  commit: (memory: Memory, kind: RemovalKind) => Promise<boolean>
): DeferredRemoval {
  const [hiddenIds, setHiddenIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [restoredIds, setRestoredIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const pending = React.useRef(new Map<string, { memory: Memory; kind: RemovalKind; toastId: string | number }>());
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

  const flush = React.useCallback(
    (id: string) => {
      const entry = pending.current.get(id);
      if (!entry) return;
      pending.current.delete(id);
      // The row stays hidden until the server has answered: a delete has
      // already dropped it from the list by then, a forget has reloaded it into
      // the retired trail, and a failure brings it back where it was (the
      // memory hook explains the failure in its own toast).
      void commitRef.current(entry.memory, entry.kind).finally(() => setMember(setHiddenIds, id, false));
    },
    [setMember]
  );

  const undo = React.useCallback(
    (id: string) => {
      if (!pending.current.delete(id)) return;
      setMember(setHiddenIds, id, false);
      setMember(setRestoredIds, id, true);
      window.setTimeout(() => setMember(setRestoredIds, id, false), RESTORE_FLAG_MS);
    },
    [setMember]
  );

  const remove = React.useCallback(
    (memory: Memory, kind: RemovalKind) => {
      if (pending.current.has(memory.id)) return;
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
          ? toast.success("Forgotten. Juno won’t learn this again.", options)
          : toast.success("Deleted. Juno may learn it again from the chat it came from.", options);
      pending.current.set(memory.id, { memory, kind, toastId });
    },
    [flush, setMember, undo]
  );

  React.useEffect(() => {
    const flushAll = () => {
      for (const [id, entry] of [...pending.current]) {
        flush(id);
        // An Undo left on screen after its window has closed would be a lie.
        toast.dismiss(entry.toastId);
      }
    };
    window.addEventListener("pagehide", flushAll);
    return () => {
      window.removeEventListener("pagehide", flushAll);
      flushAll();
    };
  }, [flush]);

  return { hiddenIds, restoredIds, remove };
}
