"use client";

import type { ClientWorkHost } from "@/lib/work/serializers";
import { describeTrigger } from "@/components/work/work-triggers";
import type { WorkTriggerDraft } from "@/components/work/work-transport";

/*
 * What you are about to arm, read back to you.
 *
 * WHY A SUMMARY OVER A FORM YOU CAN ALREADY SEE. This is the single most
 * consequential Save in Work: everything else on this surface happens because
 * somebody pressed a button and watched, and this one sets something running at
 * four in the morning while they are asleep. The form above it answers the
 * question field by field — a trigger card here, a radio column there, a
 * timezone in between — and nobody assembles those into a sentence in their
 * head. So the sentence is assembled for them, immediately above the button,
 * and it is built from the DRAFT rather than written by hand, which is what
 * makes it impossible for it to describe a schedule other than the one that is
 * about to be saved.
 *
 * FOUR QUESTIONS, ALWAYS THE SAME FOUR, ALWAYS IN THIS ORDER.
 *
 *   When       — the triggers, in the words the trigger editor itself uses.
 *   Runs on    — cloud, a named Mac, or wherever it fits.
 *   What it does — the instructions, verbatim and untruncated.
 *   Unattended  — the one that matters and the one a form buries: what happens
 *                 when it meets something it cannot undo and nobody is there.
 *
 * The last is why the card exists at all. `unattendedPolicy` defaults to
 * `pause_for_approval` — draft-and-approve, the safe default — and a person who
 * has changed it to `skip_irreversible` deserves to be told, in a sentence, on
 * the screen where they press Save, that they have just told Juno to carry on
 * without them.
 *
 * IT IS NOT A CONFIRMATION STEP. No second dialog, no "are you sure". A modal
 * between a form and its own Save button is a click people learn to dismiss, and
 * the one it trains them past is the one that mattered. This is a summary that
 * is always visible, which nobody learns to skip because there is nothing to
 * skip.
 */

export function ScheduleArmingCard({
  triggers,
  runKind,
  code,
  target,
  hostId,
  hosts,
  timezone,
  instructions,
  unattendedPolicy,
  hostOfflinePolicy,
  enabled,
}: {
  triggers: readonly WorkTriggerDraft[];
  /** What one fire produces, which changes two of the four rows below. */
  runKind: "work" | "code";
  /** The repository and mode, for a Code routine. Null while the repository
   *  typed is not one yet, which the row then says rather than guessing. */
  code: { repo: { owner: string; name: string } | null; baseRef: string; permissionMode: string };
  target: "cloud" | "local" | "automatic";
  hostId: string | null;
  hosts: readonly ClientWorkHost[] | null;
  timezone: string;
  instructions: string;
  unattendedPolicy: string;
  hostOfflinePolicy: string;
  enabled: boolean;
}) {
  const active = triggers.filter((trigger) => trigger.enabled);
  const when =
    active.length === 0
      ? "Nothing will start it — every trigger is switched off."
      : active.map((trigger) => describeTrigger(trigger)).join(" · ");

  return (
    <section
      className="rounded-surface border border-border bg-card px-4 py-3.5"
      aria-labelledby="arming-card-heading"
    >
      <h2 id="arming-card-heading" className="font-mono text-label text-muted-foreground">
        {enabled ? "What you are switching on" : "What you are saving"}
      </h2>
      {!enabled && (
        <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
          This is saved paused. Nothing runs until you switch it on.
        </p>
      )}
      <dl className="mt-2.5 space-y-2.5">
        <Row label="When">
          {when}
          {active.length > 0 && timezone.trim().length > 0 && (
            <span className="text-muted-foreground"> · times are {timezone.trim()}</span>
          )}
        </Row>
        <Row label="Runs on">
          {runKind === "code" ? describeCodeTarget(code) : describeTarget(target, hostId, hosts)}
        </Row>
        <Row label="What it does">
          {instructions.trim().length === 0 ? (
            <span className="text-muted-foreground">Not written yet.</span>
          ) : (
            // `whitespace-pre-wrap` and no clamp. The instructions are what will
            // actually be handed to the agent, and a summary that truncated them
            // would hide the paragraph somebody is about to authorise running
            // unsupervised.
            <span className="whitespace-pre-wrap">{instructions.trim()}</span>
          )}
        </Row>
        <Row label="Unattended">
          {runKind === "code" ? (
            describeCodeUnattended(code.permissionMode)
          ) : (
            <>
              {describeUnattended(unattendedPolicy)}{" "}
              <span className="text-muted-foreground">
                {describeOffline(hostOfflinePolicy, target)}
              </span>
            </>
          )}
        </Row>
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-3">
      <dt className="font-mono text-micro text-muted-foreground sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 text-ui leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}

function describeTarget(
  target: "cloud" | "local" | "automatic",
  hostId: string | null,
  hosts: readonly ClientWorkHost[] | null
): string {
  if (target === "cloud") return "Juno's cloud. It cannot reach anything on your Macs.";
  const named = hostId === null ? null : (hosts ?? []).find((host) => host.id === hostId) ?? null;
  if (target === "local") {
    return named === null
      ? "One of your Macs — which one is not set yet."
      : `${named.displayName}, and only that Mac.`;
  }
  return named === null
    ? "Wherever it fits: a Mac when it needs one, the cloud otherwise."
    : `Wherever it fits, preferring ${named.displayName}.`;
}

/**
 * Where a Code routine's run happens, which is one sentence and a repository.
 *
 * The repository is the fact worth reading back. Every other part of a Code
 * run's destination is fixed — a cloud runner, a branch of its own, a pull
 * request — and the one thing a person can get wrong here is which repository
 * they have just pointed an unsupervised agent at.
 */
function describeCodeTarget(code: {
  repo: { owner: string; name: string } | null;
  baseRef: string;
}): string {
  if (!code.repo) return "A repository has not been named yet.";
  const from = code.baseRef.trim() ? `from ${code.baseRef.trim()}` : "from its default branch";
  return `A cloud runner with ${code.repo.owner}/${code.repo.name} checked out ${from}, pushing a branch of its own and opening a pull request.`;
}

/**
 * What a Code run may do with nobody there, as a consequence rather than a mode
 * name.
 *
 * The same job `describeUnattended` does for a Work routine, against the
 * control that actually governs a cloud run: the engine routes everything it
 * cannot decide to the driver's `requestApproval`, which answers `deny` under
 * anything narrower than `full`.
 */
function describeCodeUnattended(mode: string): string {
  switch (mode) {
    case "plan":
      return "It works out what it would do and stops there. Nothing is written and nothing is pushed.";
    case "auto-edit":
      return "It edits files on its own branch. Anything else it cannot decide is refused rather than waited on, because nobody is there to ask.";
    case "full":
    default:
      return "It decides for itself, inside its own branch and its own container. Nothing reaches your Macs and nothing merges without you.";
  }
}

/**
 * The unattended rule as a sentence about consequences.
 *
 * Deliberately not the radio's own label. "Stop and wait for me" is the right
 * label on a control the reader is choosing between three of; here it has to
 * stand alone and say what will be true at four in the morning, which is a
 * different sentence.
 */
function describeUnattended(policy: string): string {
  switch (policy) {
    case "skip_irreversible":
      return "If it meets something it cannot undo, it does everything else and tells you what it skipped.";
    case "disallow_irreversible":
      return "If it meets something it cannot undo, the whole run is treated as a failure.";
    case "pause_for_approval":
    default:
      return "If it meets something it cannot undo, it stops and waits for you.";
  }
}

function describeOffline(policy: string, target: "cloud" | "local" | "automatic"): string {
  // The Mac rule is only a fact about runs that could need a Mac. Printing it on
  // a cloud-only schedule would be answering a question the reader did not ask
  // and could not act on.
  if (target === "cloud") return "";
  switch (policy) {
    case "wait":
      return "If the Mac is asleep it waits for it.";
    case "cloud_subset":
      return "If the Mac is asleep it does the part that does not need one.";
    case "skip":
    default:
      return "If the Mac is asleep the run is skipped.";
  }
}
