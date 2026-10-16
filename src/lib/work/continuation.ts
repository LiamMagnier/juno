/**
 * What a finished task's card offers next, and the brief a "Continue" carries.
 *
 * The finished card used to diagnose and stop: a failed, interrupted or
 * cancelled task had no Retry, a paused one could not be resumed on the web,
 * and a run that got halfway had no way to pick up from there. These are the
 * decisions behind the card's buttons, kept pure so they are tested without a
 * browser:
 *
 *   - `finishedTaskActions`: which of Retry, Run again, Continue and Make a
 *     routine a finished task offers, from how it ended;
 *   - `liveTaskControls`: Pause or Resume while it is going;
 *   - `continuationBrief` (client) and `continuationInstruction` (server): what
 *     a Continue tells the new attempt about the last one.
 *
 * A CONTINUE IS A NEW ATTEMPT WITH A BRIEF, NOT A RESTORE. The old attempt's
 * checkpoint is bound to its own run id and its own budget counters
 * (scripts/work-runner.ts `persistedCheckpoint`), and restoring a model loop
 * into a different run would be the replay the runner refuses to invent. So
 * the new attempt starts from the task's goal, as a Retry does, and is told —
 * as an instruction in its own log, the same channel steering uses — what the
 * last attempt finished, what it left behind and why it stopped, so it picks
 * up rather than repeats.
 */

import type { WorkStatus, WorkTerminalReason } from "@/lib/work/domain";

export type FinishedTaskAction = "retry" | "run_again" | "continue" | "make_routine";

/** The step shape the card already derives (work-timeline.tsx `PlanStep`). */
export interface ContinuationStep {
  title: string;
  state: string;
}

const RESUMABLE: ReadonlySet<string> = new Set(["failed", "interrupted", "timed_out", "budget_exceeded", "host_offline"]);

/**
 * What a finished task offers, most useful first.
 *
 *   completed            → Run again, Make a routine
 *   failed / interrupted /
 *   timed out / budget /
 *   Mac offline          → Continue (when it got somewhere), Retry
 *   cancelled            → Retry
 *
 * Continue needs a step done or something produced: with nothing to pick up
 * from it is a Retry with a longer brief. Make a routine only follows a run
 * that worked, the moment somebody decides it is worth doing again.
 */
export function finishedTaskActions(input: {
  status: WorkStatus;
  terminalReason: WorkTerminalReason | null;
  /** Steps done, or files left behind: something a new attempt can build on. */
  progressed: boolean;
  /** The task belongs to a routine already (its runs come from a schedule). */
  fromRoutine: boolean;
}): FinishedTaskAction[] {
  if (input.status === "completed") return input.fromRoutine ? ["run_again"] : ["run_again", "make_routine"];
  const reason = input.terminalReason ?? (input.status === "cancelled" ? "cancelled" : "failed");
  if (reason === "cancelled" || reason === "superseded") return ["retry"];
  if (RESUMABLE.has(reason)) return input.progressed ? ["continue", "retry"] : ["retry"];
  return ["retry"];
}

export type LiveTaskControl = "pause" | "resume" | null;

/**
 * Pause while it works; Resume when a person paused it. A run parked because
 * it asked something is also `paused`, but resuming it would only have it ask
 * again: what it needs is the answer, which the card already asks for.
 */
export function liveTaskControl(input: {
  status: WorkStatus;
  /** An open question or approval is waiting on the person. */
  waitingOnPerson: boolean;
}): LiveTaskControl {
  if (input.status === "paused") return input.waitingOnPerson ? null : "resume";
  if (input.status === "running" || input.status === "preparing") return "pause";
  return null;
}

const MAX_BRIEF_CHARS = 3_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The card's account of the last attempt, built from what it already shows:
 * the plan's done and unfinished steps, the files it left, the sentence it
 * ended with. Plain text, bounded, in the person's own client.
 */
export function continuationBrief(input: {
  plan: readonly ContinuationStep[];
  files: readonly string[];
  terminalDetail: string | null;
}): string {
  const done = input.plan.filter((step) => step.state === "done").map((step) => step.title);
  const open = input.plan
    .filter((step) => step.state !== "done" && step.state !== "skipped")
    .map((step) => step.title);
  const lines: string[] = [];
  if (done.length > 0) lines.push(`Finished: ${done.join("; ")}.`);
  if (open.length > 0) lines.push(`Not finished: ${open.join("; ")}.`);
  if (input.files.length > 0) lines.push(`Files it left: ${input.files.slice(0, 12).join(", ")}.`);
  if (input.terminalDetail) lines.push(`Why it stopped: ${input.terminalDetail.replace(/\s+/g, " ").trim()}`);
  return clip(lines.join("\n"), MAX_BRIEF_CHARS);
}

/** The instruction a Continue appends to the new attempt's log. Server-side. */
export function continuationInstruction(brief: string): string {
  const body = clip(brief.trim(), MAX_BRIEF_CHARS);
  return [
    "Continue the previous attempt at this task instead of starting over.",
    body ? `Where it stopped:\n${body}` : "",
    "Pick up from the first unfinished step and build on what it already produced. Do not repeat anything it already did that has an effect outside this task, such as sending a message or changing a file.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Whether a run can be continued from: it ended, and not as a success or a person's cancel. */
export function canContinueFrom(run: { status: string; terminalReason: string | null }): boolean {
  return run.terminalReason !== null && RESUMABLE.has(run.terminalReason) && run.status !== "completed";
}
