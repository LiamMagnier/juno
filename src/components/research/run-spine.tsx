"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { stageForState, type ResearchStage, type ResearchState } from "@/lib/research/domain";

export type StageYield = Partial<Record<ResearchStage, string | null>>;
const STAGES = [
  { id: "plan", label: "Plan" }, { id: "investigate", label: "Investigate" },
  { id: "review", label: "Review" }, { id: "write", label: "Write" },
] as const;

/**
 * The four acts and where the run is in them. State is factual: elapsed time
 * never masquerades as percentage completion.
 *
 * The rail is ONLY the rail. It used to close with its own `role="status"`
 * paragraph repeating the state sentence the console header already carries,
 * so one card printed the same sentence twice and announced every change
 * twice to a screen reader. The console owns the sentence; this owns the
 * stages.
 *
 * The per-stage yields ("14 queries", "18 found · 7 read") are gated on the
 * CONTAINER, not the window: the card sits in the transcript column, whose
 * width is set by the sidebar and the shell, and a `sm:` rule there hid the
 * yields on a wide column in a narrow window and showed them on a narrow
 * column in a wide one (PREMIUM_AUDIT rule 11).
 */
export function RunSpine({ state, live, yields, className }: {
  state: ResearchState; live: boolean; yields?: StageYield; className?: string;
}) {
  const stage = stageForState(state);
  const at = stage === "done" ? STAGES.length : STAGES.findIndex(item => item.id === stage);
  const stopped = !live && state !== "completed";
  return <ol className={cn("grid grid-cols-4", className)} aria-label="Research stages">
    {STAGES.map((item, index) => <li key={item.id} aria-current={index === at ? "step" : undefined} className="relative min-w-0">
      {index < 3 && <span aria-hidden className={cn("absolute left-3 right-0 top-2 h-px", index < at && !stopped ? "bg-primary/50" : "bg-border")} />}
      <span aria-hidden className={cn("relative flex size-4 items-center justify-center rounded-full border bg-background", index < at && !stopped ? "border-primary bg-primary text-primary-foreground" : index === at ? "border-primary bg-primary" : "border-border")}>
        {index < at && !stopped && <Check className="size-3" />}
      </span>
      <span className={cn("mt-3 block text-ui", index === at ? "font-medium text-primary" : "text-muted-foreground")}>{item.label}</span>
      {yields?.[item.id] && <span className="mt-1 hidden text-caption text-muted-foreground @sm:block">{yields[item.id]}</span>}
    </li>)}
  </ol>;
}
