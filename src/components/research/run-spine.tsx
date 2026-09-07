"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { RESEARCH_STATE_MESSAGE, stageForState, type ResearchStage, type ResearchState } from "@/lib/research/domain";

export type StageYield = Partial<Record<ResearchStage, string | null>>;
const STAGES = [
  { id: "plan", label: "Plan" }, { id: "investigate", label: "Investigate" },
  { id: "review", label: "Review" }, { id: "write", label: "Write" },
] as const;

/** State is factual. Elapsed time never masquerades as percentage completion. */
export function RunSpine({ state, live, detail, yields, className }: {
  state: ResearchState; live: boolean; detail?: string | null; yields?: StageYield; className?: string;
}) {
  const stage = stageForState(state);
  const at = stage === "done" ? STAGES.length : STAGES.findIndex(item => item.id === stage);
  const stopped = !live && state !== "completed";
  return <div className={className}>
    <ol className="grid grid-cols-4" aria-label="Research stages">
      {STAGES.map((item, index) => <li key={item.id} aria-current={index === at ? "step" : undefined} className="relative min-w-0">
        {index < 3 && <span aria-hidden className={cn("absolute left-3 right-0 top-2 h-px", index < at && !stopped ? "bg-primary/50" : "bg-border")} />}
        <span aria-hidden className={cn("relative flex size-4 items-center justify-center rounded-full border bg-background", index < at && !stopped ? "border-primary bg-primary text-primary-foreground" : index === at ? "border-primary bg-primary" : "border-border")}>
          {index < at && !stopped && <Check className="size-3" />}
        </span>
        <span className={cn("mt-3 block text-caption sm:text-ui", index === at ? "font-medium text-primary" : "text-muted-foreground")}>{item.label}</span>
        {yields?.[item.id] && <span className="mt-1 hidden text-caption text-muted-foreground sm:block">{yields[item.id]}</span>}
      </li>)}
    </ol>
    <p role="status" className="mt-5 text-ui text-muted-foreground">{RESEARCH_STATE_MESSAGE[state]}{detail && live && state !== "paused" ? <span className="mt-1 block truncate text-caption">{detail}</span> : null}</p>
  </div>;
}
