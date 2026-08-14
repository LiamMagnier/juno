import {
  RESEARCH_STAGE_LABEL,
  isBlockedResearchState,
  isWorkingResearchState,
  stageForState,
  type ResearchState,
} from "@/lib/research/domain";

/**
 * How a research run's numbers and status are said, everywhere they are said.
 *
 * The chat panel, the /research library and the report reader all describe the
 * same row, and each had started growing its own dollar formatter and its own
 * idea of what "partially_completed" looks like as a badge. Three surfaces
 * disagreeing about whether a run "Stopped early" or "Failed" is not a style
 * drift — it changes what the user believes happened to their money.
 */

/** Micro-USD as display dollars. `<$0.01` rather than `$0.00` for a nonzero spend — a run that cost something must never claim it was free. */
export function formatMicroUsd(microUsd: string): string {
  const usd = Number(microUsd) / 1_000_000;
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** Wall-clock span of a run, or null while it is still going. */
export function runDuration(createdAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Whether a partially completed run stopped because the money ran out.
 *
 * BigInt, not Number: both columns are micro-USD BigInts serialised as strings,
 * and comparing them as floats would misreport the one case this check exists
 * for — a spend that landed exactly on the ceiling.
 */
export function budgetRanOut(costMicroUsd: string, budgetMicroUsd: string | null): boolean {
  if (budgetMicroUsd === null) return false;
  try {
    return BigInt(costMicroUsd) >= BigInt(budgetMicroUsd);
  } catch {
    return false;
  }
}

export interface RunBadge {
  label: string;
  /** Border + fill + ink, drawn from the semantic ramps only. */
  tone: string;
  dot: string;
  /** True only while a driver is actually spending — the pulse means "working", not "alive". */
  pulse: boolean;
}

/**
 * One badge per state, grouped by what the state MEANS to the person reading
 * the list: working (primary), waiting on you (warning), finished (success),
 * stopped early (warning — the material is still worth having), failed
 * (destructive), and paused/cancelled (muted). Working states borrow the stage
 * label rather than the state message: "Finding sources" fits a badge,
 * "Opening the most promising results" does not.
 */
export function runBadge(state: ResearchState): RunBadge {
  if (isWorkingResearchState(state) || state === "accepted") {
    return {
      label: state === "accepted" ? "Starting" : RESEARCH_STAGE_LABEL[stageForState(state)],
      tone: "border-primary/25 bg-primary/10 text-primary",
      dot: "bg-primary",
      pulse: true,
    };
  }
  if (isBlockedResearchState(state)) {
    if (state === "paused") {
      return {
        label: "Paused",
        tone: "border-border bg-muted text-muted-foreground",
        dot: "bg-muted-foreground/50",
        pulse: false,
      };
    }
    return {
      label: state === "awaiting_plan_confirmation" ? "Review the plan" : "Waiting for you",
      tone: "border-warning/35 bg-warning/10 text-warning-foreground",
      dot: "bg-warning",
      pulse: false,
    };
  }
  switch (state) {
    case "completed":
      return { label: "Finished", tone: "border-success/30 bg-success/10 text-success-ink", dot: "bg-success", pulse: false };
    case "partially_completed":
      return { label: "Stopped early", tone: "border-warning/35 bg-warning/10 text-warning-foreground", dot: "bg-warning", pulse: false };
    case "failed":
      return { label: "Failed", tone: "border-destructive/30 bg-destructive/10 text-destructive-ink", dot: "bg-destructive", pulse: false };
    default:
      return { label: "Cancelled", tone: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground/50", pulse: false };
  }
}
