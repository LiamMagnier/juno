"use client";

import * as React from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import {
  WORK_APPROVAL_DECISIONS,
  WORK_RISK_LEVELS,
  type WorkApprovalDecision,
  type WorkRiskLevel,
} from "@/lib/work/domain";
import type { ClientWorkEvent } from "@/lib/work/serializers";
import { nested, readEvent, str, strings, type Payload } from "@/components/work/work-payload";
import { workTimeAgo } from "@/components/work/work-vocabulary";

/*
 * The two things that stop a run dead: a question, and an approval.
 *
 * WHAT THIS FILE STILL OWNS. The QUESTION card, whole, and the DERIVATIONS for
 * both — turning the event stream into open questions and into approval cards.
 * The approval card's own rendering moved to `approvals/`, where it was rebuilt
 * around a verb-labelled button and a preview of the thing being authorised;
 * the derivation stayed here because it is the half that reads the stream, and
 * splitting a reader from its own payload notes is how the two drift.
 *
 * Both are rendered as the run's own state rather than as a toast or a modal,
 * because both can outlive the tab that was open when they were raised — a
 * scheduled task can ask at four in the morning. The card has to be answerable
 * whenever the user comes back, and has to say plainly when it no longer is.
 *
 * Both are also derived from the event stream rather than from a list endpoint,
 * because there is no list endpoint: `approval_requested` and `approval_resolved`
 * are what the executor writes and what the stream replays from a cursor. That
 * is the right source anyway — the feed and the cards can then never disagree
 * about whether something was asked.
 *
 * Which makes the payload reader here load-bearing rather than incidental. Both
 * derivations key on an id, and the cloud runner writes that id one level down —
 * `{ kind: "question_asked", question: { id, question, why, options } }`. Read
 * flat, as this file used to read it, the id came back null, the card was never
 * built, and a cloud run that stopped to ask something sat there unanswerable
 * with a spinner on it. `readEvent` is what lifts the envelope.
 */

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface OpenQuestion {
  id: string;
  question: string;
  /** Why the run cannot proceed without an answer. Null if it did not say. */
  why: string | null;
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
    const payload = readEvent(event);
    const id = str(payload, "questionId", "id");
    if (id === null) continue;
    if (event.kind === "question_asked") {
      const question = str(payload, "question", "text", "prompt");
      if (question === null) continue;
      open.set(id, {
        id,
        question,
        // The runtime states a `why` beside every question, and it is the half
        // that makes the question answerable: "which folder?" and "which folder,
        // because two of them are called Invoices" are different questions.
        why: str(payload, "why", "reason"),
        options: strings(payload, "options", "choices"),
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
    // `bg-warning/10`, which is the fill `WorkStateNote` gives its warning tone
    // and therefore the one warning wash in Work. At `/[0.06]` this composited
    // to ~3.5% lightness over the black ground — under `--card`, so the card
    // holding the question the run has STOPPED for sat lower than an ordinary
    // card beside it. The alpha was tuned against the old 9%-lightness page.
    <div className="rounded-field border border-warning/40 bg-warning/10 px-3.5 py-3">
      <p className="font-mono text-micro text-warning-foreground">
        Waiting on you · asked {workTimeAgo(question.askedAt)}
      </p>
      <p className="mt-1.5 text-body leading-relaxed text-foreground">{question.question}</p>
      {question.why !== null && (
        <p className="mt-1 text-ui leading-relaxed text-muted-foreground">{question.why}</p>
      )}
      {question.options.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {/* Picks from a set, not discrete actions — so `Pressable kind="chip"`
              rather than an outline Button whose `h-7` override was fighting
              `size="sm"`'s h-8 and landing these 4px under every other pill on
              the surface. */}
          {question.options.map((option) => (
            <Pressable
              key={option}
              kind="chip"
              size="lg"
              disabled={busy}
              onClick={() => answer(option)}
            >
              {option}
            </Pressable>
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
          className="size-9 shrink-0"
        >
          <Send className="size-3.5" aria-hidden="true" />
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
    const payload = readEvent(event);
    // `requestId` is what the runtime calls it on the resolution and
    // `approvalId` is what the route that records a web decision writes. Both
    // name the same row, and matching on only one of them leaves cards that can
    // never be closed by a decision made on another device.
    const id = str(payload, "approvalId", "requestId", "id");
    if (id === null) continue;

    if (event.kind === "approval_requested") {
      const digest = str(payload, "actionDigest");
      cards.set(id, {
        id,
        action: str(payload, "action") ?? "an action",
        risk: riskOf(str(payload, "risk")),
        summary: str(payload, "summary", "description") ?? "Juno wants to do something.",
        detail: nested(payload, "detail"),
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
