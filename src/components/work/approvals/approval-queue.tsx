"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import type { WorkApprovalDecisionInput } from "@/components/work/work-transport";
import type { WorkApprovalCard } from "@/components/work/work-decisions";
import { ApprovalCard } from "@/components/work/approvals/approval-card";
import { actionVerb, mayBatchApprove } from "@/components/work/approvals/action-verbs";
import { WorkStateNote } from "@/components/work/work-vocabulary";

/*
 * The pending decisions, and the one control that answers several at once.
 *
 * WHY A BATCH CONTROL EXISTS AT ALL. A run that edits nine files raises nine
 * approvals, and a surface that makes the reader press nine buttons in a column
 * is a surface that teaches them to press without reading — which costs far more
 * than the batch ever saves, because the tenth card is the one that mattered.
 *
 * WHY IT CANNOT SWEEP EVERYTHING. `mayBatchApprove` excludes anything the
 * approval floor catches: sensitive, irreversible, and every action on
 * `ALWAYS_CONFIRM_ACTIONS`. Those ask under every mode by design and the batch
 * must not be the hole in that design. So the header counts only what it can
 * actually answer, and the cards it cannot answer stay in the list below,
 * unanswered, with their own verbs on their own buttons. A reader who presses
 * "Make all 6 changes" and is left with three cards has been told something
 * true: those three are different.
 *
 * WHY IT IS LABELLED WITH THE VERB AND THE COUNT. "Approve All (6)" says how
 * many and not what. When every batchable card shares one action — which is the
 * common case, since a batch is usually one tool run several times — the button
 * says the verb: "Make all 6 changes". When they differ it falls back to a
 * count, because a single verb over a mixed set would be a claim about actions
 * it does not cover.
 *
 * SEQUENTIAL, NOT PARALLEL. Each decision is one POST that the executor may act
 * on immediately, and firing six at once at a run that is resolving them in
 * order produces interleaved side effects nobody asked for. The loop also stops
 * at the first refusal: a 409 means the policy narrowed or the run moved on, and
 * carrying on through five more would turn one stale card into six failed
 * requests and a confusing pile of toasts.
 */

export function ApprovalQueue({
  approvals,
  busyId,
  batching,
  onDecide,
  onDecideAll,
}: {
  approvals: readonly WorkApprovalCard[];
  busyId: string | null;
  /** True while the batch is working through the queue. */
  batching: boolean;
  onDecide: (
    approval: WorkApprovalCard,
    decision: WorkApprovalDecisionInput,
    reason?: string
  ) => void;
  onDecideAll: (approvals: readonly WorkApprovalCard[]) => void;
}) {
  const pending = approvals.filter((approval) => approval.decision === "pending");
  const now = useApprovalClock(pending.length > 0);

  const live = pending.filter(
    (approval) =>
      approval.actionDigest !== null &&
      !(now !== null && approval.expiresAt !== null && Date.parse(approval.expiresAt) <= now)
  );
  const batchable = live.filter((approval) => mayBatchApprove(approval.action, approval.risk));

  if (approvals.length === 0) {
    return (
      <p className="text-ui leading-relaxed text-muted-foreground">
        Nothing has needed your approval. Juno always asks before anything it cannot undo — a
        permanent delete, a message sent, a purchase, a security setting.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {batchable.length > 1 && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-field border border-warning/40 bg-warning/[0.08] px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-ui leading-relaxed text-warning-foreground">
            {batchable.length === live.length
              ? `${batchable.length} decisions are waiting, and they are all the same kind.`
              : `${batchable.length} of these ${live.length} can be answered together. The rest ask on their own.`}
          </p>
          <Button
            size="sm"
            disabled={batching || busyId !== null}
            onClick={() => onDecideAll(batchable)}
            className="h-8 shrink-0"
          >
            {batchLabel(batchable)}
          </Button>
        </div>
      )}

      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          // Until the clock has ticked once after mount nothing is called
          // expired, which is the safe direction: the server re-checks expiry on
          // every decision, so the worst case is one refusal with a sentence,
          // not an action taken on a stale approval.
          expired={now !== null && approval.expiresAt !== null && Date.parse(approval.expiresAt) <= now}
          busy={busyId === approval.id || batching}
          onDecide={onDecide}
        />
      ))}
    </div>
  );
}

/**
 * The batch button's label.
 *
 * One verb when every card shares an action, a bare count when they do not. The
 * fallback is deliberately vague — "Answer all 6" rather than a verb chosen from
 * the first card — because a label that names one action while authorising six
 * different ones is the exact failure the verb table exists to prevent.
 */
function batchLabel(batchable: readonly WorkApprovalCard[]): string {
  const actions = new Set(batchable.map((approval) => approval.action));
  if (actions.size !== 1) return `Allow all ${batchable.length}`;
  const verb = actionVerb(batchable[0].action);
  return `${verb.verb} — all ${batchable.length}`;
}

/**
 * Keeps a clock for the cards, and only while one is pending.
 *
 * An approval stops being answerable at `expiresAt`, and a card that only
 * recomputes on the next render happily offers its verb on a request the server
 * will refuse. Ticking every half-minute means the card turns itself into an
 * explanation before the reader can press a button that fails.
 *
 * The initial value is read in an effect rather than in `useState`, because a
 * clock read during render is the hydration bug this codebase calls out by name.
 */
const APPROVAL_TICK_MS = 30_000;

function useApprovalClock(active: boolean): number | null {
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), APPROVAL_TICK_MS);
    return () => window.clearInterval(interval);
  }, [active]);
  return now;
}

/** The banner shown when a run is parked on an approval that is off-screen. */
export function ApprovalPrompt({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <WorkStateNote tone="blocked">
      {count === 1
        ? "Juno is waiting for you to allow or refuse one action. Nothing else happens until you decide."
        : `Juno is waiting on ${count} decisions. Nothing else happens until you answer them.`}
    </WorkStateNote>
  );
}
