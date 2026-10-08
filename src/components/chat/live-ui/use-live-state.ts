"use client";

import * as React from "react";
import type { LiveValue } from "@/lib/live-ui/expr";
import { liveDefaults, liveInputs, liveStorageKey, type LiveComponent, type LiveSpec } from "@/lib/live-ui/spec";

/**
 * Input values, checklist ticks and nothing else: the whole state of one view.
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
  setValue: (id: string, value: LiveValue) => void;
  toggleCheck: (id: string, index: number) => void;
  reset: () => void;
  /** Anything differs from the author's defaults. */
  dirty: boolean;
}

interface Stored {
  v?: Record<string, LiveValue>;
  c?: Record<string, number[]>;
}

function checklistIds(ui: readonly LiveComponent[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: readonly LiveComponent[]) => {
    for (const c of list) {
      if ("children" in c) walk(c.children);
      else if (c.type === "checklist") ids.add(c.id);
    }
  };
  walk(ui);
  return ids;
}

function sameType(a: LiveValue, b: LiveValue): boolean {
  return typeof a === typeof b && Array.isArray(a) === Array.isArray(b);
}

export function useLiveState(spec: LiveSpec | null, source: string, messageId: string | undefined): LiveState {
  const defaults = React.useMemo(() => (spec ? liveDefaults(spec) : {}), [spec]);
  const [touched, setTouched] = React.useState<Record<string, LiveValue>>({});
  const [checks, setChecks] = React.useState<Record<string, number[]>>({});
  const complete = !!spec && !spec.streaming;
  const key = complete ? liveStorageKey(messageId, source) : null;
  const loadedKey = React.useRef<string | null>(null);

  // Restore once the block is whole. Only ids that still exist, with the
  // same kind of value, come back: an edited reply must not inherit a string
  // into a slider.
  React.useEffect(() => {
    if (!key || loadedKey.current === key || !spec) return;
    loadedKey.current = key;
    let stored: Stored | null = null;
    try {
      const raw = window.localStorage.getItem(key);
      stored = raw ? (JSON.parse(raw) as Stored) : null;
    } catch {
      stored = null;
    }
    if (!stored) return;
    const inputs = new Map(liveInputs(spec.ui).map((i) => [i.id, i.value as LiveValue]));
    const restored: Record<string, LiveValue> = {};
    for (const [id, v] of Object.entries(stored.v ?? {})) {
      const d = inputs.get(id);
      if (d !== undefined && sameType(d, v)) restored[id] = v;
    }
    const lists = checklistIds(spec.ui);
    const restoredChecks: Record<string, number[]> = {};
    for (const [id, list] of Object.entries(stored.c ?? {})) {
      if (lists.has(id) && Array.isArray(list)) restoredChecks[id] = list.filter((n) => Number.isInteger(n)).slice(0, 40);
    }
    setTouched((t) => ({ ...restored, ...t }));
    setChecks((c) => ({ ...restoredChecks, ...c }));
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
        if (!dirty) window.localStorage.removeItem(key);
        else {
          const v: Record<string, LiveValue> = {};
          for (const [id, value] of Object.entries(touched)) if (defaults[id] !== value) v[id] = value;
          window.localStorage.setItem(key, JSON.stringify({ v, c: checks } satisfies Stored));
        }
      } catch {
        // Storage full or blocked: the view still works, it just forgets.
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [key, touched, checks, dirty, defaults]);

  const setValue = React.useCallback((id: string, value: LiveValue) => {
    setTouched((t) => (t[id] === value ? t : { ...t, [id]: value }));
  }, []);

  const toggleCheck = React.useCallback((id: string, index: number) => {
    setChecks((c) => {
      const list = c[id] ?? [];
      return { ...c, [id]: list.includes(index) ? list.filter((n) => n !== index) : [...list, index] };
    });
  }, []);

  const reset = React.useCallback(() => {
    setTouched({});
    setChecks({});
  }, []);

  return { values, checks, setValue, toggleCheck, reset, dirty };
}
