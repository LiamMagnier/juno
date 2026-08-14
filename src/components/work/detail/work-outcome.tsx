"use client";

import * as React from "react";
import type { ClientWorkRun } from "@/lib/work/serializers";
import type { PerformedActions, PlanStep } from "@/components/work/work-timeline";
import { attemptDurationMs } from "@/components/work/detail/work-attempt-timing";
import { formatDuration, formatMicroUsd } from "@/components/work/work-vocabulary";

/*
 * A failed run, read back as a diagnosis.
 *
 * The page already states WHY a run ended — the terminal detail sits in a
 * warning note under the title, in the executor's own words. What it did not
 * state, anywhere, is the thing a person actually needs before deciding what to
 * do next: how far it got, and whether it left anything behind.
 *
 * That question has a real cost attached. "Try again" on a run that changed
 * nothing is free; the same button on a run that half-applied a batch of file
 * changes is a second attempt on top of a first one's mess, and the reader had
 * no way to tell those apart without reading the whole feed and knowing what to
 * look for.
 *
 * Nothing here is inferred and nothing is a guess at a cause. Every line is a
 * count of something already derived from the event stream for a panel further
 * down the rail, stated once, at the top, where the decision is being made. The
 * panels below remain the place to go for the detail — this is the summary that
 * says whether going there is necessary.
 */

export function WorkOutcomeDigest({
  run,
  plan,
  performed,
}: {
  run: ClientWorkRun;
  plan: readonly PlanStep[];
  performed: PerformedActions;
}) {
  const done = plan.filter((step) => step.state === "done").length;
  // The step it stopped on, which is more use than a fraction: "stopped at
  // Upload the summary" is a sentence somebody can act on, and "3 of 7" is not.
  const stopped = plan.find((step) => step.state === "active" || step.state === "failed") ?? null;
  const ran = attemptDurationMs(run);

  const lines: string[] = [];

  if (plan.length > 0) {
    lines.push(
      stopped === null
        ? `Finished ${done} of ${plan.length} planned steps.`
        : `Finished ${done} of ${plan.length} planned steps, and stopped on “${stopped.title}”.`
    );
  } else {
    // Not "it did nothing". A run can do a great deal without ever writing a
    // plan, and the feed below is where that work is.
    lines.push("No plan was written, so there are no steps to measure it against.");
  }

  if (performed.actions.length > 0) {
    lines.push(
      performed.actions.length === 1
        ? "One action changed something outside Juno. It is listed under Outputs."
        : `${performed.actions.length} actions changed something outside Juno. They are listed under Outputs.`
    );
  } else if (performed.unclassified > 0) {
    // The honest middle case, and the reason this is not a yes/no. A local
    // executor reports neither a risk level nor a mutating flag, so on a Mac run
    // this is every tool call the run made — and answering "nothing was changed"
    // on that evidence is the most expensive way to be wrong on this page.
    lines.push(
      `${performed.unclassified} ${performed.unclassified === 1 ? "action" : "actions"} ran without saying whether anything was changed, so whether this left a mark is not recorded.`
    );
  } else {
    lines.push("Nothing was recorded as changed, so starting it again is safe.");
  }

  if (ran !== null || run.usage.costMicroUsd > 0) {
    const spent =
      ran === null
        ? `Spent ${formatMicroUsd(run.usage.costMicroUsd)}.`
        : run.usage.costMicroUsd > 0
          ? `Ran for ${formatDuration(ran)} and spent ${formatMicroUsd(run.usage.costMicroUsd)}.`
          : `Ran for ${formatDuration(ran)}.`;
    lines.push(spent);
  }

  return (
    <ul className="space-y-1.5">
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-2 text-ui leading-relaxed">
          <span
            className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70"
            aria-hidden="true"
          />
          <span className="min-w-0 text-foreground">{line}</span>
        </li>
      ))}
    </ul>
  );
}
