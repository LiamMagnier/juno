"use client";

import * as React from "react";
import { EvidencePanel } from "@/components/research/evidence-panel";
import { ReportDialog } from "@/components/research/report-dialog";
import { ResearchConsole } from "@/components/research/research-console";
import { ResearchRecap } from "@/components/research/research-recap";
import { RunTimeline } from "@/components/research/run-timeline";
import { SourceDeck } from "@/components/research/source-deck";
import { isResearchState, isTerminalResearchState, type ResearchEventDTO, type ResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "@/components/research/use-research-run";

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
}: {
  run: ResearchRunView | null;
  events: ResearchEventDTO[];
  busy: boolean;
  notice: string | null;
  post: (path: string, body: Record<string, unknown>) => Promise<boolean>;
  className?: string;
}) {
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const [reportOpen, setReportOpen] = React.useState(false);

  const runId = run?.id ?? null;
  React.useEffect(() => {
    setReportOpen(false);
  }, [runId]);

  if (!run || dismissed === run.id) return null;

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
        <ReportDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          report={run.report}
          sources={run.sources}
          goal={run.goal}
        />
      )}
    </>
  );
}
