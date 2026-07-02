"use client";

import * as React from "react";
import { AlertCircle, Sparkles } from "lucide-react";
import { StepLabBlock } from "@/components/chat/step-lab-block";
import { LearningCardBlock } from "@/components/chat/learning/learning-card-block";
import { ProcessTimelineBlock } from "@/components/chat/learning/process-timeline-block";
import { ComparisonBlock } from "@/components/chat/learning/comparison-block";
import { InteractiveQuizBlock } from "@/components/chat/learning/quiz-block";
import { DeepDiveBlock } from "@/components/chat/learning/deep-dive-block";
import {
  LEARNING_BLOCK_LABELS,
  salvageLearningBlock,
  type ParsedLearningBlock,
} from "@/lib/learning-blocks";
import { cn } from "@/lib/utils";

/** Shimmering placeholder while a block's body is still streaming in. */
function BlockStreamingPlaceholder({ kind }: { kind: ParsedLearningBlock["kind"] }) {
  return (
    <div className="my-4 overflow-hidden rounded-[18px] border border-border/70 bg-card/80 shadow-pop motion-safe:animate-fade-in">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[14px] border border-primary/25 bg-primary/10">
          <Sparkles className="size-4 text-primary motion-safe:animate-pulse" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/80">
            {LEARNING_BLOCK_LABELS[kind]}
          </p>
          <p className="text-sm text-muted-foreground">Building the visual explanation...</p>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_0.7fr] gap-2 px-4 pb-4">
        <div className="skeleton h-16 rounded-[14px]" />
        <div className="skeleton h-16 rounded-[14px]" style={{ animationDelay: "120ms" }} />
      </div>
    </div>
  );
}

/** Graceful notice for blocks that could not be parsed at all. */
function BlockFallback({ kind, error }: { kind: ParsedLearningBlock["kind"]; error?: string }) {
  return (
    <div className="my-4 rounded-[18px] border border-warning/35 bg-warning/5 px-4 py-3.5 shadow-soft motion-safe:animate-fade-in">
      <div className="flex items-center gap-2 text-sm text-foreground/85">
        <AlertCircle className="size-4 shrink-0 text-warning" />
        <span>
          This {LEARNING_BLOCK_LABELS[kind].toLowerCase()} couldn&apos;t be rendered
          {error ? <span className="text-muted-foreground">. {error}</span> : "."}
        </span>
      </div>
    </div>
  );
}

/**
 * Renders one parsed inline learning block. `messageStreaming` lets a
 * trailing unclosed block stay a placeholder while tokens arrive, then be
 * salvage-parsed the moment the reply finishes.
 */
export const VisualLearningBlockRenderer = React.memo(function VisualLearningBlockRenderer({
  parsed,
  messageStreaming,
  className,
}: {
  parsed: ParsedLearningBlock;
  messageStreaming?: boolean;
  className?: string;
}) {
  const block = parsed.streaming && !messageStreaming ? salvageLearningBlock(parsed) : parsed;

  if (block.streaming) return <BlockStreamingPlaceholder kind={block.kind} />;
  if (!block.payload) return <BlockFallback kind={block.kind} error={block.error} />;

  const payload = block.payload;
  return (
    <div className={cn("juno-visual", className)}>
      {payload.kind === "step-lab" ? (
        <StepLabBlock lab={payload.lab} error={block.error} />
      ) : payload.kind === "learning-card" ? (
        <LearningCardBlock card={payload.card} />
      ) : payload.kind === "process-timeline" ? (
        <ProcessTimelineBlock timeline={payload.timeline} />
      ) : payload.kind === "comparison" ? (
        <ComparisonBlock comparison={payload.comparison} />
      ) : payload.kind === "quiz" ? (
        <InteractiveQuizBlock quiz={payload.quiz} />
      ) : (
        <DeepDiveBlock deepDive={payload.deepDive} />
      )}
    </div>
  );
});
