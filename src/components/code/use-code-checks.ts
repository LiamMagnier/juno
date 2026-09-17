"use client";

import * as React from "react";

import type { ChecksReport } from "@/lib/code-checks";

/*
 * WHAT CI SAYS ABOUT THIS SESSION'S BRANCH, POLLED ONLY WHILE SOMEONE IS THERE.
 *
 * One request per interval per open session, against a route that makes two
 * GitHub calls. That is cheap enough to be worth it and expensive enough to
 * gate carefully, so it follows the same two rules every other poll in this
 * surface keeps: nothing runs without a branch to ask about, and nothing runs
 * while the tab is hidden. A background tab holding a thirty-second poll open
 * is a request every thirty seconds for a screen nobody is looking at, and the
 * visibility handler refreshes on return anyway — so the polls it skipped
 * bought nothing.
 *
 * NULL IS "WE HAVE NOT BEEN TOLD", NEVER "NOTHING IS WRONG". The report's own
 * `state: "none"` is the answer for a branch GitHub has no checks for; null
 * here is the answer before the first response and after a failure, and the
 * banner draws nothing for either. A CI indicator that guesses green is worse
 * than no CI indicator.
 */

/** How often the report refreshes while the tab is visible. */
const POLL_MS = 30_000;

export function useCodeChecks(taskId: string | null, enabled: boolean): ChecksReport | null {
  const [report, setReport] = React.useState<ChecksReport | null>(null);

  React.useEffect(() => {
    if (!taskId || !enabled) {
      setReport(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      try {
        const res = await fetch(`/api/code/tasks/${taskId}/checks`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          /*
           * Every failure here means the same thing to a banner: we cannot say.
           * GitHub unlinked (404), the token stale (401), the branch not pushed
           * yet (409), GitHub down (502) — none of them is worth a red plate on
           * a session about code, and each one resolves itself (a link, a push,
           * a retry) without the reader doing anything here.
           */
          setReport(null);
          return;
        }
        const payload = (await res.json()) as ChecksReport;
        if (!cancelled && Array.isArray(payload?.checks)) setReport(payload);
      } catch {
        // An aborted fetch is a navigation, not a failure.
      }
    };

    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [taskId, enabled]);

  return report;
}
