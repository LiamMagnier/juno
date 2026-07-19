"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "@/components/chat/markdown";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { CompareModelPicker } from "@/components/compare/compare-model-picker";
import { isPaneStreaming, type PaneRun } from "@/components/compare/use-compare";
import { resolveModel, type ModelId } from "@/lib/models";
import { cn, formatTokens, formatUsd } from "@/lib/utils";

/** Live race clock — ticks while the pane streams, freezes at the final time. */
function ElapsedTime({ startedAt, elapsedMs, running }: { startedAt: number | null; elapsedMs: number | null; running: boolean }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
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

  let statusCopy = "Thinking about your request";
  if (writing) statusCopy = "Writing the response";
  else if (elapsedSec >= 600) statusCopy = "Still thinking deeply — safe to leave; the answer will be here when you return";
  else if (elapsedSec >= 120) statusCopy = "Still thinking — working in the background";

  return (
    <div role="status" className="flex min-h-10 items-center gap-3 py-1.5 motion-safe:animate-fade-in">
      <ThinkingDots className="text-muted-foreground/65" />
      <span key={statusCopy} className="min-w-0 truncate text-body-lg leading-6 text-muted-foreground/85 motion-safe:animate-status-glow">
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

export function ComparePane({
  modelId,
  run,
  onChangeModel,
  onRemove,
  onRetry,
  onContinue,
}: {
  modelId: ModelId;
  run: PaneRun;
  onChangeModel: (id: ModelId) => void;
  /** Present only while removal is allowed (more than two panes). */
  onRemove?: () => void;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const router = useRouter();
  const model = resolveModel(modelId);
  const streaming = isPaneStreaming(run);
  const hasUsage = run.promptTokens != null || run.completionTokens != null;
  const finishNote =
    run.finishReason === "length"
      ? "Stopped at its token limit."
      : run.finishReason === "user_stopped" && run.status === "done"
        ? "Stopped by user."
        : null;

  return (
    <section className="group/pane flex min-h-64 min-w-0 flex-col bg-card/30 md:min-h-0 md:h-full">
      {/* Pane header: the picker IS the change button. */}
      <header className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <CompareModelPicker value={modelId} onChange={onChangeModel} disabled={streaming} />
        <div className="ml-auto flex items-center gap-1">
          {onRemove && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onRemove}
                  aria-label={`Remove ${model?.name ?? "this model"} from the comparison`}
                  className="rounded-md p-1.5 text-muted-foreground/70 opacity-0 transition-all duration-fast ease-out-soft hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/pane:opacity-100 coarse:p-2.5 coarse:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
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
          <div className="flex h-full min-h-40 items-center justify-center px-6 py-8">
            <p className="max-w-[32ch] text-center text-caption leading-relaxed text-muted-foreground/60">
              {model?.description ?? "Pick a model to put in the race."}
            </p>
          </div>
        ) : run.status === "error" && !run.content ? (
          <div className="px-4 py-4">
            <div className="space-y-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-sm text-destructive">
              <p>{run.errorMessage}</p>
              {run.errorAction === "upgrade" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push("/upgrade")}
                  className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" /> See plans
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetry}
                  className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Try again
                </Button>
              )}
            </div>
          </div>
        ) : streaming && !run.content ? (
          <div className="px-4 py-4">
            <PaneStreamStatus writing={run.status === "writing"} />
          </div>
        ) : (
          <div className="px-4 py-4">
            <Markdown content={run.content} streaming={streaming} className="text-body" />
            {streaming && run.content.length > 0 && (
              <span
                className="ml-1 inline-block h-2 w-2 translate-y-[1px] rounded-full bg-primary align-middle motion-safe:animate-pulse"
                aria-hidden="true"
              />
            )}
            {(finishNote || (run.status === "error" && run.content)) && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/45 px-3 py-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1">{run.errorMessage ?? finishNote}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer: the receipt — time · tokens · real cost, then the handoff. */}
      <footer
        className={cn(
          "flex h-9 shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 transition-opacity duration-base ease-out-soft coarse:h-11",
          run.status === "idle" && "opacity-0"
        )}
      >
        <p className="min-w-0 truncate font-mono text-caption text-muted-foreground/70">
          <ElapsedTime startedAt={run.startedAt} elapsedMs={run.elapsedMs} running={streaming} />
          {hasUsage && (
            <> · {formatTokens((run.promptTokens ?? 0) + (run.completionTokens ?? 0))} tokens</>
          )}
          {run.costUsd != null && <> · ~{formatUsd(run.costUsd)}</>}
        </p>
        {run.status === "done" && run.content && (
          <button
            type="button"
            onClick={onContinue}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-caption uppercase tracking-[0.08em] text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground"
          >
            Continue in chat <ArrowUpRight className="h-3 w-3" />
          </button>
        )}
      </footer>
    </section>
  );
}
