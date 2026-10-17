"use client";

/**
 * The account's Code defaults on the client (src/lib/code-v2/code-prefs.ts),
 * one store for the page: Settings edits them, the Code workspace reads them
 * as its last fallback.
 *
 * Fetched once per page from /api/code/prefs. The last answer is also kept in
 * this browser so a workspace that mounts before the fetch returns still
 * starts from the account's defaults, not the built-in ones; the server stays
 * the source of truth and overwrites it.
 */
import * as React from "react";
import { toast } from "sonner";
import { mergeCodePrefs, sanitizeCodePrefs, type CodePrefs, type CodePrefsPatch } from "@/lib/code-v2/code-prefs";

const CACHE_KEY = "alevr.code.accountPrefs";

interface State {
  prefs: CodePrefs;
  /** The server answered (or failed): Settings stops showing its loading line. */
  loaded: boolean;
}

function readCache(): CodePrefs {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(CACHE_KEY);
    return raw ? sanitizeCodePrefs(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function writeCache(prefs: CodePrefs) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
  } catch {
    /* a per-browser convenience; the server keeps the real copy */
  }
}

let state: State | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const SERVER_STATE: State = { prefs: {}, loaded: false };

function current(): State {
  state ??= { prefs: readCache(), loaded: false };
  return state;
}

function set(next: State) {
  state = next;
  writeCache(next.prefs);
  for (const l of listeners) l();
}

function load() {
  loading ??= fetch("/api/code/prefs", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { prefs?: unknown } | null) => set({ prefs: body ? sanitizeCodePrefs(body.prefs) : current().prefs, loaded: true }))
    .catch(() => set({ ...current(), loaded: true }));
  return loading;
}

/** Saves a change: shown at once, taken back (with a sentence) if the server refuses it. */
export async function updateCodePrefs(patch: CodePrefsPatch): Promise<boolean> {
  const before = current();
  set({ ...before, prefs: mergeCodePrefs(before.prefs, patch) });
  try {
    const res = await fetch("/api/code/prefs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { prefs?: unknown };
    set({ prefs: sanitizeCodePrefs(body.prefs), loaded: true });
    return true;
  } catch {
    set(before);
    toast.error("Could not save your Code defaults.");
    return false;
  }
}

/** Test seam: forget the page's copy. */
export function resetCodePrefsStore() {
  state = null;
  loading = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const serverState = () => SERVER_STATE;

export function useCodePrefs(): State & { update: typeof updateCodePrefs } {
  const snapshot = React.useSyncExternalStore(subscribe, current, serverState);
  React.useEffect(() => {
    void load();
  }, []);
  return { ...snapshot, update: updateCodePrefs };
}

/** The defaults as this browser last knew them, without subscribing (a workspace's first render). */
export function cachedCodePrefs(): CodePrefs {
  return current().prefs;
}
