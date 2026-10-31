"use client";

import * as React from "react";
import Link from "next/link";
import { AlertCircle, Check } from "@/components/ui/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { ClientAgentGoal } from "@/lib/agents/types";
import { GOAL_UNVERIFIED, GOAL_UNVERIFIED_LINE } from "@/lib/agents/goals";
import { workSessionPath } from "@/lib/notify/paths";

/**
 * One goal on an agent's profile: the objective, its milestones as a quiet
 * checklist, what happens next, and what is stopping it.
 *
 * No progress bar and no status pill (the owner's design rules): progress is
 * the milestones themselves, "2 of 4", and a blocker is attention-coloured
 * text with an icon. The one action is a text button whose words say what it
 * does: "Keep working on it" turns driving on, "Continue" answers a blocker.
 *
 * A goal whose every step ran without its criteria being shown met
 * (`unverified`, src/lib/agents/goals.ts `planGoalCompletion`) says so in the
 * attention colour, links each step to the task that did it, and offers the
 * two honest ways on: "Mark it met" and "Keep working".
 */
export function AgentGoalRow({
  goal,
  busy,
  onAchieved,
  onAdvance,
}: {
  goal: ClientAgentGoal;
  busy: boolean;
  onAchieved: () => void;
  onAdvance: () => void;
}) {
  const milestones = goal.milestones ?? [];
  const done = milestones.filter((m) => m.done).length;
  const unverified = goal.status === GOAL_UNVERIFIED;
  const blocker = unverified ? null : (goal.blockers?.[0] ?? null);
  const driven = (goal.maxRuns ?? 0) > 0;
  const action = unverified ? "Keep working" : blocker ? "Continue" : !driven && goal.status === "active" ? "Keep working on it" : null;
  const meta = [
    milestones.length ? `${done} of ${milestones.length} done` : null,
    driven && goal.status === "active" && goal.runsUsed ? `${goal.runsUsed} of ${goal.maxRuns} runs` : null,
  ].filter(Boolean);

  return (
    <li className="flex items-start gap-3" data-goal-row={goal.id}>
      <Checkbox
        id={`goal-${goal.id}`}
        disabled={busy}
        onCheckedChange={onAchieved}
        aria-label={`Mark “${goal.title}” achieved`}
        className="mt-1"
      />
      <div className="min-w-0 flex-1">
        <label htmlFor={`goal-${goal.id}`} className="block cursor-pointer text-body text-foreground">
          {goal.title}
          {meta.length ? <span className="ml-2 font-mono text-caption text-muted-foreground">{meta.join(" · ")}</span> : null}
        </label>
        {milestones.length > 0 ? (
          <ol className="mt-1.5 space-y-0.5" aria-label="Milestones">
            {milestones.map((m) => (
              <li key={m.id} className={cn("flex items-center gap-1.5 text-ui", m.done ? "text-muted-foreground" : "text-foreground")}>
                <span className="inline-flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                  {m.done ? <Check className="size-3.5" /> : <span className="block h-px w-2 bg-border" />}
                </span>
                {unverified && m.sessionId ? (
                  // What each step produced, one press away: the result to check.
                  <Link
                    href={workSessionPath(m.sessionId)}
                    className="underline decoration-border underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:decoration-foreground"
                  >
                    {m.title}
                  </Link>
                ) : (
                  <span className={cn(m.done && "line-through decoration-border")}>{m.title}</span>
                )}
                <span className="sr-only">{m.done ? "(done)" : "(to do)"}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {unverified ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-ui text-[hsl(var(--attention))]" data-goal-unverified>
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{goal.nextAction ?? GOAL_UNVERIFIED_LINE}</span>
          </p>
        ) : blocker ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-ui text-[hsl(var(--attention))]">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{blocker.text}</span>
          </p>
        ) : goal.nextAction ? (
          <p className="mt-1 text-ui text-muted-foreground">{goal.nextAction}</p>
        ) : goal.lastCheckInNote ? (
          <p className="mt-0.5 text-ui text-muted-foreground">{goal.lastCheckInNote}</p>
        ) : null}
        {unverified ? (
          <span className="mt-1 flex items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={onAchieved}
              className="relative text-ui text-foreground underline-offset-4 hit-44 hover:underline disabled:opacity-50"
            >
              Mark it met
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onAdvance}
              className="relative text-ui text-muted-foreground underline-offset-4 hit-44 hover:text-foreground hover:underline disabled:opacity-50"
            >
              {action}
            </button>
          </span>
        ) : action ? (
          <button
            type="button"
            disabled={busy}
            onClick={onAdvance}
            className="relative mt-1 text-ui text-muted-foreground underline-offset-4 hit-44 hover:text-foreground hover:underline disabled:opacity-50"
          >
            {action}
          </button>
        ) : null}
      </div>
    </li>
  );
}
