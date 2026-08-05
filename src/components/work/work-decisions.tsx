"use client";

import * as React from "react";
import type { Prisma } from "@prisma/client";
import { Clock, Send, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  WORK_APPROVAL_DECISIONS,
  WORK_RISK_LEVELS,
  type WorkApprovalDecision,
  type WorkRiskLevel,
} from "@/lib/work/domain";
import type { ClientWorkEvent } from "@/lib/work/serializers";
import type { WorkApprovalDecisionInput } from "@/components/work/work-transport";
import { RiskPill, WorkStateNote, workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * The two things that stop a run dead: a question, and an approval.
 *
 * Both are rendered as the run's own state rather than as a toast or a modal,
 * because both can outlive the tab that was open when they were raised — a
 * scheduled task can ask at four in the morning. The card has to be answerable
 * whenever the user comes back, and has to say plainly when it no longer is.
 *
 * Both are also derived from the event stream rather than from a list endpoint,
 * because there is no list endpoint: `approval_requested` and `approval_resolved`
 * are what the executor writes and what the stream replays from a cursor. That
 * is the right source anyway — the timeline and the cards can then never
 * disagree about whether something was asked.
 */

type Payload = Record<string, unknown>;

function payloadOf(value: Prisma.JsonValue): Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

function str(payload: Payload, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface OpenQuestion {
  id: string;
  question: string;
  /** Suggested answers, when the agent offered any. */
  options: string[];
  askedAt: string;
}

/**
 * Questions that have been asked and not yet answered.
 *
 * Matched by id rather than by "was there a later answer event", because a run
 * can have two questions open at once (a subagent and the root agent both
 * asking), and position alone would close the wrong one.
 */
export function deriveOpenQuestions(events: readonly ClientWorkEvent[]): OpenQuestion[] {
  const open = new Map<string, OpenQuestion>();
  for (const event of events) {
    const payload = payloadOf(event.payload);
    const id = str(payload, "questionId", "id");
    if (id === null) continue;
    if (event.kind === "question_asked") {
      const question = str(payload, "question", "text", "prompt");
      if (question === null) continue;
      const raw = payload.options;
      open.set(id, {
        id,
        question,
        options: Array.isArray(raw)
          ? raw.filter((entry): entry is string => typeof entry === "string")
          : [],
        askedAt: event.createdAt,
      });
    }
    if (event.kind === "question_answered") open.delete(id);
  }
  return [...open.values()];
}

export function WorkQuestionCard({
  question,
  busy,
  onAnswer,
}: {
  question: OpenQuestion;
  busy: boolean;
  onAnswer: (questionId: string, text: string) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const answer = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setDraft("");
    onAnswer(question.id, trimmed);
  };

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/[0.06] px-3.5 py-3">
      <p className="font-mono text-[10px] text-warning-foreground">
        Waiting on you · asked {workTimeAgo(question.askedAt)}
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-foreground">{question.question}</p>
      {question.options.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <Button
              key={option}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => answer(option)}
              className="h-7 px-2.5 text-[12px]"
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") answer(draft);
          }}
          disabled={busy}
          placeholder="Type your answer"
          aria-label={`Answer: ${question.question}`}
          className="h-9 flex-1"
        />
        <Button
          size="icon-sm"
          disabled={busy || draft.trim().length === 0}
          onClick={() => answer(draft)}
          aria-label="Send answer"
          className="h-9 w-9 shrink-0"
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * One approval as the timeline recorded it.
 *
 * `actionDigest` is nullable and that is load-bearing. The decision endpoint
 * requires a 64-character hex digest and refuses anything else, so a request
 * whose event did not carry one cannot be answered from this browser at all.
 * Rendering the card with its buttons removed and a sentence in their place is
 * the honest outcome; rendering enabled buttons that will 400 is not.
 */
export interface WorkApprovalCard {
  id: string;
  action: string;
  risk: WorkRiskLevel;
  summary: string;
  detail: Payload;
  actionDigest: string | null;
  decision: WorkApprovalDecision;
  decidedAt: string | null;
  /** Absent when the executor did not say. The card then never claims a deadline. */
  expiresAt: string | null;
  createdAt: string;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function riskOf(value: string | null): WorkRiskLevel {
  // An unrecognised risk level is treated as the highest, exactly as
  // `serializeApproval` does: a client that cannot name it still asks rather
  // than quietly presenting the action as routine.
  return value !== null && (WORK_RISK_LEVELS as readonly string[]).includes(value)
    ? (value as WorkRiskLevel)
    : "irreversible";
}

/**
 * Every approval this run has raised, in the order it raised them.
 *
 * Resolutions are folded in from `approval_resolved` rather than kept as
 * separate rows, so a card that has been answered stops offering buttons the
 * moment the stream says so — including when the answer came from the phone
 * that raised the notification rather than from this tab.
 */
export function deriveApprovals(events: readonly ClientWorkEvent[]): WorkApprovalCard[] {
  const cards = new Map<string, WorkApprovalCard>();

  for (const event of events) {
    if (event.visibility !== "user") continue;
    const payload = payloadOf(event.payload);
    const id = str(payload, "approvalId", "id");
    if (id === null) continue;

    if (event.kind === "approval_requested") {
      const digest = str(payload, "actionDigest");
      cards.set(id, {
        id,
        action: str(payload, "action") ?? "an action",
        risk: riskOf(str(payload, "risk")),
        summary: str(payload, "summary", "description") ?? "Juno wants to do something.",
        detail: payloadOf((payload.detail ?? null) as Prisma.JsonValue),
        actionDigest: digest !== null && DIGEST_PATTERN.test(digest) ? digest : null,
        decision: "pending",
        decidedAt: null,
        expiresAt: str(payload, "expiresAt"),
        createdAt: event.createdAt,
      });
      continue;
    }

    if (event.kind === "approval_resolved") {
      const card = cards.get(id);
      if (!card) continue;
      const decision = str(payload, "decision");
      cards.set(id, {
        ...card,
        decision:
          decision !== null && (WORK_APPROVAL_DECISIONS as readonly string[]).includes(decision)
            ? (decision as WorkApprovalDecision)
            : "allowed",
        decidedAt: event.createdAt,
      });
    }
  }

  return [...cards.values()];
}

/**
 * Keeps a clock for the approval cards, and only while one is pending.
 *
 * An approval stops being answerable at `expiresAt`, and a card that only
 * recomputes on the next render happily offers Allow on a request the server
 * will refuse. Ticking every half-minute means the card turns itself into an
 * explanation before the user can press a button that fails.
 *
 * The initial value is read in an effect rather than in `useState`, because a
 * clock read during render is the hydration bug this codebase calls out by
 * name: the server and the first client render would disagree about `now`.
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

export function WorkApprovals({
  approvals,
  busyId,
  onDecide,
}: {
  approvals: readonly WorkApprovalCard[];
  busyId: string | null;
  onDecide: (approval: WorkApprovalCard, decision: WorkApprovalDecisionInput) => void;
}) {
  const pending = approvals.filter((approval) => approval.decision === "pending");
  const now = useApprovalClock(pending.length > 0);

  if (approvals.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Nothing has needed your approval. Juno always asks before anything it cannot undo — a
        permanent delete, a message sent, a purchase, a security setting.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          // Until the clock has ticked once after mount nothing is called
          // expired, which is the safe direction: the server re-checks expiry on
          // every decision, so the worst case is one refusal with a sentence,
          // not an action taken on a stale approval.
          expired={
            now !== null && approval.expiresAt !== null && Date.parse(approval.expiresAt) <= now
          }
          busy={busyId === approval.id}
          onDecide={onDecide}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  approval,
  expired,
  busy,
  onDecide,
}: {
  approval: WorkApprovalCard;
  expired: boolean;
  busy: boolean;
  onDecide: (approval: WorkApprovalCard, decision: WorkApprovalDecisionInput) => void;
}) {
  const answerable = approval.decision === "pending" && !expired;
  const digest = approval.actionDigest;
  const detailRows = Object.entries(approval.detail).filter(
    ([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );

  return (
    <div
      className={cn(
        "rounded-xl border px-3.5 py-3",
        answerable ? "border-warning/40 bg-warning/[0.06]" : "border-border/60 bg-card/50"
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert
          className={cn("h-3.5 w-3.5 shrink-0", answerable ? "text-warning" : "text-muted-foreground")}
          aria-hidden="true"
        />
        <RiskPill risk={approval.risk} />
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {workTimeAgo(approval.createdAt)}
        </span>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-foreground">{approval.summary}</p>
      <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{approval.action}</p>

      {detailRows.length > 0 && (
        <dl className="mt-2 space-y-0.5">
          {detailRows.map(([key, value]) => (
            <div key={key} className="flex gap-2 font-mono text-[10px] leading-relaxed">
              <dt className="shrink-0 text-muted-foreground/70">{key}</dt>
              <dd className="min-w-0 break-all text-muted-foreground">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {answerable && digest === null ? (
        // The request arrived without the digest that proves which action is
        // being authorised, so this browser has no way to answer it that the
        // server would accept. Saying where it CAN be answered is the only
        // useful thing left; a greyed-out button would not say even that.
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-warning-foreground">
          This request did not arrive with the signature Juno needs to accept an answer from the
          web. Decide it in the Juno app on the Mac that raised it.
        </p>
      ) : answerable ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => onDecide(approval, "allowed")} className="h-8">
            Allow once
          </Button>
          {/* "Always" is offered only where it is meaningful: an irreversible
              action asks every time under every policy, so a standing
              permission for one would be a promise the executor will not keep. */}
          {approval.risk !== "irreversible" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onDecide(approval, "allowed_always")}
              className="h-8"
            >
              Always allow this
            </Button>
          )}
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={busy}
            onClick={() => onDecide(approval, "denied")}
            className="h-8"
          >
            Refuse
          </Button>
        </div>
      ) : (
        <p className="mt-2.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {describeDecision(approval, expired)}
        </p>
      )}
    </div>
  );
}

function describeDecision(approval: WorkApprovalCard, expired: boolean): string {
  switch (approval.decision) {
    case "allowed":
      return `Allowed ${workTimeAgo(approval.decidedAt ?? approval.createdAt)}`;
    case "allowed_always":
      return `Allowed for good ${workTimeAgo(approval.decidedAt ?? approval.createdAt)}`;
    case "denied":
      return `Refused ${workTimeAgo(approval.decidedAt ?? approval.createdAt)}`;
    case "expired":
      return "Expired unanswered — Juno stopped rather than acting on a stale approval";
    case "superseded":
      return "Replaced by a later request";
    case "pending":
      return expired
        ? "Expired unanswered — Juno stopped rather than acting on a stale approval"
        : "Waiting";
  }
}

/** The banner shown when a run is parked on an approval that is off-screen. */
export function WorkApprovalPrompt({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <WorkStateNote tone="blocked">
      {count === 1
        ? "Juno is waiting for you to allow or refuse one action. Nothing else happens until you decide."
        : `Juno is waiting on ${count} decisions. Nothing else happens until you answer them.`}
    </WorkStateNote>
  );
}
