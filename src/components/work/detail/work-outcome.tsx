"use client";

import * as React from "react";
import type { ClientWorkRun } from "@/lib/work/serializers";
import type { PerformedActions, PlanStep } from "@/components/work/work-timeline";
import { attemptDurationMs } from "@/components/work/detail/work-attempt-timing";
import { formatDuration, formatMicroUsd } from "@/components/work/work-vocabulary";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * A run that did not finish cleanly, read back as a diagnosis, in the task
 * card (work-run-panel.tsx `TerminalRun`).
 *
 * The card already states WHY a run ended — the terminal detail sits above
 * this, in the executor's own words. What this adds is the thing a person
 * needs before choosing between the card's Continue and Retry: how far it got,
 * and whether it left anything behind.
 *
 * That choice has a real cost attached. Retry on a run that changed nothing is
 * free; the same press on a run that half-applied a batch of file changes is a
 * second attempt on top of a first one's mess, which is what Continue (a new
 * attempt told where the last one stopped) is for.
 *
 * Nothing here is inferred and nothing is a guess at a cause. Every line is a
 * count of something already derived from the event stream, stated once,
 * where the decision is being made; the card's Details fold holds the rest.
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
        ? `One action changed something outside ${PRODUCT_NAME}. It is listed under Outputs.`
        : `${performed.actions.length} actions changed something outside ${PRODUCT_NAME}. They are listed under Outputs.`
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
            className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/70"
            aria-hidden="true"
          />
          <span className="min-w-0 text-foreground">{line}</span>
        </li>
      ))}
    </ul>
  );
}
