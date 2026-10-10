"use client";

/**
 * The web's half of per-thread draft sync (docs/code-v2/REMOTE-CONTROL.md
 * §Sync): what is typed in a chat's composer reaches the same chat on the Mac
 * and the iPhone, and theirs reaches this tab.
 *
 * - Writes are debounced (700 ms after the last keystroke) and stamped with
 *   the time of that keystroke, so the newest typing wins on every device.
 * - A sent message clears the draft everywhere at once.
 * - A remote draft is applied only to a field that is empty or not being
 *   edited, never over unsent typing, and never this tab's own echo.
 *
 * Plain functions over `fetch` plus one hook; the composer keeps its own
 * local (sessionStorage) draft as before, this only adds the other devices.
 */
import * as React from "react";

export const DRAFT_SYNC_DEBOUNCE_MS = 700;

export interface RemoteThreadState {
  key: string;
  draft: string;
  draftUpdatedAt: string | null;
  draftBy: string | null;
  updatedAt: string;
}

/** This tab's name as a draft writer ("web:<random>"), stable for the tab's life. */
export function webDeviceId(): string {
  const KEY = "alevr.sync.device";
  try {
    const existing = window.sessionStorage.getItem(KEY);
    if (existing) return existing;
    const id = `web:${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    return "web";
  }
}

const threadUrl = (key: string) => `/api/sync/threads/${encodeURIComponent(key)}`;

export async function fetchThreadState(key: string, fetcher: typeof fetch = fetch): Promise<RemoteThreadState | null> {
  try {
    const res = await fetcher(threadUrl(key), { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { thread: RemoteThreadState | null };
    return body.thread;
  } catch {
    return null;
  }
}

export async function writeThreadDraft(key: string, draft: string, at: Date, device: string, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    await fetcher(threadUrl(key), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      keepalive: draft.length < 60_000,
      body: JSON.stringify({ draft, draftUpdatedAt: at.toISOString(), device }),
    });
  } catch {
    /* Offline: the local draft is still kept; the next keystroke tries again. */
  }
}

/**
 * Whether a remote state should replace what the field shows: something to
 * show, not this tab's echo, newer than what this tab last wrote or read, and
 * the field is not being edited.
 */
export function shouldApplyRemoteDraft(
  remote: Pick<RemoteThreadState, "draft" | "draftBy" | "draftUpdatedAt">,
  local: { text: string; editing: boolean; device: string; lastKnownAt: number },
): boolean {
  if (remote.draftBy === local.device) return false;
  if (local.editing) return false;
  const at = remote.draftUpdatedAt ? Date.parse(remote.draftUpdatedAt) : 0;
  if (!(at > local.lastKnownAt)) return false;
  return remote.draft !== local.text;
}

/**
 * Wires one composer to the backend: `key` is `chat:<conversationId>` (null
 * turns it off: a new chat, incognito, steering). `read()` returns the field's
 * text and whether it has focus; `apply(text)` replaces the field's text.
 * Returns `changed(text)` for every edit and `cleared()` for a send.
 */
export function useThreadDraftSync(
  key: string | null,
  read: () => { text: string; editing: boolean },
  apply: (text: string) => void,
): { changed: (text: string) => void; cleared: () => void } {
  const device = React.useRef<string>("web");
  const lastKnownAt = React.useRef(0);
  const timer = React.useRef<number | null>(null);
  const pending = React.useRef<{ text: string; at: Date } | null>(null);
  const readRef = React.useRef(read);
  const applyRef = React.useRef(apply);
  readRef.current = read;
  applyRef.current = apply;

  React.useEffect(() => {
    device.current = webDeviceId();
  }, []);

  const flush = React.useCallback((forKey: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const draft = pending.current;
    pending.current = null;
    if (!draft) return;
    lastKnownAt.current = Math.max(lastKnownAt.current, draft.at.getTime());
    void writeThreadDraft(forKey, draft.text, draft.at, device.current);
  }, []);

  // Open: take a newer draft written elsewhere; then follow this thread's
  // changes with a long-poll while it stays open.
  React.useEffect(() => {
    if (!key) return;
    let cancelled = false;
    lastKnownAt.current = 0;
    const consider = (state: RemoteThreadState | null) => {
      if (!state || cancelled) return;
      const local = readRef.current();
      if (shouldApplyRemoteDraft(state, { ...local, device: device.current, lastKnownAt: lastKnownAt.current })) {
        // An empty field takes it; a field with text only when that text is
        // what this device already synced (so a cleared draft clears it too).
        applyRef.current(state.draft);
      }
      const at = state.draftUpdatedAt ? Date.parse(state.draftUpdatedAt) : 0;
      if (at > lastKnownAt.current && !local.editing) lastKnownAt.current = at;
    };
    void fetchThreadState(key).then(consider);
    let cursor: string | null = null;
    const controller = new AbortController();
    void (async () => {
      while (!cancelled) {
        try {
          const params = new URLSearchParams({ keys: key, wait: "20000" });
          if (cursor) params.set("cursor", cursor);
          const res = await fetch(`/api/sync/threads?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
          if (!res.ok) throw new Error(String(res.status));
          const body = (await res.json()) as { threads: RemoteThreadState[]; cursor: string | null };
          cursor = body.cursor ?? cursor;
          for (const state of body.threads) consider(state);
        } catch {
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      flush(key);
    };
  }, [key, flush]);

  const changed = React.useCallback(
    (text: string) => {
      if (!key) return;
      pending.current = { text, at: new Date() };
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flush(key), DRAFT_SYNC_DEBOUNCE_MS);
    },
    [key, flush],
  );

  const cleared = React.useCallback(() => {
    if (!key) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    const at = new Date();
    lastKnownAt.current = at.getTime();
    void writeThreadDraft(key, "", at, device.current);
  }, [key]);

  return React.useMemo(() => ({ changed, cleared }), [changed, cleared]);
}
