"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, Download, Loader2, MessageCircle, Telescope, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppPageHeader } from "@/components/app/app-page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { auditHeadline } from "@/components/chat/citation-audit";
import { ReportReader } from "@/components/research/report-reader";
import { PlanReview, SteerControls } from "@/components/research/run-controls";
import { budgetRanOut, formatMicroUsd, runDuration } from "@/components/research/run-format";
import { RunStateBadge } from "@/components/research/run-state-badge";
import { LiveSourceList } from "@/components/research/source-list";
import { StageRail } from "@/components/research/stage-rail";
import { useResearchRun } from "@/components/research/use-research-run";
import {
  RESEARCH_STATE_MESSAGE,
  isResearchState,
  type ResearchState,
} from "@/lib/research/domain";
import { truncate } from "@/lib/utils";

/**
 * One research run, read as a document.
 *
 * The chat panel is the run seen from its conversation; this is the run given
 * the surface a report deserves — full measure, a table of contents, the
 * source corpus alongside — plus the honest accounting a paid, long-running
 * job owes its owner: what it cost, how long it took, what stopped it if
 * something did, and how its citations held up under checking. Every state a
 * run can be in renders here, because a link to this page may be followed at
 * any moment of the run's life.
 */

function reportFileName(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "research-report"}.md`;
}

export default function ResearchRunPage() {
  const { id } = useParams<{ id: string }>();
  const { run, failed, busy, notice, post } = useResearchRun(id ?? null);
  const [copied, setCopied] = React.useState(false);

  const copyReport = async () => {
    if (!run?.report) return;
    try {
      await navigator.clipboard.writeText(run.report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast.error("The report could not be copied.");
    }
  };

  const downloadReport = () => {
    if (!run?.report) return;
    const blob = new Blob([run.report], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = reportFileName(run.goal);
    a.click();
    URL.revokeObjectURL(url);
  };

  if (failed) {
    return (
      <div className="app-page-scroll">
        <main className="app-page-content max-w-3xl">
          <AppPageHeader eyebrow="Research" heading="Not found" backHref="/research" backLabel="Back to research" />
          <EmptyState
            tone="error"
            icon={TriangleAlert}
            title="This research run could not be found"
            description="It may belong to another account, or the link is stale."
            action={
              <Button variant="outline" size="sm" asChild>
                <Link href="/research">All research</Link>
              </Button>
            }
          />
        </main>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="app-page-scroll">
        <main className="app-page-content max-w-6xl" aria-label="Loading research run">
          {/* The shape of the reader it stands in for: header block, then a
              contents rail beside a page of prose lines. */}
          <div className="mb-6 border-b border-border pb-5">
            <span className="skeleton block h-3 w-24 rounded-sm" />
            <span className="skeleton mt-4 block h-8 w-2/3 rounded-sm" />
            <span className="skeleton mt-3 block h-3 w-40 rounded-sm" />
          </div>
          <div className="flex gap-8">
            <div className="hidden w-44 shrink-0 space-y-2 lg:block">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="skeleton block h-3 rounded-sm" style={{ width: `${88 - i * 12}%` }} />
              ))}
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <span key={i} className="skeleton block h-4 rounded-sm" style={{ width: i % 3 === 2 ? "72%" : "100%" }} />
              ))}
            </div>
          </div>
        </main>
      </div>
    );
  }

  const state: ResearchState = isResearchState(run.state) ? run.state : "failed";
  const awaitingPlan = state === "awaiting_plan_confirmation";
  const paused = state === "paused";
  const duration = run.createdAt ? runDuration(run.createdAt, run.finishedAt ?? null) : null;
  const hasReport = !!run.report;
  const outOfBudget = budgetRanOut(run.costMicroUsd, run.budgetMicroUsd);
  const auditTrouble = run.auditSummary
    ? run.auditSummary.contradicted + run.auditSummary.unsupported > 0
    : false;

  const meta = (
    <span className="font-mono text-caption tabular-nums">
      {run.createdAt ? `Started ${new Date(run.createdAt).toLocaleDateString()} · ` : ""}
      {duration ? `${duration} · ` : ""}
      {formatMicroUsd(run.costMicroUsd)}
      {run.budgetMicroUsd ? ` of ${formatMicroUsd(run.budgetMicroUsd)} budget` : ""}
      {" · "}
      {run.sources.length} {run.sources.length === 1 ? "source" : "sources"}
    </span>
  );

  return (
    <div className="app-page-scroll">
      <main className="app-page-content max-w-6xl">
        <AppPageHeader
          eyebrow="Research"
          heading={truncate(run.goal, 160)}
          backHref="/research"
          backLabel="Back to research"
          lede={meta}
          actions={
            <>
              <RunStateBadge state={state} />
              {hasReport && (
                <>
                  <Button variant="outline" size="sm" onClick={() => void copyReport()} className="gap-1.5">
                    {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadReport} className="gap-1.5">
                    <Download className="size-3.5" aria-hidden />
                    .md
                  </Button>
                </>
              )}
              {run.conversationId && (
                <Button variant="ghost" size="sm" asChild className="gap-1.5 text-muted-foreground">
                  <Link href={`/chat/${run.conversationId}`}>
                    <MessageCircle className="size-3.5" aria-hidden />
                    Conversation
                  </Link>
                </Button>
              )}
            </>
          }
        />

        {/* What stopped the run, said before the report is read — a reader who
            finds out at the last paragraph that the run ran out of money has
            been reading a complete-looking document under false pretences. */}
        {state === "partially_completed" && (
          <div className="mb-6 rounded-field border border-warning/35 bg-warning/10 p-3 text-sm text-warning-foreground" role="status">
            {outOfBudget
              ? `The budget ran out at ${formatMicroUsd(run.costMicroUsd)}. Everything below covers what was gathered before it stopped.`
              : "This run was stopped before it finished. Everything below covers what had been gathered by then."}
          </div>
        )}
        {state === "failed" && (
          <div className="mb-6 rounded-field border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive-ink" role="status">
            {run.error ?? "This run stopped after an error."} It spent {formatMicroUsd(run.costMicroUsd)}
            {run.sources.length > 0
              ? ` and kept the ${run.sources.length} ${run.sources.length === 1 ? "source" : "sources"} it had found.`
              : " before anything was gathered."}
          </div>
        )}
        {state === "cancelled" && (
          <div className="mb-6 rounded-field border border-border/60 bg-muted p-3 text-sm text-muted-foreground" role="status">
            This run was cancelled. It spent {formatMicroUsd(run.costMicroUsd)}
            {run.sources.length > 0 ? ` — the ${run.sources.length} sources it found are kept below.` : "."}
          </div>
        )}

        {/* The citation check, or its honest absence. The full claim-by-claim
            audit lives under the answer in the conversation; this strip is the
            same numbers, phrased by the same function. */}
        {hasReport && run.auditSummary && (
          <p className="mb-6 flex items-center gap-2 font-mono text-label text-muted-foreground" role="status">
            <span aria-hidden className={auditTrouble ? "size-2 shrink-0 rounded-full bg-warning" : "size-2 shrink-0 rounded-full bg-success"} />
            {auditHeadline(run.auditSummary)}
            {run.conversationId && (
              <Link
                href={`/chat/${run.conversationId}`}
                className="underline underline-offset-4 transition-colors duration-fast hover:text-foreground"
              >
                See every claim
              </Link>
            )}
          </p>
        )}
        {hasReport && !run.auditSummary && !run.live && (
          <p className="mb-6 font-mono text-label text-muted-foreground" role="status">
            The citations in this report have not been checked.
          </p>
        )}

        {notice && (
          <p role="status" className="mb-4 text-xs text-destructive">
            {notice}
          </p>
        )}

        {awaitingPlan ? (
          <section aria-label="Research plan review" className="rounded-card border border-border/60 bg-card p-4 sm:p-5">
            <p className="text-sm font-medium text-foreground">
              Juno drafted a plan and stopped — the next step is where the money goes.
            </p>
            <div className="mt-3">
              <PlanReview
                queries={run.plan.queries}
                busy={busy}
                onConfirm={(queries) => void post("/plan", { decision: "confirm", queries })}
                onDiscard={() => void post("/plan", { decision: "cancel" })}
              />
            </div>
          </section>
        ) : run.live ? (
          <section aria-label="Research progress" className="rounded-card border border-border/60 bg-card p-4 sm:p-5">
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" />
              </span>
              <div className="min-w-0 flex-1">
                <p aria-live="polite" className="text-sm font-medium text-foreground">
                  {RESEARCH_STATE_MESSAGE[state]}
                </p>
                <p className="mt-0.5 font-mono text-caption tabular-nums text-muted-foreground">
                  {run.sources.length} {run.sources.length === 1 ? "source" : "sources"} ·{" "}
                  {formatMicroUsd(run.costMicroUsd)}
                  {run.budgetMicroUsd ? ` of ${formatMicroUsd(run.budgetMicroUsd)}` : ""}
                </p>
              </div>
            </div>
            <StageRail state={state} live className="mt-4" />
            {run.error && (
              <p role="status" className="mt-3 text-xs text-destructive">
                {run.error}
              </p>
            )}
            <LiveSourceList sources={run.sources} className="mt-4" />
            <div className="mt-4 border-t border-border/50 pt-4">
              <SteerControls
                constraints={run.plan.constraints}
                paused={paused}
                busy={busy}
                onSteer={(body) => post("/steer", body)}
                onControl={(action) => void post("/control", { action })}
              />
            </div>
          </section>
        ) : hasReport ? (
          <ReportReader report={run.report ?? ""} sources={run.sources} />
        ) : (
          <>
            <EmptyState
              icon={Telescope}
              title="No report was written"
              description={
                run.sources.length > 0
                  ? "The run stopped before synthesis. The sources it gathered are kept below."
                  : "The run stopped before it gathered anything."
              }
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link href="/research">All research</Link>
                </Button>
              }
            />
            {run.sources.length > 0 && <LiveSourceList sources={run.sources} limit={50} className="mt-6" />}
          </>
        )}
      </main>
    </div>
  );
}
