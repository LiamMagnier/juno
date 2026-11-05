"use client";

import * as React from "react";
import type { LiveValue } from "@/lib/live-ui/expr";
import {
  liveChecklistIds,
  liveDefaults,
  liveInputs,
  liveLockingCards,
  liveStorageKey,
  type LiveSpec,
} from "@/lib/live-ui/spec";

/**
 * Input values, checklist ticks and locked picks: the whole state of one view.
 *
 * Defaults come from the spec and grow as a streaming block reveals more
 * inputs; a value the reader has touched is never overwritten by a later
 * delta. Once the block is complete, adjusted values persist per message in
 * localStorage (docs/design/LIVE_UI.md §6) — storage is a convenience, so every
 * access is guarded and a private window simply starts from the defaults.
 */
export interface LiveState {
  values: Record<string, LiveValue>;
  checks: Record<string, number[]>;
  /**
   * What the reader picked on a card that locks once they do (choices,
   * compare), by component key. Kept across a reload, so a card whose answer
   * was already sent stays answered.
   */
  picks: Record<string, number[]>;
  setValue: (id: string, value: LiveValue) => void;
  toggleCheck: (id: string, index: number) => void;
  /** Lock a card on the options the reader sent. */
  pick: (key: string, indices: number[]) => void;
  /** Back to the author's values. A pick stays: its message was already sent. */
  reset: () => void;
  /** Anything differs from the author's defaults. */
  dirty: boolean;
}

/** The stored shape. Every key is optional, so state written before a key existed still reads. */
export interface StoredLiveState {
  v?: Record<string, LiveValue>;
  c?: Record<string, number[]>;
  p?: Record<string, number[]>;
}

function sameType(a: LiveValue, b: LiveValue): boolean {
  return typeof a === typeof b && Array.isArray(a) === Array.isArray(b);
}

const indexList = (list: unknown, limit = Infinity): number[] | null =>
  Array.isArray(list) ? list.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < limit).slice(0, 40) : null;

/**
 * What a stored state restores onto this spec. Only ids that still exist, with
 * the same kind of value, come back: an edited reply must not inherit a string
 * into a slider, nor a pick onto a card that no longer has that option.
 */
export function restoreLiveState(
  stored: StoredLiveState | null,
  spec: LiveSpec,
): Pick<LiveState, "values" | "checks" | "picks"> {
  const out: Pick<LiveState, "values" | "checks" | "picks"> = { values: {}, checks: {}, picks: {} };
  if (!stored || typeof stored !== "object") return out;
  const inputs = new Map(liveInputs(spec.ui).map((i) => [i.id, i.value as LiveValue]));
  for (const [id, v] of Object.entries(stored.v ?? {})) {
    const d = inputs.get(id);
    if (d !== undefined && sameType(d, v)) out.values[id] = v;
  }
  const lists = liveChecklistIds(spec.ui);
  for (const [id, list] of Object.entries(stored.c ?? {})) {
    const restored = lists.has(id) ? indexList(list) : null;
    if (restored) out.checks[id] = restored;
  }
  const cards = liveLockingCards(spec.ui);
  for (const [key, list] of Object.entries(stored.p ?? {})) {
    const restored = cards.has(key) ? indexList(list, cards.get(key)) : null;
    if (restored && restored.length > 0) out.picks[key] = restored;
  }
  return out;
}

/** What to store for this state, or null when there is nothing to keep. */
export function storedLiveState(input: {
  touched: Record<string, LiveValue>;
  defaults: Record<string, LiveValue>;
  checks: Record<string, number[]>;
  picks: Record<string, number[]>;
  dirty: boolean;
}): StoredLiveState | null {
  const picked = Object.keys(input.picks).length > 0;
  if (!input.dirty && !picked) return null;
  const v: Record<string, LiveValue> = {};
  for (const [id, value] of Object.entries(input.touched)) if (input.defaults[id] !== value) v[id] = value;
  return { v, c: input.checks, ...(picked ? { p: input.picks } : {}) };
}

export function useLiveState(spec: LiveSpec | null, source: string, messageId: string | undefined): LiveState {
  const defaults = React.useMemo(() => (spec ? liveDefaults(spec) : {}), [spec]);
  const [touched, setTouched] = React.useState<Record<string, LiveValue>>({});
  const [checks, setChecks] = React.useState<Record<string, number[]>>({});
  const [picks, setPicks] = React.useState<Record<string, number[]>>({});
  const complete = !!spec && !spec.streaming;
  const key = complete ? liveStorageKey(messageId, source) : null;
  const loadedKey = React.useRef<string | null>(null);

  // Restore once the block is whole.
  React.useEffect(() => {
    if (!key || loadedKey.current === key || !spec) return;
    loadedKey.current = key;
    let stored: StoredLiveState | null = null;
    try {
      const raw = window.localStorage.getItem(key);
      stored = raw ? (JSON.parse(raw) as StoredLiveState) : null;
    } catch {
      stored = null;
    }
    if (!stored) return;
    const restored = restoreLiveState(stored, spec);
    setTouched((t) => ({ ...restored.values, ...t }));
    setChecks((c) => ({ ...restored.checks, ...c }));
    setPicks((p) => ({ ...restored.picks, ...p }));
  }, [key, spec]);

  const values = React.useMemo(() => ({ ...defaults, ...touched }), [defaults, touched]);

  const dirty = React.useMemo(
    () =>
      Object.entries(touched).some(([id, v]) => id in defaults && defaults[id] !== v) ||
      Object.values(checks).some((list) => list.length > 0),
    [touched, defaults, checks],
  );

  // Save, debounced: a slider drag is sixty writes a second otherwise.
  React.useEffect(() => {
    if (!key || loadedKey.current !== key) return;
    const timer = window.setTimeout(() => {
      try {
        const stored = storedLiveState({ touched, defaults, checks, picks, dirty });
        if (!stored) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify(stored));
      } catch {
        // Storage full or blocked: the view still works, it just forgets.
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [key, touched, checks, picks, dirty, defaults]);

  const setValue = React.useCallback((id: string, value: LiveValue) => {
    setTouched((t) => (t[id] === value ? t : { ...t, [id]: value }));
  }, []);

  const toggleCheck = React.useCallback((id: string, index: number) => {
    setChecks((c) => {
      const list = c[id] ?? [];
      return { ...c, [id]: list.includes(index) ? list.filter((n) => n !== index) : [...list, index] };
    });
  }, []);

  const pick = React.useCallback((cardKey: string, indices: number[]) => {
    if (indices.length === 0) return;
    setPicks((p) => (p[cardKey] ? p : { ...p, [cardKey]: indices }));
  }, []);

  const reset = React.useCallback(() => {
    setTouched({});
    setChecks({});
  }, []);

  return { values, checks, picks, setValue, toggleCheck, pick, reset, dirty };
}
