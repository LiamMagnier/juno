"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Brain, ChevronDown, ExternalLink, Globe } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StreamingMarkdown } from "@/components/chat/stream-text";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { CompareModelPicker } from "@/components/compare/compare-model-picker";
import { ProjectCover } from "@/components/projects/project-cover";
import "@/components/projects/projects.css";
import { isPaneStreaming, type PaneRun } from "@/components/compare/use-compare";
import { isAutoModelId } from "@/lib/auto-model";
import { monotonicNow, timeToFirstOutputMs } from "@/lib/compare/pane-run";
import { formatCost, formatSeconds, type CompareReportPane } from "@/lib/compare/report";
import { compareEffortLabel, effortDisplay, plannedEffort, type CompareSettings } from "@/lib/compare/run-spec";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
import { cn, formatTokens } from "@/lib/utils";

/** Live race clock — ticks while the pane streams, freezes at the final time. */
function ElapsedTime({ startedAt, elapsedMs, running }: { startedAt: number | null; elapsedMs: number | null; running: boolean }) {
  // The same monotonic clock the controller stamps `startedAt` with.
  const [now, setNow] = React.useState(() => monotonicNow());
  React.useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(monotonicNow()), 100);
    return () => window.clearInterval(id);
  }, [running]);
  const ms = elapsedMs ?? (running && startedAt ? now - startedAt : null);
  if (ms == null) return null;
  return <span className="tabular-nums">{(ms / 1000).toFixed(1)}s</span>;
}

/** The same calm phase/detail hierarchy used by the main transcript. */
function PaneStreamStatus({ writing }: { writing: boolean }) {
  const startRef = React.useRef(Date.now());
  const [elapsedSec, setElapsedSec] = React.useState(0);
  React.useEffect(() => {
    if (writing) return;
    startRef.current = Date.now();
    setElapsedSec(0);
    const timer = window.setInterval(
      () => setElapsedSec(Math.floor((Date.now() - startRef.current) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [writing]);

  // The same ladder as the chat reply's status line (message-item.tsx), so a
  // pane and a thread say the same thing at the same point in a wait.
  let statusCopy = "Thinking";
  if (writing) statusCopy = "Writing";
  else if (elapsedSec >= 600) statusCopy = "Still working. You can leave; the answer will be here.";
  else if (elapsedSec >= 120) statusCopy = "Still thinking. This can take a few minutes.";

  return (
    <div role="status" className="flex min-h-10 items-center gap-3 py-1.5 motion-safe:animate-fade-in">
      <GalaxyMark phase={writing ? "working" : "thinking"} size={20} className="text-muted-foreground" />
      {/* Plain muted text beside the galaxy — the galaxy is the one moving thing
          in this row, exactly as message-item.tsx renders the same row. The
          sentence breathed as well (status-glow, 2.8s) beside a 1.8s mark:
          two loops that share no phase for 25 seconds, and Compare shows the
          row once per pane, so a screen meant to say "still working" read as
          four unrelated events. */}
      <span key={statusCopy} className="min-w-0 truncate text-body-lg leading-6 text-muted-foreground">
        {statusCopy}
        {!writing && elapsedSec > 0 && (
          <span className="whitespace-nowrap tabular-nums">
            {" "}
            · {elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`}
          </span>
        )}
      </span>
    </div>
  );
}

/** A condition chip in the pane header: quiet when as asked, warning-toned when not. */
function ConditionChip({
  icon: Icon,
  label,
  tip,
  tone = "muted",
  struck = false,
}: {
  icon: typeof Brain;
  label: string;
  tip: string;
  tone?: "muted" | "warning";
  struck?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-control px-1.5 font-mono text-caption tabular-nums transition-colors duration-fast motion-safe:animate-fade-in",
            tone === "warning" ? "bg-warning/10 text-warning-foreground" : "text-muted-foreground"
          )}
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className={cn("truncate", struck && "line-through decoration-1")}>{label}</span>
          <span className="sr-only">. {tip}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * What this pane runs with: the thinking effort and, when asked for, web
 * search. After a run these are what the SERVER reported applying; before
 * one (or from an older server) they are the plan, worked out with the
 * server's own rules (the plan's default effort, then the model's clamp),
 * and the tip says it is a plan.
 */
function PaneConditions({
  model,
  run,
  requested,
  plan,
}: {
  model: ModelInfo | undefined;
  run: PaneRun;
  requested: CompareSettings;
  plan?: string | null;
}) {
  const effectiveModel = run.servedModelId ? (resolveModel(run.servedModelId) ?? model) : model;
  const reported = run.appliedEffort !== undefined;
  const planned = plannedEffort(model, requested.reasoningEffort, { plan });
  let effort: React.ReactNode = null;
  if (model) {
    const effortValue = reported ? (run.appliedEffort ?? null) : (planned?.effort ?? null);
    const label = planned?.auto && !reported ? "Auto" : effortDisplay(effectiveModel, effortValue);
    const honoured = reported
      ? requested.reasoningEffort === null || run.appliedEffort === requested.reasoningEffort
      : (planned?.honoured ?? true);
    const source = reported
      ? "Reported by the server for this run."
      : planned?.planDefault
        ? "Planned from your plan’s default for this model."
        : "Planned from the model’s settings.";
    const tip = planned?.auto && !reported
      ? "Auto chooses the effort for each prompt."
      : !model.reasoning
        ? "This model has no thinking control."
        : honoured
          ? `Thinking effort: ${label}. ${source}`
          : `${compareEffortLabel(requested.reasoningEffort)} was asked for, but this model can’t take it, so it ${reported ? "ran" : "runs"} at ${label}, its default. ${source}`;
    effort = <ConditionChip icon={Brain} label={label} tip={tip} tone={honoured ? "muted" : "warning"} />;
  }

  let search: React.ReactNode = null;
  if (requested.webSearch || run.webSearchApplied) {
    const can = run.webSearchApplied ?? (model ? model.webSearch !== false : true);
    search = can ? (
      <ConditionChip
        icon={Globe}
        label="Search"
        tip={run.webSearchApplied ? "Web search was offered to this model on this run." : "This model will be offered web search."}
      />
    ) : (
      <ConditionChip
        icon={Globe}
        label="Search"
        struck
        tone="warning"
        tip="Web search was asked for, but this model can’t search here, so it answers from what it knows."
      />
    );
  }

  if (!effort && !search) return null;
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {effort}
      {search}
    </div>
  );
}

/** The answer came from another model than the pane asked for (or Auto chose one). */
function ServedModelNotice({ requestedId, servedId }: { requestedId: ModelId; servedId: string | null }) {
  if (!servedId || servedId === requestedId) return null;
  const served = resolveModel(servedId)?.name ?? servedId;
  if (isAutoModelId(requestedId)) {
    return <p className="ed-annot mb-2">Auto picked {served}</p>;
  }
  const requested = resolveModel(requestedId)?.name ?? requestedId;
  return (
    <p className="mb-3 flex items-start gap-1.5 rounded-field border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-warning-foreground">
      <StatusIcons.warning aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Answered by {served}. The server couldn’t use {requested} for this request.
      </span>
    </p>
  );
}

/**
 * The receipt: first output · total time · tokens · cost. Times are
 * measured here; tokens and cost carry "~" whenever the provider's usage
 * report was incomplete, and the tip says which is which.
 */
function PaneReceipt({ run, streaming }: { run: PaneRun; streaming: boolean }) {
  const firstOutput = timeToFirstOutputMs(run);
  const hasUsage = run.promptTokens != null || run.completionTokens != null;
  const approx = run.usageBasis === "reported" ? "" : "~";
  const tokens = (run.promptTokens ?? 0) + (run.completionTokens ?? 0);
  const tip = [
    firstOutput != null ? `First output after ${formatSeconds(firstOutput)}` : null,
    run.elapsedMs != null ? `Finished after ${formatSeconds(run.elapsedMs)}` : null,
    firstOutput != null || run.elapsedMs != null ? "Times are measured in this browser and include the network." : null,
    hasUsage
      ? `${(run.promptTokens ?? 0).toLocaleString()} in · ${(run.completionTokens ?? 0).toLocaleString()} out tokens, ${run.usageBasis === "reported" ? "as the provider reported them" : "partly estimated from text length"}.`
      : null,
    run.costUsd != null
      ? run.usageBasis === "reported"
        ? `${formatCost(run.costUsd, "reported")}, priced from that usage at list rates.`
        : `${formatCost(run.costUsd, "estimated")} is an estimate.`
      : null,
  ].filter(Boolean);

  const line = (
    <p className="min-w-0 truncate font-mono text-caption text-muted-foreground">
      {firstOutput != null && (
        <>
          <span>first</span> <span className="tabular-nums">{formatSeconds(firstOutput)}</span>
          {" · "}
        </>
      )}
      <ElapsedTime startedAt={run.startedAt} elapsedMs={run.elapsedMs} running={streaming} />
      {hasUsage && (
        <>
          {" · "}
          <span className="tabular-nums">
            {approx}
            {formatTokens(tokens)}
          </span>{" "}
          tokens
        </>
      )}
      {run.costUsd != null && (
        <>
          {" · "}
          <span className="tabular-nums">{formatCost(run.costUsd, run.usageBasis)}</span>
          {run.usageBasis !== "reported" && <span> est.</span>}
        </>
      )}
      {tip.length > 0 && <span className="sr-only">. {tip.join(" ")}</span>}
    </p>
  );
  if (tip.length === 0) return line;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{line}</TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-0.5">
        {tip.map((row) => (
          <p key={row}>{row}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/** The pages this answer rests on, with the ones other models share marked. */
function PaneSources({ citations }: { citations: CompareReportPane["citations"] }) {
  if (citations.total === 0) return null;
  return (
    <details className="group/sources mt-4 border-t border-border/60 pt-2 motion-safe:animate-fade-in">
      <summary className="pressable flex cursor-pointer list-none items-center gap-1.5 rounded-control px-1 py-1 text-caption text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Globe aria-hidden="true" className="size-3.5" />
        <span>
          {citations.total} {citations.total === 1 ? "source" : "sources"}
          {citations.shared > 0 && <> · {citations.shared} shared</>}
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none group-open/sources:rotate-180" />
      </summary>
      <ul className="mt-1 space-y-0.5">
        {citations.refs.map((ref) => (
          <li key={ref.url}>
            <a
              href={ref.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group/link flex min-w-0 items-center gap-2 rounded-control px-1 py-1 text-ui hover:bg-accent"
            >
              <span className="shrink-0 font-mono text-caption text-muted-foreground">{ref.host}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{ref.title || ref.url}</span>
              {ref.inText && <span className="shrink-0 font-mono text-caption text-muted-foreground">in text</span>}
              {ref.sharedWith.length > 0 && (
                <span
                  className="shrink-0 rounded-control bg-primary/10 px-1.5 font-mono text-caption text-primary"
                  title={`Also cited by ${ref.sharedWith.join(" and ")}`}
                >
                  shared
                </span>
              )}
              <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/link:opacity-100 coarse:opacity-100" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ComparePane({
  modelId,
  run,
  requested,
  plan,
  citations,
  onChangeModel,
  onRemove,
  onRetry,
  onContinue,
}: {
  modelId: ModelId;
  run: PaneRun;
  /** The conditions this pane ran with (its comparison's spec), or will run with next. */
  requested: CompareSettings;
  /** The account's plan, for the server's plan default effort in the pre-run plan. */
  plan?: string | null;
  /** This pane's sources compared with the others'; absent before a run. */
  citations?: CompareReportPane["citations"];
  onChangeModel: (id: ModelId) => void;
  /** Present only while removal is allowed (more than two panes). */
  onRemove?: () => void;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const router = useRouter();
  const model = resolveModel(modelId);
  const streaming = isPaneStreaming(run);
  const finishNote =
    run.finishReason === "length"
      ? "Stopped at its token limit."
      : run.finishReason === "user_stopped" && run.status === "done"
        ? "Stopped by user."
        : null;

  return (
    // bg-card, not bg-card/30: at 30% alpha over the true-black ground the pane
    // composited to ~1.5% lightness and stopped being a surface, leaving the
    // divide-x hairline as the only thing separating three streaming answers.
    // Fades in as it mounts, so a third model joining the race arrives
    // rather than appearing in one frame.
    <section className="group/pane flex min-h-64 min-w-0 flex-col bg-card motion-safe:animate-fade-in md:min-h-0 md:h-full">
      {/* Pane header: the picker IS the change button. */}
      <header className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <CompareModelPicker value={modelId} onChange={onChangeModel} disabled={streaming} />
        <PaneConditions model={model ?? undefined} run={run} requested={requested} plan={plan} />
        <div className="ml-auto flex items-center gap-1">
          {onRemove && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onRemove}
                  aria-label={`Remove ${model?.name ?? "this model"} from the comparison`}
                  // A 32px target on the control rung (it was a 26px box at an
                  // off-ladder 8px). Revealed with the pane's hover, and with
                  // focus anywhere inside the pane, so a keyboard user reaching
                  // the picker can see it is there. `.pressable` times the
                  // reveal, the tonal hover and the dip together.
                  className="pressable grid size-8 place-items-center rounded-control text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-focus-within/pane:opacity-100 group-hover/pane:opacity-100 motion-reduce:active:scale-100 coarse:size-10 coarse:opacity-100"
                >
                  <ActionIcons.dismiss className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Remove model</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      {/* Answer — independent scroll on desktop; natural height when stacked. */}
      <div className="min-h-0 flex-1 md:overflow-y-auto">
        {run.status === "idle" ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center px-6 py-8 text-center">
            {/* Each model wears its own drawing, the deterministic dot-matrix
                vignette a project's cover is (project-cover.tsx), keyed to the
                model's id: same prompt, a different construction per mind.
                Then its name in the serif and its one line, so an idle pane
                reads as the contender rather than as a caption floating in
                an empty column. */}
            <div className="relative aspect-[16/7] w-full max-w-[18rem]">
              <ProjectCover key={modelId} id={`compare:${modelId}`} folders={2} aspect={16 / 7} />
            </div>
            <p className="mt-4 font-serif text-title text-foreground">
              {model?.name ?? "Choose a model"}
            </p>
            {/* No alpha: /60 over black landed at ~3.3:1, and this is the only copy
                in an idle pane — the first thing anyone reads on /compare. */}
            <p className="mt-1.5 max-w-[34ch] text-pretty text-ui leading-relaxed text-muted-foreground">
              {model?.description ?? "Pick a model to put in the race."}
            </p>
          </div>
        ) : run.status === "error" && !run.content ? (
          <div className="px-4 py-4">
            {/* rounded-field, not rounded-lg (=16px surface): this is an inline note
                inside a pane, not a panel. /10 matches every other tinted state chip —
                /5 all but vanished on the black ground. */}
            <div className="space-y-2.5 rounded-field border border-destructive/40 bg-destructive/10 px-3.5 py-3 text-ui text-destructive">
              <p>{run.errorMessage}</p>
              {run.errorAction === "upgrade" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push("/upgrade")}
                  className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {/* A forward arrow, trailing: /upgrade is a page in Juno.
                      The up-right arrow is reserved for what LEAVES Juno. */}
                  See plans <ArrowRight aria-hidden="true" className="size-3.5" />
                </Button>
              ) : run.errorAction === "retry" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetry}
                  className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <ActionIcons.refresh aria-hidden="true" className="size-3.5" /> Try again
                </Button>
              ) : null}
            </div>
          </div>
        ) : streaming && !run.content ? (
          <div className="px-4 py-4">
            <PaneStreamStatus writing={run.status === "writing"} />
          </div>
        ) : (
          <div className="px-4 py-4">
            <ServedModelNotice requestedId={modelId} servedId={run.servedModelId} />
            <StreamingMarkdown content={run.content} streaming={streaming} className="text-body" />
            {(finishNote || (run.status === "error" && run.content)) && (
              <div
                // bg-secondary, not bg-muted/45: 45% of a 9.5% token over the pane's
                // own 6.5% card composites to ~7.9% — a point and a third of lift,
                // which is not a step anyone sees. The named rung above card is what
                // makes this read as a note laid ON the answer.
                className="mt-2 flex flex-wrap items-center gap-2 rounded-field border border-border/70 bg-secondary px-3 py-2 text-caption text-muted-foreground"
              >
                <span className="min-w-0 flex-1">{run.errorMessage ?? finishNote}</span>
              </div>
            )}
            {!streaming && citations && <PaneSources citations={citations} />}
          </div>
        )}
      </div>

      {/* Footer: the receipt (first output · time · tokens · cost, each with its
          basis), then the handoff. */}
      <footer
        className={cn(
          "flex h-9 shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 transition-opacity duration-base ease-out-soft coarse:h-11",
          run.status === "idle" && "opacity-0"
        )}
      >
        <PaneReceipt run={run} streaming={streaming} />
        {run.status === "done" && run.content && (
          <button
            type="button"
            onClick={onContinue}
            // `ArrowRight`, not the leaves-Juno arrow: this carries the answer
            // into a chat here, and the arrow nudges the way it goes.
            // `animate-fade-in` ungated: it is opacity only, and reduced
            // motion keeps fades on their timing (§2.2, rule 10).
            className="pressable inline-flex shrink-0 items-center gap-1.5 rounded-control px-1.5 py-1 font-mono text-caption text-muted-foreground animate-fade-in hover:bg-accent hover:text-foreground motion-reduce:active:scale-100"
          >
            Continue in chat <ArrowRight aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </footer>
    </section>
  );
}
