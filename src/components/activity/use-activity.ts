"use client";

import * as React from "react";
import { WORK_LIVE_POLL_MS, WORK_POLL_MS, WORK_SYNC_EVENT } from "@/components/work/work-transport";
import { ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, type ActivityCounts, type ActivityItem, type ActivityPage } from "@/lib/activity/model";

/*
 * THE ACTIVITY READS, for the page and for the sidebar badge.
 *
 * Polled, visibility-gated, and never idle. The account change feed does not
 * carry Work yet (src/lib/work/notify/deliver.ts says why), so this is the same
 * shape every Work surface already uses (`useWorkSessionPoll`): a GET on an
 * interval while the tab is visible, plus an immediate re-read whenever another
 * surface announces a change. What it adds is the cadence rule:
 *
 *   something running       every WORK_LIVE_POLL_MS (5s): the list is moving
 *   only things waiting     every WORK_POLL_MS (30s): a decision may land elsewhere
 *   nothing live at all     no timer: re-read on focus, visibility and events only
 *
 * A failed read keeps the last good answer, for the reason that file gives: a
 * list that empties itself on a flaky connection says "all clear" when the app
 * simply could not find out.
 */

/** Events other surfaces already dispatch when their runs change. Literal here,
 *  checked against their sources in tests/activity-view.test.ts, so importing
 *  them does not pull the Code session hook into this bundle. */
export const ACTIVITY_REFRESH_EVENTS = [WORK_SYNC_EVENT, "juno:code-sync", "juno:research-started", "juno:research-finished", "juno:sync"] as const;

/** Fired after an action on this page changes something, so the badge re-reads at once. */
export const ACTIVITY_SYNC_EVENT = "juno:activity-sync";

export function pollIntervalFor(counts: ActivityCounts | null): number | null {
  if (!counts) return null;
  if (counts.running > 0) return WORK_LIVE_POLL_MS;
  if (counts.needs_you > 0) return WORK_POLL_MS;
  return null;
}

export type ActivityLoad =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; page: ActivityPage };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin", signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Runs `tick` now, on the cadence `interval` names while visible, and on every refresh event. */
function useVisibleRefresh(tick: () => void, interval: number | null, enabled: boolean): void {
  const tickRef = React.useRef(tick);
  tickRef.current = tick;

  React.useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (!document.hidden) tickRef.current();
    };
    const events = [...ACTIVITY_REFRESH_EVENTS, ACTIVITY_SYNC_EVENT];
    for (const name of events) window.addEventListener(name, run);
    document.addEventListener("visibilitychange", run);
    window.addEventListener("focus", run);
    return () => {
      for (const name of events) window.removeEventListener(name, run);
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("focus", run);
    };
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled || interval === null) return;
    const id = window.setInterval(() => {
      if (!document.hidden) tickRef.current();
    }, interval);
    return () => window.clearInterval(id);
  }, [enabled, interval]);
}

/** The page's read: the first page polled, older pages appended on request. */
export function useActivity() {
  const [load, setLoad] = React.useState<ActivityLoad>({ kind: "loading" });
  const [older, setOlder] = React.useState<{ items: ActivityItem[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const inflight = React.useRef<AbortController | null>(null);

  const refresh = React.useCallback(async () => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const page = await getJson<ActivityPage>(`/api/activity?limit=${ACTIVITY_PAGE_DEFAULT}`, controller.signal);
    if (controller.signal.aborted) return;
    if (page) {
      // Older pages the reader asked for stay; `items` below drops any row the
      // fresh first page now holds, so a row that moved up is shown once.
      setLoad({ kind: "ready", page });
    } else {
      setLoad((previous) => (previous.kind === "ready" ? previous : { kind: "error" }));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    return () => inflight.current?.abort();
  }, [refresh]);

  const counts = load.kind === "ready" ? load.page.counts : null;
  useVisibleRefresh(() => void refresh(), pollIntervalFor(counts), true);

  const nextCursor = older ? older.cursor : load.kind === "ready" ? load.page.nextCursor : null;

  const loadMore = React.useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const page = await getJson<ActivityPage>(`/api/activity?limit=${ACTIVITY_PAGE_MAX}&cursor=${encodeURIComponent(nextCursor)}`);
    setLoadingMore(false);
    if (!page) return;
    setOlder((previous) => ({ items: [...(previous?.items ?? []), ...page.items], cursor: page.nextCursor }));
  }, [nextCursor, loadingMore]);

  const items = React.useMemo(() => {
    if (load.kind !== "ready") return [];
    if (!older) return load.page.items;
    const seen = new Set(load.page.items.map((item) => item.id));
    return [...load.page.items, ...older.items.filter((item) => !seen.has(item.id))];
  }, [load, older]);

  const retry = React.useCallback(() => {
    setLoad({ kind: "loading" });
    void refresh();
  }, [refresh]);

  return { load, items, counts, hasMore: nextCursor !== null, loadMore, loadingMore, refresh, retry };
}

/**
 * The sidebar's read: just the counts, polled on the sidebar's existing
 * thirty-second visible-only cadence (it lives for the whole session, so it
 * never takes the five-second rate), and re-read on every refresh event.
 */
export function useActivityCounts(enabled = true): ActivityCounts | null {
  const [counts, setCounts] = React.useState<ActivityCounts | null>(null);
  const tick = React.useCallback(async () => {
    const body = await getJson<{ counts: ActivityCounts }>("/api/activity/counts");
    if (body?.counts) setCounts(body.counts);
  }, []);
  React.useEffect(() => {
    if (enabled) void tick();
  }, [enabled, tick]);
  useVisibleRefresh(() => void tick(), enabled ? WORK_POLL_MS : null, enabled);
  return enabled ? counts : null;
}

/** Stops one item through the endpoint its own surface already uses. */
export async function stopActivityItem(item: ActivityItem): Promise<boolean> {
  let url: string;
  let body: unknown = undefined;
  if (item.kind === "work") {
    if (!item.runId) return false;
    url = `/api/work/runs/${encodeURIComponent(item.runId)}/control`;
    body = { action: "cancel" };
  } else if (item.kind === "code") {
    url = `/api/code/tasks/${encodeURIComponent(item.sourceId)}/cancel`;
  } else {
    url = `/api/research/${encodeURIComponent(item.sourceId)}/control`;
    body = { action: "cancel" };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) window.dispatchEvent(new Event(ACTIVITY_SYNC_EVENT));
    return res.ok;
  } catch {
    return false;
  }
}
