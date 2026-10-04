"use client";

import * as React from "react";
import { EvidencePanel } from "@/components/research/evidence-panel";
import { ReportFullscreen } from "@/components/research/report-fullscreen";
import { useReportModel } from "@/components/research/report-document";
import { ResearchConsole } from "@/components/research/research-console";
import { ResearchRecap } from "@/components/research/research-recap";
import { RunTimeline } from "@/components/research/run-timeline";
import { SourceDeck } from "@/components/research/source-deck";
import { isResearchState, isTerminalResearchState, type ResearchEventDTO, type ResearchState } from "@/lib/research/domain";
import { useResearchRun, type ResearchRunView } from "@/components/research/use-research-run";
import { ThinkingMark } from "@/components/brand/thinking-mark";
import { Button } from "@/components/ui/button";
import { FEATURE_NAMES } from "@/lib/brand/names";
import { cn } from "@/lib/utils";
// Deep Field's styles, loaded once by the surface that mounts every research
// view (console, gates, cover, reader). Not from the views themselves: node
// tests import those, and node cannot load a stylesheet.
import "@/components/research/research.css";

/**
 * The durable research run, next to the conversation that started it.
 *
 * This file used to be the whole surface — four hundred lines that drew a stage
 * ladder, an objective list, a coverage note per objective, an audit strip, a
 * source scatter plot, a step log, a source list and a steering form, all at
 * once, in every state a run can be in. It is now a router with two
 * destinations, because a run being watched and a run being read are two
 * different products:
 *
 *   LIVE      → ResearchConsole. The question, five acts with the live one
 *               open, the publishers so far, and the machinery behind a
 *               disclosure. The reader's question is "is it working".
 *   TERMINAL  → ResearchRecap. The report's own title, one line of provenance,
 *               the citation verdict, and a door into the document. The
 *               reader's question is "can I trust it and where do I read it".
 *               The old panel answered neither, because it kept rendering the
 *               live view of a run that had finished minutes ago.
 *
 * The machinery is not thrown away at the switch — it moves behind "How it
 * worked" on the recap, which is where an auditor looks and a reader does not.
 *
 * IT NO LONGER OWNS THE RUN. Steering and stopping moved to the composer, which
 * is where a person types at a conversation, so the poll now lives in
 * `useConversationResearch` one level up and this component receives what it
 * draws. See that hook for why there must be exactly one cursor.
 */

export function ResearchRunPanel({
  run,
  events,
  busy,
  notice,
  post,
  className,
  disconnected,
  failed,
  reload,
  fetchedAt,
  runId: requestedRunId,
}: {
  run: ResearchRunView | null;
  events: ResearchEventDTO[];
  busy: boolean;
  notice: string | null;
  post: (path: string, body: Record<string, unknown>) => Promise<boolean>;
  className?: string;
  disconnected?: boolean;
  failed?: boolean;
  reload?: () => Promise<unknown>;
  fetchedAt?: number | null;
  runId?: string | null;
}) {
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const [reportOpen, setReportOpen] = React.useState(false);
  const reportModel = useReportModel(run);

  const runId = run?.id ?? null;
  React.useEffect(() => {
    setReportOpen(false);
  }, [runId]);

  if (!run) {
    if (!requestedRunId) return null;
    const trouble = failed || disconnected;
    return <section className={cn("rf", className)} aria-label={FEATURE_NAMES.research.accessibleLabel} aria-busy={!trouble || undefined}>
      <p className="rf-annot flex items-center gap-2">
        <span className="shrink-0 whitespace-nowrap text-foreground">{FEATURE_NAMES.research.label}</span>
        <span aria-hidden>·</span>
        {!trouble && <ThinkingMark phase="working" size={14} />}
        <span role={trouble ? "alert" : "status"} data-tone={trouble ? "attention" : undefined} className="rf-annot">
          {failed ? "Research unavailable" : disconnected ? "Could not reconnect to the research" : "Opening the research"}
        </span>
      </p>
      {trouble && reload && <Button variant="outline" size="sm" className="mt-3" onClick={() => void reload()}>Retry connection</Button>}
    </section>;
  }
  if (dismissed === run.id) return null;

  const state: ResearchState = isResearchState(run.state) ? run.state : "failed";
  const finished = isTerminalResearchState(state);
  const conflicts = (run.plan.conflicts ?? []).filter((conflict) => !conflict.resolved);
  const objectives = run.plan.objectives ?? [];

  if (!finished) {
    return (
      <ResearchConsole
        run={run}
        state={state}
        events={events}
        busy={busy}
        notice={notice}
        post={post}
        className={className}
        disconnected={disconnected}
        failed={failed}
        reload={reload}
        fetchedAt={fetchedAt}
      />
    );
  }

  return (
    <>
      <ResearchRecap
        run={run}
        className={className}
        onDismiss={() => setDismissed(run.id)}
        onOpenReport={run.report ? () => setReportOpen(true) : undefined}
        work={
          // The full machinery, one disclosure away. Ordered how an auditor
          // reads it: what was established, then what it rests on, then every
          // step that got there.
          <div className="space-y-6">
            {(objectives.length > 0 || conflicts.length > 0) && (
              <EvidencePanel
                objectives={objectives}
                coverage={run.plan.coverage ?? []}
                conflicts={conflicts}
                sources={run.sources}
              />
            )}
            <SourceDeck sources={run.sources} />
            <RunTimeline events={events} live={false} />
          </div>
        }
      />
      {run.report && (
        // The full-screen reader: contents, the text with a support mark on
        // every cited claim, the cited sources beside it, and export. Its
        // numbering follows the writer's citation order (`useReportModel`),
        // falling back to the READ corpus in store order, which is what the
        // writer was numbered against.
        <ReportFullscreen run={run} model={reportModel} open={reportOpen} onOpenChange={setReportOpen} />
      )}
    </>
  );
}

/** Older runs retain their position and report when another research starts. */
export function HistoricalResearchRunPanel({ runId }: { runId: string }) {
  const research = useResearchRun(runId);
  return <ResearchRunPanel {...research} runId={runId} className="mt-5" />;
}
