"use client";

import * as React from "react";
import { useResearchRun, type ResearchRunView } from "@/components/research/use-research-run";
import { currentRunId, watchConversationRuns, type ConversationRunsWatcher } from "@/components/research/research-discovery";
import { isWorkingResearchState } from "@/lib/research/domain";
import type { ResearchRunSummary } from "@/types/research";

/**
 * The research runs attached to a conversation, and the newest one kept fresh.
 *
 * Lifted out of `ResearchRunPanel` because the run stopped being the panel's
 * private business: the composer steers it and the panel draws it, and those
 * are two components with one row between them. The run itself is read through
 * `useResearchRun`, whose store keeps one poller per run however many
 * surfaces ask.
 *
 * Discovery is one fetch when the conversation opens and one more whenever a
 * run in it starts or finishes (`research-discovery.ts`), not the 4 s poll it
 * used to be (research-UI bug 15). `refresh` is there for the one moment the
 * page learns something first: the chat stream's hand-off frame.
 *
 * The return keeps its old shape (`runId`, `history`, `steering`, `run` and the
 * run hook's fields) until integration switches chat-view over; `runs` and
 * `refresh` are the additions.
 */

export interface ResearchSteering {
  /** True only while a worker is actually spending — the window where added
   *  direction can still change what gets read. A paused run, a run waiting at
   *  the plan gate and a finished run all steer nothing. */
  accepting: boolean;
  /** A constraint, or a source to pin if it parses as a URL. */
  steer: (text: string) => Promise<boolean>;
  /** Cancel the run. Terminal — a cancelled run keeps what it already gathered. */
  stop: () => void;
}

export function useConversationResearch(conversationId: string | null, selectedRunId?: string) {
  const [runs, setRuns] = React.useState<ResearchRunSummary[]>([]);
  const watcher = React.useRef<ConversationRunsWatcher | null>(null);

  React.useEffect(() => {
    setRuns([]);
    if (!conversationId) return;
    const watch = watchConversationRuns({
      fetch: (input, init) => window.fetch(input, init),
      conversationId,
      events: window,
      onRuns: setRuns,
    });
    watcher.current = watch;
    return () => {
      watch.dispose();
      if (watcher.current === watch) watcher.current = null;
    };
  }, [conversationId]);

  const refresh = React.useCallback(() => watcher.current?.refresh() ?? Promise.resolve(), []);

  const runId = currentRunId(runs, selectedRunId);
  const history = React.useMemo(() => runs.map((run) => ({ id: run.id, createdAt: run.createdAt })), [runs]);

  const research = useResearchRun(runId);
  const { run, post } = research;
  const accepting = !!run && run.live && isWorkingResearchState(run.state);

  const steering = React.useMemo<ResearchSteering | null>(() => {
    if (!run) return null;
    return {
      accepting,
      // A URL is a source to read; anything else is a constraint on the whole
      // report. Kept for the composer until it moves to the explicit "Guide
      // the research" mode (§9.7), which sends `guidance` through `steer`.
      steer: (text: string) =>
        post("/steer", /^https?:\/\//i.test(text.trim()) ? { sourceUrl: text.trim() } : { constraint: text.trim() }),
      stop: () => void post("/control", { action: "cancel" }),
    };
  }, [run, accepting, post]);

  return { ...research, runId, history, runs, refresh, steering, run: run as ResearchRunView | null };
}
