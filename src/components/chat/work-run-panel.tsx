"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ChevronRight, Square } from "@/components/ui/icons";
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
import { CaptureSkillButton, canCaptureSkill } from "@/components/work/skills/capture-skill";
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
import { ComposerIcons } from "@/lib/app-icons";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The task the model started, drawn inside the conversation that started it.
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
 * IT DOES NOT OWN THE RUN. Answering by typing and steering are the
 * composer's, because the composer is where a person types at a conversation,
 * the same split `ResearchRunPanel` documents. The stream lives one level up in
 * `useConversationWork`, which is what keeps there being exactly one cursor.
 *
 * IT SAYS WHAT IT IS. Nobody pressed a "task" switch: the model decided this
 * sentence was work to hand off, so the panel names itself (a quiet "Task"
 * label and the title the task was given) and carries its own Stop. The
 * composer's Stop still ends it too, but a reader who did not ask for a task
 * should not have to guess that the send button is where it stops.
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
  actor,
}: {
  work: ConversationWork;
  className?: string;
  /** Who is working, when it is one of the account's agents rather than Juno. */
  actor?: string | null;
}) {
  const { session, run } = work;
  const spoken = useSpokenTurns(work.events);
  const reduce = useReducedMotion() ?? false;
  const titleId = React.useId();
  if (session === null) return null;

  const finished = isTerminalStatus(session.status);
  const needsYou = work.questions.length > 0 || work.openApprovals.length > 0;

  return (
    <motion.section
      aria-labelledby={titleId}
      // Fade and a 4px rise on the base rung: the panel arrives under the
      // reply that announced it, so it rises into place rather than dropping
      // in. Reduced motion keeps the fade and loses the travel.
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition.base}
      className={cn(
        // Flat: a fill and a hairline, no shadow. Nothing in the reading column
        // casts one (FLAT_UI §2).
        "rounded-panel border border-border bg-card p-2",
        className
      )}
    >
      <header className="flex items-start gap-3 px-2 pb-2 pt-1">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <ComposerIcons.task motion="none" className="size-3.5" aria-hidden="true" />
            Task
          </p>
          <h3 id={titleId} className="mt-1 line-clamp-2 text-body font-medium leading-snug text-foreground">
            {session.title.trim() || session.goal}
          </h3>
          {/* Keyed on the status so a change re-enters with a short fade: the
              one line in the header that moves on its own should say so. */}
          <motion.div
            key={session.status}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transition.fast}
            className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1"
          >
            <WorkStatusPill status={session.status} describe={false} />
            <p className="min-w-0 text-ui text-muted-foreground">{statusSentence(session.status, actor)}</p>
          </motion.div>
        </div>
        <AnimatePresence initial={false}>
          {!finished && work.steering !== null && (
            <motion.div
              key="stop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transition.fast }}
              exit={{ opacity: 0, transition: transition.exit }}
              className="shrink-0"
            >
              <StopButton stop={work.steering.stop} />
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Live and finished are two different bodies (see above), so the swap
          between them is a cross-fade: the old one leaves on the exit rung
          before the new one arrives. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={finished ? "terminal" : "live"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: transition.base }}
          exit={{ opacity: 0, transition: transition.exit }}
        >
          {finished ? (
            <TerminalRun session={session} run={run} work={work} spoken={spoken} />
          ) : (
            <LiveRun work={work} spoken={spoken} needsYou={needsYou} />
          )}
        </motion.div>
      </AnimatePresence>
    </motion.section>
  );
}

/**
 * The panel's own Stop.
 *
 * It holds its spinner from the press until the task's status changes and
 * the header drops the button, rather than until the request returns: the
 * cancel lands a moment before the stream reports the new status, and a
 * button that came back to life in that gap would read as a stop that did
 * not take. A refusal (already said in a toast) gives the button back.
 */
function StopButton({ stop }: { stop: () => Promise<boolean> }) {
  const [stopping, setStopping] = React.useState(false);
  return (
    <Button
      type="button"
      // Outlined rather than ghost: it sits in a header full of text, and a
      // bare "Stop" there read as one more label rather than as the control.
      variant="outline"
      size="sm"
      loading={stopping}
      aria-label="Stop the task"
      onClick={() => {
        setStopping(true);
        void stop().then((stopped) => {
          if (!stopped) setStopping(false);
        });
      }}
      className="gap-1.5"
    >
      {/* The composer's stop face, so the two controls that end this task
          are recognisably the same verb. */}
      <Square className="size-3 fill-current" aria-hidden="true" />
      Stop
    </Button>
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
          <h4 className="mb-2 flex items-baseline gap-2">
            <span className="text-ui font-medium text-foreground">Plan</span>
            {/* The tally rather than a percentage: "4/7" is a position in a list
                somebody can see, and "57%" is a number they convert back. */}
            <span className="font-mono text-caption tabular-nums text-muted-foreground">
              {tally.done}/{tally.total}
            </span>
          </h4>
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

      {/*
       * Turning a run that worked into a skill, offered at the one moment it
       * makes sense: the deliverable is above it and the reader has just
       * decided the run was good.
       *
       * This offer used to sit under the finished checklist on the task page,
       * which is the page Work's merge into Chat deleted. Without a new mount it
       * would have gone with it, and skills would be back to being AUTHORED
       * only — a blank textarea at /skills/new asking somebody to write, in
       * advance, instructions for a job they have not done yet, which is the
       * hardest moment to write them and why skill libraries stay empty.
       * `canCaptureSkill` keeps it off failed runs and off anything too small to
       * generalise, so a terminal run that went badly does not offer to teach
       * Juno how it went badly.
       */}
      {canCaptureSkill(session.status, work.plan) && (
        <div className="px-2">
          <CaptureSkillButton session={session} plan={work.plan} performed={performed} />
        </div>
      )}

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
 * The newest three in full, in the reading column's own type: that is the part
 * that says what it concluded. Anything older folds behind one disclosure
 * rather than going away, because this panel is the task's only home now (its
 * old page redirects here), so a run's earlier narration has nowhere else to be
 * read. Folded by default so a long run does not push the chat it sits in off
 * the screen.
 */
function RunWords({ spoken }: { spoken: ReturnType<typeof deriveTurns> }) {
  const [showEarlier, setShowEarlier] = React.useState(false);
  const latest = spoken.slice(-3);
  const earlier = spoken.slice(0, -3);
  if (latest.length === 0) return null;
  return (
    <div className="px-2">
      {earlier.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowEarlier((open) => !open)}
            aria-expanded={showEarlier}
            className="group -mx-1 flex items-center gap-1.5 rounded-control px-1 py-0.5 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground coarse:min-h-11"
          >
            <ChevronRight
              className={cn(
                "size-3 shrink-0 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                showEarlier && "rotate-90"
              )}
              aria-hidden="true"
            />
            Earlier updates
            <span className="tabular-nums">{earlier.length}</span>
          </button>
          <Collapse open={showEarlier} innerClassName="space-y-3 pt-3">
            {earlier.map((turn) => (
              <Markdown key={turn.id} content={turn.text} className="text-body" />
            ))}
          </Collapse>
        </>
      )}
      <div className={cn("space-y-3", earlier.length > 0 && "mt-3")}>
        {latest.map((turn) => (
          <Markdown key={turn.id} content={turn.text} className="text-body" />
        ))}
      </div>
    </div>
  );
}
