"use client";

import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import { CHAT_COMPOSER_FIELD_ID } from "@/components/chat/composer";
import { isTerminalStatus } from "@/lib/work/domain";
import type { ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import type { ConversationWork } from "@/components/chat/use-conversation-work";
import { ApprovalQueue } from "@/components/work/approvals/approval-queue";
import { WorkDeliverableStage } from "@/components/work/detail/work-deliverable-stage";
import { WorkOutcomeDigest } from "@/components/work/detail/work-outcome";
import { WorkProgressChecklist, planTally } from "@/components/work/detail/work-progress";
import { WorkQuestionCard } from "@/components/work/work-decisions";
import { WorkLiveMeter } from "@/components/work/work-detail-panels";
import {
  WorkCurrentAction,
  derivePerformedActions,
} from "@/components/work/work-timeline";
import { deriveTurns } from "@/components/work/work-conversation";
import {
  DegradationNotes,
  WorkStatusPill,
  statusSentence,
} from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/**
 * The delegated task, drawn inside the conversation that started it.
 *
 * A router with two destinations, for the same reason `ResearchRunPanel` is one:
 * a run being WATCHED and a run being READ are two different products, and the
 * old task page answered the second question with the first one's layout for as
 * long as the tab stayed open.
 *
 *   LIVE      → what it is doing now, the plan with its tally, one line of
 *               facts, the run's own words, and the block that is holding it
 *               up. The reader's question is "is it working, and does it need
 *               me".
 *   TERMINAL  → what happened, what it produced, and what it cost. The reader's
 *               question is "did I get the thing".
 *
 * NOTHING HERE IS NEW. Every block is a component the task page already mounts
 * over the same event stream — `WorkCurrentAction`, `WorkProgressChecklist`,
 * `WorkQuestionCard`, `ApprovalQueue`, `WorkDeliverableStage`,
 * `WorkOutcomeDigest`, `WorkLiveMeter` — because they are pure functions of that
 * stream and were built to be re-mounted. A second drawing of a plan would be a
 * second answer to "how far has this got", and the two would drift on the first
 * day somebody fixed one of them.
 *
 * IT DOES NOT OWN THE RUN. Answering by typing, steering and stopping are the
 * composer's, because the composer is where a person types at a conversation —
 * the same split `ResearchRunPanel` documents. The stream lives one level up in
 * `useConversationWork`, which is what keeps there being exactly one cursor.
 *
 * ── Why this is a panel and the reading column is not ─────────────────────
 *
 * `rounded-panel` (20) with `p-2` (8) leaves 12 for everything nested inside it,
 * which is the rung every Work decision card is already drawn at
 * (`approval-card.tsx`, `WorkQuestionCard`): the geometry works out rather than
 * being arranged. Prose inside takes `px-2` of its own, so text sits 16px from
 * the panel's edge — the product's one gutter — while the cards sit 8px in and
 * keep their corners struck from the panel's centre.
 */

/** The task's own words, oldest first. Juno's side of the run only. */
function useSpokenTurns(events: ConversationWork["events"]) {
  return React.useMemo(
    () => deriveTurns(events).filter((turn) => turn.role === "juno"),
    [events]
  );
}

export function WorkRunPanel({
  work,
  className,
}: {
  work: ConversationWork;
  className?: string;
}) {
  const { session, run } = work;
  const spoken = useSpokenTurns(work.events);
  if (session === null) return null;

  const finished = isTerminalStatus(session.status);
  const needsYou = work.questions.length > 0 || work.openApprovals.length > 0;

  return (
    <section
      aria-label="Task"
      className={cn(
        // Flat: a fill and a hairline, no shadow. Nothing in the reading column
        // casts one (FLAT_UI §2).
        "rounded-panel border border-border bg-card p-2 motion-safe:animate-rise-in",
        className
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-2 pb-2 pt-1">
        <WorkStatusPill status={session.status} describe={false} />
        <p className="min-w-0 flex-1 text-ui text-muted-foreground">
          {statusSentence(session.status)}
        </p>
      </header>

      {finished ? (
        <TerminalRun session={session} run={run} work={work} spoken={spoken} />
      ) : (
        <LiveRun work={work} spoken={spoken} needsYou={needsYou} />
      )}
    </section>
  );
}

function LiveRun({
  work,
  spoken,
  needsYou,
}: {
  work: ConversationWork;
  spoken: ReturnType<typeof deriveTurns>;
  needsYou: boolean;
}) {
  const tally = planTally(work.plan);
  return (
    <div className="space-y-3">
      {/* What it is doing right now, first — the position a reader watching an
          agent looks at, and the one line that changes on its own. */}
      <WorkCurrentAction action={work.currentAction} />

      {work.plan.length > 0 && (
        <div className="px-2">
          <h3 className="mb-2 flex items-baseline gap-2">
            <span className="text-ui font-medium text-foreground">Plan</span>
            {/* The tally rather than a percentage: "4/7" is a position in a list
                somebody can see, and "57%" is a number they convert back. */}
            <span className="font-mono text-caption tabular-nums text-muted-foreground">
              {tally.done}/{tally.total}
            </span>
          </h3>
          <WorkProgressChecklist steps={work.plan} />
        </div>
      )}

      {work.run !== null && (
        <div className="px-2">
          <WorkLiveMeter run={work.run} />
        </div>
      )}

      <RunWords spoken={spoken} />

      {needsYou && (
        <div className="space-y-2.5">
          {work.questions.map((question) => (
            <WorkQuestionCard
              key={question.id}
              question={question}
              busy={work.busy}
              // Only the one-press options answer from the card. A typed answer
              // goes through the composer, which is in `answer` mode for exactly
              // this question — one question, one place to type at it.
              onAnswer={(questionId, text) => void work.answer(questionId, text)}
              current={question.id === work.questions[0]?.id}
              // The chat composer, not the /work thread composer the card
              // defaults to: that field is not on this page, and a "Reply below"
              // that focuses nothing is a control offering something the surface
              // cannot do.
              fieldId={CHAT_COMPOSER_FIELD_ID}
            />
          ))}
          {work.openApprovals.length > 0 && (
            /* No `ApprovalPrompt` banner above the queue. That note exists for
               the task page, where the cards sit in a rail the reader may have
               scrolled past; here they are the next thing on the screen, and a
               sentence saying "Juno is waiting for you to allow or refuse one
               action" directly above the card that asks is the same fact
               printed twice. */
            <ApprovalQueue
              approvals={work.openApprovals}
                // The hook keeps one `busy` for every send it makes rather than
              // naming which card is in flight, so there is no id to single
              // out — and `batching` is the prop that disables the whole
              // queue, which is the behaviour wanted anyway: while one
              // decision is on the wire, a second press is a decision made
              // about a run that is already moving.
              busyId={null}
              batching={work.busy}
              onDecide={(approval, decision, reason) =>
                void work.decide(approval, decision, reason)
              }
              onDecideAll={(batch) => {
                // Sequential, and it stops at the first refusal: each decision
                // is a POST the executor may act on the moment it lands, so
                // firing six at a run that resolves them in order produces
                // interleaved side effects nobody asked for.
                void (async () => {
                  for (const approval of batch) {
                    const ok = await work.decide(approval, "allowed");
                    if (!ok) break;
                  }
                })();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TerminalRun({
  session,
  run,
  work,
  spoken,
}: {
  session: ClientWorkSession;
  run: ClientWorkRun | null;
  work: ConversationWork;
  spoken: ReturnType<typeof deriveTurns>;
}) {
  const performed = React.useMemo(() => derivePerformedActions(work.events), [work.events]);
  // Anything that is not a clean finish — failed, cancelled, interrupted, a Mac
  // that went away. The digest is written for a failure and is just as much use
  // on a cancel: how far it got and whether it left anything behind are the two
  // facts somebody decides what to do next on, and "completed" is the only
  // status where neither question is open.
  const incomplete = session.status !== "completed";
  return (
    <div className="space-y-3">
      {/* Why it ended, in the executor's own words where it left any. The
          status sentence in the header says what happened; this says what it
          means for the reader, and it is the sentence that explains a
          disappointing result. */}
      {run?.terminalDetail != null && run.terminalReason !== "completed" && (
        <p className="px-2 text-ui leading-relaxed text-warning-foreground">
          {run.terminalDetail}
        </p>
      )}
      {run !== null && run.degradation.length > 0 && (
        <DegradationNotes degradation={run.degradation} className="px-2" />
      )}

      {/* The digest leads, because it is what a reader decides on. */}
      {incomplete && run !== null && (
        <div className="px-2">
          <WorkOutcomeDigest run={run} plan={work.plan} performed={performed} />
        </div>
      )}

      <RunWords spoken={spoken} />

      {/* The thing the task was started for, in full, rather than behind a
          button. `WorkDeliverableStage` renders nothing when the run produced
          no previewable file — and `empty:hidden` is what keeps that "nothing"
          from still costing this stack a 12px gap, because `space-y` puts a
          margin on an empty box exactly as readily as on a full one. */}
      <div className="px-2 empty:hidden">
        <WorkDeliverableStage list={work.documents} />
      </div>

      {/* The receipt. Last, because it is reference rather than narrative. */}
      {run !== null && (
        <div className="px-2">
          <WorkLiveMeter run={run} />
        </div>
      )}
    </div>
  );
}

/**
 * What the task said while it worked.
 *
 * Only the newest few. The whole of a long run's narration is the task's
 * transcript and belongs on the run, not folded into the middle of a chat the
 * reader is also holding a conversation in — this is the part that says what it
 * concluded, in the reading column's own type.
 */
function RunWords({ spoken }: { spoken: ReturnType<typeof deriveTurns> }) {
  const latest = spoken.slice(-3);
  if (latest.length === 0) return null;
  return (
    <div className="space-y-3 px-2">
      {latest.map((turn) => (
        <Markdown key={turn.id} content={turn.text} className="text-body" />
      ))}
    </div>
  );
}
