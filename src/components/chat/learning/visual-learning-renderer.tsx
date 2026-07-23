"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";
import { ThinkingDots } from "@/components/signature/thinking-dots";
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

/** Quiet rule-bounded placeholder while a block's body is still streaming in.
 *  ThinkingDots is the one sanctioned loop here — streaming is genuinely live. */
function BlockStreamingPlaceholder({ kind }: { kind: ParsedLearningBlock["kind"] }) {
  return (
    <div className="my-6 flex items-center gap-3 border-y border-border/60 py-5 motion-safe:animate-fade-in">
      <ThinkingDots className="shrink-0" />
      <p className="font-mono text-[11px] font-semibold text-muted-foreground">
        Building {LEARNING_BLOCK_LABELS[kind]}
      </p>
    </div>
  );
}

/** Graceful notice for blocks that could not be parsed at all. */
function BlockFallback({ kind, error }: { kind: ParsedLearningBlock["kind"]; error?: string }) {
  return (
    <div className="my-6 border-y border-border/60 py-4 motion-safe:animate-fade-in">
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
