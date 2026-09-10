"use client";

import * as React from "react";
import { needsYou } from "@/components/work/inbox/triage";
import {
  WORK_POLL_MS,
  WORK_SYNC_EVENT,
  fetchWorkSessions,
} from "@/components/work/work-transport";

/*
 * How many tasks are blocked on the reader, for a badge outside Work.
 *
 * The Work home's own header comment has promised a "3 need you" mark in the
 * sidebar since the inbox was written, and the sidebar has had a plain "Work"
 * link the whole time. This is the number for that mark: the account's rows
 * with `needsAttention` set (`?needsAttention=true`, the whole account rather
 * than a page), re-checked through `needsYou` so the badge and the inbox's
 * "Needs you" pill count the same rows.
 *
 * Null until the first answer lands and null again after a failed read — a
 * badge that showed 0 on a dropped request would be telling the reader nothing
 * is waiting when Juno simply could not find out. Refreshed on the same clock
 * and the same `WORK_SYNC_EVENT` every other Work surface uses, so answering an
 * approval clears the number now rather than in thirty seconds.
 *
 * Nothing is fetched while the tab is hidden. Every call is one small GET; a
 * sidebar that mounts once and lives for the session must not turn that into a
 * background poll on a tab nobody is looking at.
 */
export function useWorkNeedsYouCount(): number | null {
  const [count, setCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await fetchWorkSessions({ needsAttention: true, limit: 100 });
      if (cancelled) return;
      setCount(result.kind === "ok" ? result.value.filter(needsYou).length : null);
    };
    const tick = () => {
      if (!document.hidden) void load();
    };
    tick();
    const interval = window.setInterval(tick, WORK_POLL_MS);
    window.addEventListener(WORK_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(WORK_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  return count;
}
