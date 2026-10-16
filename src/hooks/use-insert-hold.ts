"use client";

import * as React from "react";
import { TIMING } from "@/lib/interaction";

/*
 * THE HOLD RULE (spec C11, §10 "Now hold rule").
 *
 * A row that arrives in a list the reader is pointing at, or has focus in,
 * would push the row under their pointer down just as they click it. So while
 * the pointer is over the rows or focus is within the list, new rows are
 * queued instead of inserted, and the list shows "{n} updates". The queue
 * flushes:
 *
 *   - `--delay-insert-flush` (300ms) after the pointer leaves and focus goes,
 *   - on demand (the pill's click calls `flush()`),
 *   - or when a queued row reaches its maximum hold: 2s for a needs-you row
 *     (`--hold-needs-you-max`, never held for long), 10s for any other
 *     (`--hold-insert-max`).
 *
 * Only arrivals are held. A row that changes or leaves updates at once: an
 * update moves nothing, and holding a removal would leave a stale row under
 * the pointer. Roving focus stays on the same row id across a flush.
 *
 * Signalling a needs-you arrival (the count, the badge, the announcement) is
 * the caller's job and is never held; only the row's insertion is.
 *
 * `createInsertHold` is the clock-driven core, DOM-free, so it is tested with
 * an injected clock; `useInsertHold` wires it to a list element.
 */

export type InsertKind = "needsYou" | "default";

export const INSERT_HOLD = {
  flushAfterLeaveMs: TIMING.insertFlush,
  maxHoldMs: { needsYou: TIMING.needsYouMax, default: TIMING.insertMax } satisfies Record<InsertKind, number>,
} as const;

export interface HoldClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: HoldClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface InsertHoldState {
  /** Ids the list shows. */
  shown: ReadonlySet<string>;
  /** Ids waiting to be inserted. */
  pending: readonly string[];
}

export interface InsertHold {
  /** The current ids, in order, with each one's kind. Returns the state. */
  sync(rows: ReadonlyArray<{ id: string; kind: InsertKind }>): InsertHoldState;
  /** The pointer is over the rows, or focus is within the list. */
  setHolding(holding: boolean): void;
  /** Insert everything queued now. */
  flush(): void;
  state(): InsertHoldState;
  dispose(): void;
}

export function createInsertHold(onChange: (state: InsertHoldState) => void, clock: HoldClock = realClock): InsertHold {
  let shown = new Set<string>();
  let current: Array<{ id: string; kind: InsertKind }> = [];
  const queuedAt = new Map<string, { at: number; kind: InsertKind }>();
  let holding = false;
  let initialised = false;
  let leaveTimer: unknown = null;
  let deadlineTimer: unknown = null;

  const snapshot = (): InsertHoldState => ({ shown: new Set(shown), pending: current.filter((r) => !shown.has(r.id)).map((r) => r.id) });
  const emit = () => onChange(snapshot());

  const clearDeadline = () => {
    if (deadlineTimer !== null) clock.clearTimeout(deadlineTimer);
    deadlineTimer = null;
  };

  const release = (ids: Iterable<string>) => {
    let changed = false;
    for (const id of ids) {
      if (!shown.has(id)) {
        shown.add(id);
        changed = true;
      }
      queuedAt.delete(id);
    }
    return changed;
  };

  const flushAll = () => {
    if (leaveTimer !== null) clock.clearTimeout(leaveTimer);
    leaveTimer = null;
    clearDeadline();
    const changed = release(current.map((r) => r.id));
    queuedAt.clear();
    if (changed) emit();
  };

  // Releases every queued row whose maximum hold has passed, and arms a timer for the next one.
  const armDeadline = () => {
    clearDeadline();
    if (queuedAt.size === 0) return;
    const now = clock.now();
    const due: string[] = [];
    let next = Infinity;
    for (const [id, { at, kind }] of queuedAt) {
      const deadline = at + INSERT_HOLD.maxHoldMs[kind];
      if (deadline <= now) due.push(id);
      else next = Math.min(next, deadline);
    }
    if (due.length && release(due)) emit();
    if (next !== Infinity) deadlineTimer = clock.setTimeout(armDeadline, next - now);
  };

  return {
    sync(rows) {
      current = rows.map((r) => ({ id: r.id, kind: r.kind }));
      const ids = new Set(current.map((r) => r.id));
      // Removals and updates apply at once.
      for (const id of [...shown]) if (!ids.has(id)) shown.delete(id);
      for (const id of [...queuedAt.keys()]) if (!ids.has(id)) queuedAt.delete(id);
      if (!initialised) {
        // The first rows are the list, not arrivals.
        initialised = true;
        for (const r of current) shown.add(r.id);
        return snapshot();
      }
      const now = clock.now();
      for (const r of current) {
        if (shown.has(r.id) || queuedAt.has(r.id)) continue;
        if (holding) queuedAt.set(r.id, { at: now, kind: r.kind });
        else shown.add(r.id);
      }
      armDeadline();
      return snapshot();
    },
    setHolding(next) {
      if (next === holding) return;
      holding = next;
      if (holding) {
        if (leaveTimer !== null) clock.clearTimeout(leaveTimer);
        leaveTimer = null;
        return;
      }
      if (queuedAt.size === 0) return;
      leaveTimer = clock.setTimeout(() => {
        leaveTimer = null;
        flushAll();
      }, INSERT_HOLD.flushAfterLeaveMs);
    },
    flush: flushAll,
    state: snapshot,
    dispose() {
      if (leaveTimer !== null) clock.clearTimeout(leaveTimer);
      clearDeadline();
    },
  };
}

export interface UseInsertHoldOptions<T> {
  /** The id of a row; rows carry it as `data-row-id` for roving focus. */
  getId: (row: T) => string;
  /** A needs-you row is held at most 2s, any other at most 10s. */
  kind?: InsertKind | ((row: T) => InsertKind);
  /** Off: every row inserts at once (a list nobody can hover, a phone). */
  enabled?: boolean;
  clock?: HoldClock;
}

export interface UseInsertHoldResult<T> {
  /** The rows to render, arrivals held back while the reader is in the list. */
  rows: T[];
  /** How many arrivals are waiting: the "{n} updates" pill shows while this is above 0. */
  pendingCount: number;
  /** Insert everything now (the pill's click). */
  flush: () => void;
}

/**
 * Holds row arrivals in `listRef` while the pointer is over it or focus is
 * within it. Pass every row; render `rows`.
 */
export function useInsertHold<T>(
  listRef: React.RefObject<HTMLElement | null>,
  items: readonly T[],
  { getId, kind = "default", enabled = true, clock }: UseInsertHoldOptions<T>,
): UseInsertHoldResult<T> {
  const [state, setState] = React.useState<InsertHoldState | null>(null);
  const hold = React.useMemo(() => createInsertHold(setState, clock), [clock]);
  React.useEffect(() => () => hold.dispose(), [hold]);

  const kindOf = React.useCallback((row: T): InsertKind => (typeof kind === "function" ? kind(row) : kind), [kind]);
  const synced = React.useMemo(
    () => hold.sync(enabled ? items.map((row) => ({ id: getId(row), kind: kindOf(row) })) : []),
    [hold, items, getId, kindOf, enabled],
  );
  React.useEffect(() => {
    if (!enabled) hold.flush();
  }, [enabled, hold]);

  // Re-read after either a sync (new items) or a timer flush (setState).
  const current = React.useMemo(() => hold.state(), [hold, synced, state]);

  // Pointer over the rows, or focus within the list, holds.
  const focusedRow = React.useRef<string | null>(null);
  React.useEffect(() => {
    const list = listRef.current;
    if (!list || !enabled) return;
    let pointer = false;
    let focus = false;
    const update = () => hold.setHolding(pointer || focus);
    const rowIdOf = (node: EventTarget | null) => (node instanceof Element ? node.closest("[data-row-id]")?.getAttribute("data-row-id") ?? null : null);
    const onEnter = () => {
      pointer = true;
      update();
    };
    const onLeave = () => {
      pointer = false;
      update();
    };
    const onFocusIn = (event: FocusEvent) => {
      focus = true;
      focusedRow.current = rowIdOf(event.target);
      update();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && list.contains(event.relatedTarget)) return;
      focus = false;
      update();
    };
    list.addEventListener("pointerenter", onEnter);
    list.addEventListener("pointerleave", onLeave);
    list.addEventListener("focusin", onFocusIn);
    list.addEventListener("focusout", onFocusOut);
    return () => {
      list.removeEventListener("pointerenter", onEnter);
      list.removeEventListener("pointerleave", onLeave);
      list.removeEventListener("focusin", onFocusIn);
      list.removeEventListener("focusout", onFocusOut);
      hold.setHolding(false);
    };
  }, [listRef, hold, enabled]);

  const rows = React.useMemo(
    () => (enabled ? items.filter((row) => current.shown.has(getId(row))) : [...items]),
    [items, current, getId, enabled],
  );

  // Roving focus keeps the same row id: if a flush remounted the focused row, focus it again.
  React.useLayoutEffect(() => {
    const list = listRef.current;
    const id = focusedRow.current;
    if (!list || !id || typeof document === "undefined") return;
    if (list.contains(document.activeElement)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const row = list.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    row?.focus({ preventScroll: true });
  }, [rows, listRef]);

  return { rows, pendingCount: enabled ? current.pending.length : 0, flush: hold.flush };
}
