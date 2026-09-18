"use client";

import * as React from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  WORK_APPROVAL_MODE_SUMMARY,
  type WorkEffectiveTarget,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import { bindingWindow } from "@/lib/spend-ceiling";
import type { ClientSpend } from "@/types/app";
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
 * risky steps · runs until your 5-hour limit is used up" — and a single
 * disclosure under it for the reader who wants the detail, where what Juno read
 * into the goal and what it will do about it now live as well. Collapsed by
 * default, and that is not timidity: the summary already carries the whole of
 * it in one sentence, and a permanently expanded block of metadata over a
 * composer is the sort of thing readers learn to look past.
 *
 * Nothing here is computed. `selectForInferred` in the composer already decided
 * the target, the [+] already holds the connector selection, the chip holds the
 * mode, and the limit is the account's own rolling window, read from the same
 * bootstrap the settings gauge draws. Recomputing any of them would produce a
 * second answer that could disagree with the one the dispatch acts on.
 */

/** Which window will stop a run first, and when it frees up. */
export interface RunLimit {
  window: "session" | "weekly";
  /** Epoch ms when that window frees up; null when there is no window. */
  resetsAtMs: number | null;
  /** Spend enforcement is switched off, so no window applies to this account. */
  unmetered: boolean;
}

/**
 * What will stop this run, read from the account's own windows.
 *
 * There is no per-run ceiling any more. This used to be `runCeilingsFor`, which
 * restated `runBudgetForPlan` in the units a person thinks in — "$2, 600,000
 * tokens or 20 minutes" — and the composer printed it under the field. Every
 * one of those numbers is gone: a run goes until the work is done or until the
 * account's rolling window is used up, and that is the sentence the reader now
 * needs. A line promising a ceiling the runtime no longer applies is the same
 * defect as a control that implies something the runtime cannot do; it is just
 * quieter.
 *
 * The binding window is whichever has the least room LEFT, and it is derived by
 * `bindingWindow` — the same call `windowVerdict` makes, so there is one
 * derivation rather than two. It used to compare percentages here while the
 * gate compared absolute remainders, and the weekly budget is many times the
 * session budget, so the two disagreed routinely: at 90% of the session window
 * and 95% of the weekly one, percentage says weekly and the remainder says
 * session. The composer then read out the weekly reset, a day or more away,
 * over a run the five-hour cell was about to stop — a surface naming a limit
 * that is not the one the runtime applies, which is the defect this whole
 * package exists to remove.
 *
 * `unmetered` is the account with `Settings.spendCapDisabled`. It has no window
 * at all, and "0% of your 5-hour limit" would be a meter describing something
 * nothing is measuring. What such a run actually gets is the finite backstop in
 * `spend-ceiling.ts`; what the reader is told is that their limits are off.
 */
export function runLimitFrom(spend: ClientSpend): RunLimit {
  if (spend.capDisabled) {
    return { window: "session", resetsAtMs: null, unmetered: true };
  }
  const binding = bindingWindow({
    session: spend.windows.session,
    weekly: spend.windows.weekly,
  });
  // A metered account with no window at all is not a state the bootstrap can
  // produce — a budget it can enforce is what makes it metered — but the type
  // allows it, and inventing a window here would be the invention this function
  // exists to stop.
  if (binding == null) {
    return { window: "session", resetsAtMs: null, unmetered: true };
  }
  return { window: binding.name, resetsAtMs: binding.resetsAtMs, unmetered: false };
}

/** The limit as the tail of the one-line summary. */
export function runStopsPhrase(limit: RunLimit): string {
  if (limit.unmetered) return "runs until it is done";
  return limit.window === "session"
    ? "runs until your 5-hour limit is used up"
    : "runs until your weekly limit is used up";
}

/**
 * When the binding window frees up, in the reader's own time zone.
 *
 * A moment and not a countdown: this sentence sits under a composer and is read
 * once, and a countdown painted into a static line is a number that is wrong
 * the instant it is drawn. The settings gauge, which a reader watches rather
 * than glances at, counts down.
 */
export function runLimitResetLabel(limit: RunLimit): string | null {
  if (limit.resetsAtMs == null) return null;
  return new Date(limit.resetsAtMs).toLocaleString(undefined, {
    ...(limit.window === "weekly" ? { weekday: "long" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

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
 * The same phrase, for the armed pill in the chat composer.
 *
 * Exported rather than copied because the pill sits directly above this
 * disclosure — "Task · asks before risky steps" over "Runs on Juno's cloud ·
 * asks before risky steps" — and two spellings of one mode, eight pixels apart,
 * is the kind of drift a reader reads as two different settings.
 */
export function runApprovalPhrase(policy: WorkPermissionPolicy): string {
  return APPROVAL_PHRASE[policy];
}

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
   * The reader's own windows, not a constant. `useApp` is where every other
   * leaf in this app reads the account's spend (see `task-dialog.tsx`), and
   * reading it here rather than taking it as a prop means the composer cannot
   * forget to pass it and quietly fall back to somebody else's figures.
   */
  const { spend } = useApp();
  const limit = runLimitFrom(spend);
  const resetsAt = runLimitResetLabel(limit);
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

  const stops = runStopsPhrase(limit);
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
                ? " It also writes its plan before it starts and waits for you to read it; waiting costs nothing."
                : ""}
            </Row>
            <Row label="Stops at">
              {limit.unmetered
                ? "Nothing but the work being done. Spending limits are switched off on this account, so there is no window to run out of — a task Juno starts on its own still stops at a small backstop ceiling so an unattended loop cannot run all night."
                : limit.window === "session"
                  ? `Nothing, until the work is done or your 5-hour usage limit is used up${resetsAt ? ` — it frees up at ${resetsAt}` : ""}. If the limit is reached the task stops and tells you where it got to. There is no separate ceiling on how long it runs or how many tokens it uses, and waiting for you costs nothing. A project, a skill or a schedule can still set this task a smaller limit of its own; nothing can raise it.`
                  : `Nothing, until the work is done or your weekly usage limit is used up${resetsAt ? ` — it frees up ${resetsAt}` : ""}. If the limit is reached the task stops and tells you where it got to. There is no separate ceiling on how long it runs or how many tokens it uses, and waiting for you costs nothing. A project, a skill or a schedule can still set this task a smaller limit of its own; nothing can raise it.`}
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
