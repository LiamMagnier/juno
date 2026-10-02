"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RESEARCH_COPY } from "@/components/research/copy";
import { createCompletionWatch, type CompletionWatch } from "@/components/research/completion-watch";
import {
  RESEARCH_FINISHED_EVENT,
  RESEARCH_STARTED_EVENT,
  fetchLiveRuns,
  type ResearchFinishedDetail,
} from "@/components/research/research-discovery";
import { useUiLocale } from "@/lib/i18n-format";
import { formatPhrase, phraseText } from "@/lib/i18n-phrase";
import { setTitleOverride } from "@/lib/title-override";
import type { ResearchRunSummary } from "@/types/research";

/*
 * Notices when a run finishes while the reader is elsewhere (SPEC §9.8,
 * DECISIONS R7): the tab title through the title override, a toast with
 * "Open" when they are on another conversation or route, and — only if they
 * turned it on — a browser notification while the tab is hidden. Every
 * finish is announced on `window` as `juno:research-finished`, which the open
 * conversation uses to refetch so the completion message appears without a
 * reload. Mounted once in the app shell; the rules are `completion-watch.ts`.
 */

export interface ResearchCompletionWatcherProps {
  /** The conversation on screen, or null; no toast for a run the reader is already looking at. */
  activeConversationId: string | null;
}

/** Where a finished run is read: its conversation with the panel open on it. */
export function researchRunHref(run: Pick<ResearchRunSummary, "id" | "conversationId">): string {
  const query = `researchRun=${encodeURIComponent(run.id)}`;
  return run.conversationId ? `/chat/${encodeURIComponent(run.conversationId)}?${query}` : `/chat?${query}`;
}

export function ResearchCompletionWatcher({ activeConversationId }: ResearchCompletionWatcherProps) {
  const router = useRouter();
  const locale = useUiLocale();
  const active = React.useRef(activeConversationId);
  active.current = activeConversationId;
  const context = React.useRef({ router, locale });
  context.current = { router, locale };

  const watchRef = React.useRef<CompletionWatch | null>(null);

  // Built in the effect, not in state: a disposed watch never polls again, and
  // Strict Mode disposes the first mount's.
  React.useEffect(() => {
    const watch = createCompletionWatch({
      fetchLiveRuns: () => fetchLiveRuns((input, init) => window.fetch(input, init)),
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (timer) => window.clearTimeout(timer as number),
      hidden: () => document.visibilityState === "hidden",
      activeConversationId: () => active.current,
      setTitleOverride,
      readyTitle: (run) =>
        phraseText(
          run.title
            ? { parts: [{ phrase: RESEARCH_COPY.phase.done }, { kind: "label", value: run.title }] }
            : { parts: [{ phrase: RESEARCH_COPY.phase.done }] },
          context.current.locale,
        ),
      toast: (kind, run) => {
        const open = { label: formatPhrase(RESEARCH_COPY.watcher.open), onClick: () => context.current.router.push(researchRunHref(run)) };
        if (kind === "ready") {
          toast(formatPhrase(RESEARCH_COPY.watcher.reportReady), { description: run.title ?? undefined, action: open });
        } else {
          toast.error(formatPhrase(RESEARCH_COPY.watcher.couldNotFinish), { description: run.title ?? undefined, action: open });
        }
      },
      notificationPermission: () => {
        try {
          return typeof Notification === "undefined" ? null : Notification.permission;
        } catch {
          return null;
        }
      },
      notify: (run) => {
        try {
          const notification = new Notification(formatPhrase(RESEARCH_COPY.watcher.reportReady), {
            body: run.title ?? undefined,
            tag: run.id,
          });
          notification.onclick = () => {
            window.focus();
            context.current.router.push(researchRunHref(run));
            notification.close();
          };
        } catch {
          // Some browsers only allow notifications from a service worker; the title and toast still tell.
        }
      },
      finished: (detail: ResearchFinishedDetail) => {
        window.dispatchEvent(new CustomEvent<ResearchFinishedDetail>(RESEARCH_FINISHED_EVENT, { detail }));
      },
    });
    watchRef.current = watch;
    watch.start();
    const onVisibility = () => {
      watch.sync();
      // Back from another tab: look now rather than at the end of a 60 s sleep.
      if (document.visibilityState === "visible") void watch.poll();
    };
    const onFocus = () => watch.sync();
    const onStarted = () => void watch.poll();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener(RESEARCH_STARTED_EVENT, onStarted);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(RESEARCH_STARTED_EVENT, onStarted);
      watch.dispose();
      if (watchRef.current === watch) watchRef.current = null;
    };
  }, []);

  // Arriving on a run's conversation clears its "Report ready" title.
  React.useEffect(() => {
    watchRef.current?.sync();
  }, [activeConversationId]);

  return null;
}
