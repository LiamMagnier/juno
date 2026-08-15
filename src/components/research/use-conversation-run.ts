"use client";

import * as React from "react";
import { useResearchRun, type ResearchRunView } from "@/components/research/use-research-run";
import { isWorkingResearchState } from "@/lib/research/domain";

/**
 * The newest research run attached to a conversation, polled once.
 *
 * Lifted out of `ResearchRunPanel` because the run stopped being the panel's
 * private business: the composer now steers and stops it, and the panel draws
 * it, and those are two components with one row between them. Two callers each
 * running `useResearchRun` would be two pollers, two event cursors and two
 * answers to "is this still going" — and a cursor is exactly the kind of state
 * that must not be duplicated, since each copy would re-fetch from the top
 * whenever the other advanced.
 *
 * So the owner is whoever renders both. The panel takes the run as a prop, and
 * the composer takes the two verbs below.
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

export function useConversationResearch(conversationId: string | null) {
  const [runId, setRunId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setRunId(null);
    if (!conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/research?conversationId=${encodeURIComponent(conversationId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { runs?: Array<{ id: string }> };
        if (!cancelled) setRunId(data.runs?.[0]?.id ?? null);
      } catch {
        // A conversation whose run cannot be found simply has no panel and no
        // steering. This is an addition to the chat, never a reason to break it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const research = useResearchRun(runId);
  const { run, post } = research;
  const accepting = !!run && run.live && isWorkingResearchState(run.state);

  const steering = React.useMemo<ResearchSteering | null>(() => {
    if (!run) return null;
    return {
      accepting,
      // A URL is a source to read; anything else is a constraint on the whole
      // report. Guessing beats a mode switch the user has to find before they
      // can type — the same call the old steering form made, kept.
      steer: (text: string) =>
        post("/steer", /^https?:\/\//i.test(text.trim()) ? { sourceUrl: text.trim() } : { constraint: text.trim() }),
      stop: () => void post("/control", { action: "cancel" }),
    };
  }, [run, accepting, post]);

  return { ...research, runId, steering, run: run as ResearchRunView | null };
}
