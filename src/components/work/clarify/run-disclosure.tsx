"use client";

import * as React from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  WORK_APPROVAL_MODE_SUMMARY,
  type WorkEffectiveTarget,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import type { Plan } from "@prisma/client";
import { runBudgetForPlan } from "@/lib/work/budget";
import { confirmPlanBeforeActing } from "@/lib/work/plan-review";
import { useApp } from "@/components/app/app-provider";
import { cn } from "@/lib/utils";

/*
 * "What this run commits to" — one line under the composer, and one chevron.
 *
 * A Work run is the one thing in Juno that spends real money while nobody is
 * looking, so the composer has to say where the task will run, how often it
 * will stop to ask, and what will stop it. It used to say those things as a
 * stack: an executor strip, a sentence about the approval mode, this
 * disclosure, an inference line and a run line — up to five blocks of caption
 * under one input, every one of them honest and the total reading like a terms
 * sheet. Cowork is a prompt, a folder, connectors, go.
 *
 * So: ONE line that carries all three facts — "Runs in the cloud · asks before
 * risky steps · stops at $2 / 20 min" — and a single disclosure under it for
 * the reader who wants the detail, where what Juno read into the goal and what
 * it will do about it now live as well. Collapsed by default, and that is not
 * timidity: the summary already carries the whole of it in one sentence, and a
 * permanently expanded block of metadata over a composer is the sort of thing
 * readers learn to look past.
 *
 * Nothing here is computed. `selectForInferred` in the composer already decided
 * the target, the [+] already holds the connector selection, the chip holds the
 * mode, and the ceilings are `runBudgetForPlan`. Recomputing any of them would
 * produce a second answer that could disagree with the one the dispatch acts
 * on.
 */

export interface RunCeilings {
  costUsd: number;
  tokens: number;
  minutes: number;
}

/**
 * The run budget, restated for the reader in the units a person thinks in.
 *
 * Derived from `runBudgetForPlan` rather than mirrored: this used to be a
 * hand-copied constant with a comment asking whoever moved the original to
 * come and move this too, and no test guarding it. Read from the source, the
 * sentence cannot be wrong about the number.
 *
 * It takes the plan because the ceiling does. A flat sentence was honest while
 * every account got the same $2; now that a trial account's run stops at
 * fifteen cents and ten minutes, a composer telling every reader "$2 / 20 min"
 * would be describing a run only some of them will get — and the reader most
 * misled by it is the one whose run stops soonest.
 */
export function runCeilingsFor(plan: Plan): RunCeilings {
  const budget = runBudgetForPlan(plan);
  return {
    costUsd: budget.maxCostMicroUsd / 1_000_000,
    tokens: budget.maxTokens,
    minutes: Math.round(budget.maxRuntimeMs / 60_000),
  };
}

/**
 * The figures a surface states when it has not been told whose account it is.
 *
 * PRO's, matching `DEFAULT_RUN_BUDGET` for the reason that constant still
 * exists: every surface written before ceilings were plan-shaped was written
 * against these numbers, and a fallback that guessed lower would understate a
 * paying reader's run. Anything with the plan in hand calls `runCeilingsFor`.
 */
export const RUN_CEILINGS: RunCeilings = runCeilingsFor("PRO");

/**
 * The approval mode as the tail of a sentence.
 *
 * `WORK_APPROVAL_MODE_LABEL` is the imperative the chip wears — "Ask before
 * risky steps" — and this is the same phrase conjugated for "Runs in the cloud
 * · …". Kept beside it in spirit rather than derived by string surgery, because
 * "Just do it" does not conjugate by lowercasing.
 */
const APPROVAL_PHRASE: Record<WorkPermissionPolicy, string> = {
  conservative: "asks before every change",
  balanced: "asks before risky steps",
  permissive: "just does it",
};

/**
 * Where this task will run, in the reader's words.
 *
 * One function, read by the summary line and by the voice briefing, because
 * the composer names the executor in two places and the two must not be able to
 * disagree.
 */
export function runTargetLabel(
  target: WorkEffectiveTarget,
  hostName: string | null
): string {
  return target === "cloud" ? "Juno’s cloud" : (hostName ?? "your Mac");
}

interface RunDisclosureProps {
  /** Where `selectForInferred` says this will run. Null while that is unknown. */
  target: WorkEffectiveTarget | null;
  /** The Mac's own name, when it is going to a Mac. */
  hostName: string | null;
  /** The host list is still in flight. */
  loading: boolean;
  /** The host list could not be read at all. */
  unknown: boolean;
  /** The apps switched on for this task, in the words the reader chose them by. */
  connectorLabels: readonly string[];
  /** How often this task will stop to ask. */
  approvalMode: WorkPermissionPolicy;
  /** What Juno read into the goal, when it read anything. */
  inferenceLine: string | null;
  /** What the executor decision will do about it, when there is one to state. */
  runLine: string | null;
}

export function WorkRunDisclosure({
  target,
  hostName,
  loading,
  unknown,
  connectorLabels,
  approvalMode,
  inferenceLine,
  runLine,
}: RunDisclosureProps) {
  const [open, setOpen] = React.useState(false);
  /*
   * The reader's own plan, not a constant. `useApp` is where every other leaf
   * in this app reads it (see `task-dialog.tsx`), and reading it here rather
   * than taking it as a prop means the composer cannot forget to pass it and
   * quietly fall back to somebody else's figures.
   */
  const { quota } = useApp();
  const ceilings = runCeilingsFor(quota.plan);
  /*
   * Stated because the runtime does it, and read from the same rule the
   * dispatcher passes to the executor. A sentence here that the run did not
   * honour would be worse than saying nothing: the reader would wait for a plan
   * that never arrives. A composer press is attended by definition.
   *
   * Cloud only, and the asymmetry is real rather than cautious. The cloud
   * executor is `scripts/work-runner.ts`, which is the one place in this
   * repository that builds a `WorkSessionOptions` and therefore the one place
   * `confirmPlan` can be set. A Mac runs its own bundled agent, driven by a
   * start command that carries the approval mode and not this, so promising the
   * gate to somebody dispatching to their laptop would promise them a pause
   * that never comes.
   */
  const confirmsPlan =
    target === "cloud" && confirmPlanBeforeActing({ policy: approvalMode, attended: true });

  const stops = `stops at $${ceilings.costUsd} / ${ceilings.minutes} min`;
  const asks = APPROVAL_PHRASE[approvalMode];
  /*
   * Every state of the summary is a real sentence. "Checking…" while the host
   * list is in flight, because claiming the cloud and correcting it two hundred
   * milliseconds later is the one line here nobody can check; "can't tell
   * where" when that request failed, because Juno not knowing and nothing
   * being available are different facts. The notes under the composer carry
   * the explanation for the last case; this line only has to not lie.
   */
  const summary = loading
    ? `Checking where this will run · ${asks} · ${stops}`
    : unknown
      ? `Can’t tell where this will run · ${asks} · ${stops}`
      : target === null
        ? `Nothing can run this as written · ${asks} · ${stops}`
        : `Runs on ${runTargetLabel(target, hostName)} · ${asks} · ${stops}`;

  const reaches =
    connectorLabels.length === 0
      ? "no connected apps"
      : connectorLabels.length <= 2
        ? connectorLabels.join(" and ")
        : `${connectorLabels.slice(0, -1).join(", ")} and ${connectorLabels[connectorLabels.length - 1]}`;

  return (
    <div className="mt-2.5 px-1.5">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 rounded-control py-0.5 text-left text-caption leading-relaxed text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        {loading && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
        {/* Announced when it settles or when the mode changes: the chip says
            only the mode's name, and a reader moving between the three with a
            screen reader would otherwise hear three words and no meaning. */}
        <span
          aria-live="polite"
          className={cn(
            "min-w-0 flex-1 truncate",
            target === null && !loading && !unknown && "text-warning-foreground"
          )}
        >
          {summary}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform duration-base ease-in-out motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>

      {/* Grid-rows rather than height, the same collapse the attachment strip
          above uses, so the reveal is animatable without measuring anything. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <dl className="mt-2 space-y-2 border-l border-border/60 pl-3">
            {!loading && !unknown && target !== null && (
              <Row label="Runs on">
                {target === "cloud"
                  ? "Juno’s cloud. Nothing on your Mac is read or touched."
                  : `${hostName ?? "Your Mac"}. It has to stay awake for the task to finish.`}
              </Row>
            )}
            {inferenceLine !== null && <Row label="Read into it">{inferenceLine}</Row>}
            {runLine !== null && <Row label="So">{runLine}</Row>}
            <Row label="Reaches">
              {connectorLabels.length === 0
                ? "No connected apps. It works from the task, its project and any files attached to it."
                : `${reaches}. Every other app you have connected stays out of reach.`}
            </Row>
            <Row label="Asks">
              {WORK_APPROVAL_MODE_SUMMARY[approvalMode]} Anything it cannot take back — a permanent
              delete, a message sent, a purchase — is asked about under every mode.
              {confirmsPlan
                ? " It also writes its plan before it starts and waits for you to read it; the clock does not run while it waits."
                : ""}
            </Row>
            <Row label="Stops at">
              {`$${ceilings.costUsd}, ${ceilings.tokens.toLocaleString("en-US")} tokens, or ${ceilings.minutes} minutes of working time — whichever comes first. If one is reached the task stops and tells you where it got to; waiting for you does not count against the clock. These are your plan’s ceilings; a project, a skill or a schedule can lower them and nothing raises them.`}
            </Row>
          </dl>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {/* `text-label` supplies the 0.10em the config names as the editorial
          maximum for caps, plus the weight. */}
      <dt className="font-mono text-label text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-caption leading-relaxed text-muted-foreground">{children}</dd>
    </div>
  );
}
