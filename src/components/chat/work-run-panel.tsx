"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ChevronRight } from "@/components/ui/icons";
import { Icon } from "@/components/ui/juno-icons";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { CHAT_COMPOSER_FIELD_ID } from "@/components/chat/composer";
import { NeedsLead, QuietButton, VerbButton } from "@/components/chat/decision";
import { formatLiveSeconds, useHeldPhase, useLiveSeconds } from "@/components/chat/live-line";
import { isTerminalStatus } from "@/lib/work/domain";
import type { ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import type { ConversationWork } from "@/components/chat/use-conversation-work";
import { ApprovalQueue } from "@/components/work/approvals/approval-queue";
import { WorkDeliverableStage } from "@/components/work/detail/work-deliverable-stage";
import { WorkOutcomeDigest } from "@/components/work/detail/work-outcome";
import { planTally } from "@/components/work/detail/work-progress";
import type { OpenQuestion } from "@/components/work/work-decisions";
import { WorkLiveMeter } from "@/components/work/work-detail-panels";
import { CaptureSkillButton, canCaptureSkill } from "@/components/work/skills/capture-skill";
import { derivePerformedActions, type PlanStep } from "@/components/work/work-timeline";
import { deriveTurns } from "@/components/work/work-conversation";
import { DegradationNotes, statusSentence } from "@/components/work/work-vocabulary";
import { StatusIcons } from "@/lib/app-icons";
import { TIMING } from "@/lib/interaction";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { ActivityLines } from "@/components/chat/team-activity";
import { isTeamActivity, teamMemberLines, workSummaryLines } from "@/lib/agents/activity-words";

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
 * THE BLOCKS ARE THE STREAM'S. The plan, questions, approvals, deliverable
 * and digest are pure functions of the one event stream (`useConversationWork`);
 * this card only draws them in the transcript's decision family, so a task's
 * question and the chat's own approval card read as one product.
 *
 * IT DOES NOT OWN THE RUN. Answering by typing and steering are the
 * composer's, because the composer is where a person types at a conversation,
 * the same split `ResearchRunPanel` documents. The stream lives one level up in
 * `useConversationWork`, which is what keeps there being exactly one cursor.
 *
 * IT SAYS WHAT IT IS. Nobody pressed a "task" switch: the model decided this
 * sentence was work to hand off, so the card names it (the title the task was
 * given) and carries its own Stop.
 */

/** The task's own words, oldest first. Alevr's side of the run only. */
function useSpokenTurns(events: ConversationWork["events"]) {
  return React.useMemo(
    () => deriveTurns(events).filter((turn) => turn.role === "juno"),
    [events]
  );
}

/** Where the run is in its plan: the step being worked on (1-based) and the count. */
function planPosition(plan: readonly PlanStep[]): { at: number; total: number } | null {
  if (plan.length === 0) return null;
  const active = plan.findIndex((step) => step.state === "active");
  if (active >= 0) return { at: active + 1, total: plan.length };
  const next = plan.findIndex((step) => step.state === "pending");
  return next >= 0 ? { at: next + 1, total: plan.length } : null;
}

/*
 * THE TASK CARD STATES ONE THING (INTERACTION_SPEC T2-T4, critique 1).
 *
 *   running   [mark] Drafting the renewal summary
 *                    Reading Q3 Forecast.xlsx, step 2 of 4 · 12s          Stop
 *   waiting   [mark] Drafting the renewal summary
 *                    Waiting for your answer at step 2 of 4               Stop
 *                    Needs your answer: which customer holds the plan?
 *   ─────────────────────────────────────────────────────────────────────
 *   › Plan  1 of 4 steps done
 *
 * The header's second line is where the work is, in words, and it is the only
 * progress signal; the Continuum mark beside the title is the live presence,
 * handing its tone on only when a real step arrives, and still while the task
 * waits on you. Every thing that needs the person is then listed the same way
 * (a question or an approval: the attention words, then what). There is no
 * Pause, because the task has none; Stop is the one control, and it stays
 * while the task is blocked on you.
 */
export function WorkRunPanel({
  work,
  className,
  actor,
}: {
  work: ConversationWork;
  className?: string;
  /** Who is working, when it is one of the account's agents rather than Alevr. */
  actor?: string | null;
}) {
  const { session, run } = work;
  const spoken = useSpokenTurns(work.events);
  const reduce = useReducedMotion() ?? false;
  const titleId = React.useId();
  const [planOpen, setPlanOpen] = React.useState(false);
  const finished = session !== null && isTerminalStatus(session.status);
  const action = finished ? null : work.currentAction;
  const actionTitle = useHeldPhase(action?.title ?? "");
  const actionSeconds = useLiveSeconds(!finished && action !== null, action?.since ?? null);
  if (session === null) return null;

  const asking = work.questions.length > 0;
  const approving = work.openApprovals.length > 0;
  const needsYou = asking || approving;
  const position = planPosition(work.plan);
  const tally = planTally(work.plan);
  const failed = session.status === "failed" || session.status === "cancelled";
  const phase = finished ? (failed ? "error" : "finished") : needsYou ? "waiting" : "working";

  // The one line of progress. A count changes in place; a new step changes the words.
  const stepWords = position ? `step ${position.at} of ${position.total}` : null;
  const progress = finished ? (
    statusSentence(session.status, actor)
  ) : needsYou ? (
    `Waiting for your ${asking ? "answer" : "approval"}${stepWords ? ` at ${stepWords}` : ""}`
  ) : action ? (
    <>
      <span className="text-foreground">{actionTitle}</span>
      {stepWords ? `, ${stepWords}` : null}
      {actionSeconds * 1000 >= TIMING.elapsedAfter && (
        <span aria-hidden="true" className="tabular-nums text-muted-foreground">
          <span className="mx-1.5 opacity-60">·</span>
          {formatLiveSeconds(actionSeconds)}
        </span>
      )}
    </>
  ) : (
    `${statusSentence(session.status, actor)}${stepWords ? ` At ${stepWords}.` : ""}`
  );
  const hasDetails = work.plan.length > 0 || run !== null;

  return (
    <motion.section
      aria-labelledby={titleId}
      // What an agent profile's "Show in chat" / "Answer in chat" scrolls to
      // (agent-panel.tsx), keyed by the session this panel draws.
      data-work-run-panel={session.id}
      data-phase={phase}
      // Fade and a 4px rise on the base rung: the card arrives under the reply
      // that announced it. Reduced motion keeps the fade and loses the travel.
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition.base}
      className={cn(
        // A flat tone step, radius 12, no border, no shadow (T anatomy); a
        // hairline only under Increase Contrast.
        "@container rounded-field bg-muted contrast-more:border contrast-more:border-border",
        className
      )}
    >
      <header className="flex items-start gap-3 py-3 pl-4 pr-2.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <GalaxyMark phase={phase} size={20} eventKey={action?.title ?? phase} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="line-clamp-2 text-body font-medium text-foreground">
            {session.title.trim() || session.goal}
          </h3>
          {/* The words change with the run; announced politely, once per phase. */}
          <p className="mt-px text-ui text-foreground/75" aria-live="polite">
            {progress}
          </p>
        </div>
        <AnimatePresence initial={false}>
          {!finished && work.steering !== null && (
            <motion.div
              key="stop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transition.fast }}
              exit={{ opacity: 0, transition: transition.exit }}
              className="-mt-0.5 shrink-0"
            >
              <StopButton stop={work.steering.stop} />
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Live and finished are two different bodies, so the swap between them
          is a cross-fade: the old one leaves on the exit rung first. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={finished ? "terminal" : "live"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: transition.base }}
          exit={{ opacity: 0, transition: transition.exit }}
        >
          {finished ? (
            <TerminalRun session={session} run={run} work={work} spoken={spoken} actor={actor} />
          ) : (
            <LiveRun work={work} spoken={spoken} />
          )}
        </motion.div>
      </AnimatePresence>

      {hasDetails && (
        <>
          <button
            type="button"
            onClick={() => setPlanOpen((open) => !open)}
            aria-expanded={planOpen}
            className={cn(
              "flex h-[38px] w-full items-center gap-1.5 border-t border-border/70 px-4 text-left text-ui text-muted-foreground coarse:h-11",
              "transition-colors duration-fast ease-out-soft hover:bg-accent/60 hover:text-foreground/75 motion-reduce:transition-none",
              planOpen ? "rounded-none" : "rounded-b-field"
            )}
          >
            <ChevronRight
              className={cn("size-4 shrink-0 transition-transform duration-base ease-in-out motion-reduce:transition-none", planOpen && "rotate-90")}
              aria-hidden="true"
            />
            {work.plan.length > 0 ? (
              <>
                <span className="text-foreground/75">Plan</span>
                <span className="tabular-nums">
                  {tally.done} of {tally.total} {tally.total === 1 ? "step" : "steps"} done
                </span>
              </>
            ) : (
              <span className="text-foreground/75">Details</span>
            )}
          </button>
          <Collapse open={planOpen} innerClassName="px-4 pb-3">
            <PlanList steps={work.plan} needs={needsYou ? (asking ? "answer" : "approval") : null} />
            {run !== null && (
              <div className={cn(work.plan.length > 0 && "mt-2.5")}>
                <WorkLiveMeter run={run} />
              </div>
            )}
          </Collapse>
        </>
      )}
    </motion.section>
  );
}

/**
 * The plan, as sentences (T3): done steps in the second ink with a check, the
 * current step in full ink with the presence mark (or, while the task waits on
 * you, the waiting glyph in the attention ink and what it waits for), upcoming
 * steps in the third ink. Nothing turns: a step changes state in place.
 */
function PlanList({ steps, needs }: { steps: readonly PlanStep[]; needs: "answer" | "approval" | null }) {
  if (steps.length === 0) return null;
  return (
    <ol className="flex flex-col">
      {steps.map((step) => {
        const waiting = step.state === "active" && needs !== null;
        return (
          <li
            key={step.id}
            data-state={waiting ? "waiting" : step.state}
            className={cn(
              "flex min-h-[30px] items-center gap-2.5 py-1 text-nav",
              step.state === "done" && "text-foreground/75",
              (step.state === "active" || step.state === "failed") && "text-foreground",
              (step.state === "pending" || step.state === "skipped" || step.state === "unreported") && "text-muted-foreground"
            )}
          >
            <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
              {waiting ? (
                <Icon name="hand" size={16} className="text-[hsl(var(--attention))]" />
              ) : step.state === "active" ? (
                <Icon name="progress" size={16} value={0.4} className="text-primary-ink" />
              ) : step.state === "done" ? (
                <Icon name="check" size={16} className="text-muted-foreground" />
              ) : step.state === "failed" ? (
                <StatusIcons.error className="size-4 text-destructive" />
              ) : step.state === "skipped" ? (
                <Icon name="minus" size={16} className="text-muted-foreground" />
              ) : (
                <Icon name="circle" size={16} className="text-muted-foreground" />
              )}
            </span>
            <span className={cn("min-w-0 flex-1", step.state === "skipped" && "line-through decoration-border")}>
              {step.title}
              <span className="sr-only">
                {waiting
                  ? `, needs your ${needs}`
                  : step.state === "done"
                    ? ", done"
                    : step.state === "active"
                      ? ", in progress"
                      : step.state === "failed"
                        ? ", failed"
                        : step.state === "skipped"
                          ? ", skipped"
                          : ""}
              </span>
            </span>
            {waiting && <span className="shrink-0 text-ui text-muted-foreground">{`Needs your ${needs}`}</span>}
            {step.state === "unreported" && <span className="shrink-0 text-ui text-muted-foreground">Never finished</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The card's one control. It holds its pending state from the press until
 * the task's status changes and the header drops it, rather than until the
 * request returns, so it never comes back to life in the gap. A refusal
 * (already said in a toast) gives it back.
 */
function StopButton({ stop }: { stop: () => Promise<boolean> }) {
  const [stopping, setStopping] = React.useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      loading={stopping}
      aria-label="Stop the task"
      onClick={() => {
        setStopping(true);
        void stop().then((stopped) => {
          if (!stopped) setStopping(false);
        });
      }}
      className="px-2.5 font-normal text-foreground/75 hover:text-foreground"
    >
      Stop
    </Button>
  );
}

function LiveRun({ work, spoken }: { work: ConversationWork; spoken: ReturnType<typeof deriveTurns> }) {
  const hasNeeds = work.questions.length > 0 || work.openApprovals.length > 0;
  // A temporary specialist team (src/lib/agents/team.ts): one line per member.
  const team = React.useMemo(() => teamMemberLines(work.events), [work.events]);
  if (spoken.length === 0 && !hasNeeds && team.length === 0) return null;
  return (
    <div className="space-y-4 px-4 pb-4 @[30rem]:pl-12">
      <ActivityLines lines={team} label="The team" />
      <RunWords spoken={spoken} />
      {hasNeeds && (
        // Every attention item is listed the same way: a question and an
        // approval both open with their attention words, then say what.
        <div className="space-y-5">
          {work.questions.map((question, index) => (
            <TaskQuestion
              key={question.id}
              question={question}
              busy={work.busy}
              current={index === 0}
              onAnswer={(questionId, text) => void work.answer(questionId, text)}
            />
          ))}
          {work.openApprovals.length > 0 && (
            <ApprovalQueue
              approvals={work.openApprovals}
              // One `busy` for every send, and `batching` disables the whole
              // queue: while one decision is on the wire, a second press is a
              // decision about a run that is already moving.
              busyId={null}
              batching={work.busy}
              onDecide={(approval, decision, reason) => void work.decide(approval, decision, reason)}
              onDecideAll={(batch) => {
                // Sequential, stopping at the first refusal: each decision is a
                // POST the executor may act on the moment it lands.
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

/** Puts the cursor in the chat composer, which is in answer mode for the first open question. */
function answerInComposer() {
  const field = document.getElementById(CHAT_COMPOSER_FIELD_ID);
  if (field) {
    field.focus();
    field.scrollIntoView({ block: "nearest" });
  }
}

/**
 * A question the task stopped for (T5): the attention words, the question,
 * why it matters, then its options as full-width rows. A row is a choice;
 * Continue sends it (questions are not consequential, so one press after the
 * choice is enough). "Something else" puts the cursor in the composer, which
 * answers this question when it is the first open one.
 */
function TaskQuestion({
  question,
  busy,
  current,
  onAnswer,
}: {
  question: OpenQuestion;
  busy: boolean;
  current: boolean;
  onAnswer: (questionId: string, text: string) => void;
}) {
  const [choice, setChoice] = React.useState<string | null>(null);
  const groupId = React.useId();
  return (
    <div role="group" aria-labelledby={groupId}>
      <p id={groupId} className="text-body text-foreground">
        <NeedsLead>Needs your answer:</NeedsLead> {question.question}
      </p>
      {question.why !== null && <p className="mt-0.5 text-ui leading-relaxed text-foreground/75">{question.why}</p>}
      {question.options.length > 0 ? (
        <>
          <div role="radiogroup" aria-label={question.question} className="-ml-2.5 mt-2 flex flex-col gap-0.5">
            {question.options.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={choice === option}
                disabled={busy}
                onClick={() => setChoice(option)}
                className="group/opt flex min-h-11 items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-nav text-foreground transition-colors duration-fast ease-out-soft hover:bg-accent/70 active:bg-accent motion-reduce:transition-none"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "relative size-4 shrink-0 rounded-full",
                    choice === option
                      ? "bg-foreground after:absolute after:inset-[5px] after:rounded-full after:bg-background"
                      : "shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground)/0.7)]"
                  )}
                />
                <span className="min-w-0 flex-1">{option}</span>
              </button>
            ))}
            {current && (
              <button
                type="button"
                onClick={answerInComposer}
                className="flex min-h-9 items-center gap-3 rounded-md px-2.5 text-left text-nav text-foreground/75 transition-colors duration-fast ease-out-soft hover:bg-accent/70 motion-reduce:transition-none"
              >
                <span aria-hidden="true" className="size-4 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground)/0.7)]" />
                Something else
              </button>
            )}
          </div>
          <div className="mt-2 flex justify-end">
            <VerbButton
              label="Continue"
              armed={choice !== null && !busy}
              busy={busy}
              onClick={() => choice && onAnswer(question.id, choice)}
            />
          </div>
        </>
      ) : current ? (
        <div className="mt-2.5">
          <QuietButton onClick={answerInComposer} aria-label="Answer in the message box below">
            Answer below
          </QuietButton>
        </div>
      ) : (
        <p className="mt-1.5 text-ui text-muted-foreground">Answer the question above it first; this one is next.</p>
      )}
    </div>
  );
}

function TerminalRun({
  session,
  run,
  work,
  spoken,
  actor,
}: {
  session: ClientWorkSession;
  run: ClientWorkRun | null;
  work: ConversationWork;
  spoken: ReturnType<typeof deriveTurns>;
  actor?: string | null;
}) {
  const performed = React.useMemo(() => derivePerformedActions(work.events), [work.events]);
  // What it did, as sentences named after whoever did it; the team's members
  // when it was a team. Event kinds and tool names stay behind Details.
  const activity = React.useMemo(() => {
    const team = teamMemberLines(work.events);
    return team.length > 0 ? team : workSummaryLines(work.events, actor ?? PRODUCT_NAME).filter((line) => line.tone !== "attention");
  }, [work.events, actor]);
  // Anything that is not a clean finish — failed, cancelled, interrupted, a Mac
  // that went away. The digest is written for a failure and is just as much use
  // on a cancel: how far it got and whether it left anything behind are the two
  // facts somebody decides what to do next on, and "completed" is the only
  // status where neither question is open.
  const incomplete = session.status !== "completed";
  return (
    <div className="space-y-3 px-4 pb-4 empty:hidden @[30rem]:pl-12">
      {/* Why it ended, in the executor's own words where it left any. The
          status sentence in the header says what happened; this says what it
          means for the reader, and it is the sentence that explains a
          disappointing result. */}
      {run?.terminalDetail != null && run.terminalReason !== "completed" && (
        <p className="text-ui leading-relaxed text-foreground">
          {run.terminalDetail}
        </p>
      )}
      {run !== null && run.degradation.length > 0 && (
        <DegradationNotes degradation={run.degradation} />
      )}

      {/* The digest leads, because it is what a reader decides on. */}
      {incomplete && run !== null && (
        <div>
          <WorkOutcomeDigest run={run} plan={work.plan} performed={performed} />
        </div>
      )}

      <ActivityLines lines={activity} label={isTeamActivity(work.events) ? "The team" : "What it did"} />

      <RunWords spoken={spoken} />

      {/* The thing the task was started for, in full, rather than behind a
          button. `WorkDeliverableStage` renders nothing when the run produced
          no previewable file — and `empty:hidden` is what keeps that "nothing"
          from still costing this stack a 12px gap, because `space-y` puts a
          margin on an empty box exactly as readily as on a full one. */}
      <div className="empty:hidden">
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
        <div>
          <CaptureSkillButton session={session} plan={work.plan} performed={performed} />
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
    <div>
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
