"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { QuietButton, VerbButton } from "@/components/chat/decision";
import type { ConversationWork, WorkStartAgainKind } from "@/components/chat/use-conversation-work";
import type { ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import {
  continuationBrief,
  finishedTaskActions,
  liveTaskControl,
  type FinishedTaskAction,
} from "@/lib/work/continuation";
import { proposalFromTask } from "@/lib/work/routine-proposal";
import { formatMicroUsdAmount } from "@/lib/budgets";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * What a task card offers besides Stop.
 *
 *   while it works      Pause                                     Stop
 *   paused by a person  Resume                                    Stop
 *   finished, failed    [Continue]  Retry
 *   finished, done      [Run again]  Make a routine
 *   lost the stream     Disconnected · Reconnect
 *
 * Every press goes through the same routes a first start does (dispatch: plan,
 * window, caps, the cost preflight), and a cost above the bar is asked about
 * here, in one line, before anything starts. Continue is a new attempt told
 * where the last one stopped (src/lib/work/continuation.ts), not a restore.
 * Make a routine opens the chat's routine card on Edit, seeded from the task.
 */

// Loaded on the press of Make a routine, not with every task card: it brings
// the schedule reader and the routine shapes, which a card that is never
// turned into a routine has no use for.
const RoutineProposalCard = nextDynamic(
  () => import("@/components/chat/routine-proposal-card").then((m) => m.RoutineProposalCard),
  { ssr: false },
);

const LABELS: Record<FinishedTaskAction, string> = {
  continue: "Continue",
  retry: "Retry",
  run_again: "Run again",
  make_routine: "Make a routine",
};

/** Pause while it works, Resume when a person paused it. Sits beside Stop. */
export function TaskLiveControl({ work }: { work: ConversationWork }) {
  const [pending, setPending] = React.useState(false);
  const session = work.session;
  const status = session?.status ?? null;
  const control =
    session && status && work.actions
      ? liveTaskControl({ status, waitingOnPerson: work.questions.length > 0 || work.openApprovals.length > 0 })
      : null;
  // Released when the status moves (the header then shows the other control),
  // not when the request returns, so it never comes back to life in the gap.
  React.useEffect(() => setPending(false), [status]);
  if (control === null || !work.actions) return null;
  const actions = work.actions;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      loading={pending}
      aria-label={control === "pause" ? "Pause the task" : "Resume the task"}
      onClick={() => {
        setPending(true);
        void (control === "pause" ? actions.pause() : actions.resume()).then((ok) => {
          if (!ok) setPending(false);
        });
      }}
      className="px-2.5 font-normal text-muted-foreground hover:text-foreground"
    >
      {control === "pause" ? "Pause" : "Resume"}
    </Button>
  );
}

/** The stream stopped for good without the run finishing: say so, offer Reconnect. */
export function TaskConnectionNotice({ work, className }: { work: ConversationWork; className?: string }) {
  if (work.connection !== "lost" || !work.reconnect) return null;
  const reconnect = work.reconnect;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5 text-ui text-muted-foreground", className)} role="status">
      <span>Disconnected, so this card stopped updating.</span>
      <button
        type="button"
        onClick={reconnect}
        className="rounded-control text-muted-foreground underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline coarse:min-h-11"
      >
        Reconnect
      </button>
    </p>
  );
}

/** The finished card's next steps. Renders nothing for a task with none, or a fixture without actions. */
export function FinishedTaskActions({
  work,
  session,
  run,
}: {
  work: ConversationWork;
  session: ClientWorkSession;
  run: ClientWorkRun | null;
}) {
  const [busy, setBusy] = React.useState<WorkStartAgainKind | null>(null);
  const [confirm, setConfirm] = React.useState<{ kind: WorkStartAgainKind; estimate: number } | null>(null);
  const [routineOpen, setRoutineOpen] = React.useState(false);
  const closeRoutine = React.useCallback(() => setRoutineOpen(false), []);

  const files = React.useMemo(() => (work.documents.artifacts ?? []).map((artifact) => artifact.title), [work.documents.artifacts]);
  const progressed = work.plan.some((step) => step.state === "done") || files.length > 0;
  const fromRoutine = run !== null && (run.scheduleId !== null || run.origin === "schedule" || run.origin === "trigger");
  const offered = finishedTaskActions({
    status: session.status,
    terminalReason: run?.terminalReason ?? null,
    progressed,
    fromRoutine,
  });

  const proposal = React.useMemo(() => {
    let zone = "UTC";
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      zone = "UTC";
    }
    return proposalFromTask({ sessionId: session.id, title: session.title, goal: session.goal, timezone: zone, now: new Date() });
  }, [session.id, session.title, session.goal]);

  if (!work.actions || offered.length === 0) return null;
  const actions = work.actions;

  const start = async (kind: WorkStartAgainKind, confirmExpensive = false) => {
    setBusy(kind);
    const continuation =
      kind === "continue"
        ? continuationBrief({ plan: work.plan, files, terminalDetail: run?.terminalDetail ?? null })
        : undefined;
    const outcome = await actions.startAgain(kind, { continuation, confirmExpensive });
    setBusy(null);
    if (outcome.kind === "confirm") setConfirm({ kind, estimate: outcome.estimatedCostMicroUsd });
    else setConfirm(null);
  };

  const [lead, ...rest] = offered;
  const press = (action: FinishedTaskAction) => {
    if (action === "make_routine") {
      setRoutineOpen((open) => !open);
      return;
    }
    void start(action);
  };

  return (
    <div className="space-y-3">
      <AnimatePresence mode="popLayout" initial={false}>
        {confirm ? (
          <motion.div
            key="confirm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: transition.base }}
            exit={{ opacity: 0, transition: transition.exit }}
            className="flex flex-wrap items-center gap-2"
          >
            <p className="mr-1 text-ui text-foreground">
              This run is estimated at about {formatMicroUsdAmount(confirm.estimate)}. Start it?
            </p>
            <VerbButton label="Start" armed={busy === null} busy={busy !== null} onClick={() => void start(confirm.kind, true)} />
            <QuietButton onClick={() => setConfirm(null)} disabled={busy !== null}>
              Cancel
            </QuietButton>
          </motion.div>
        ) : (
          <motion.div
            key="actions"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: transition.base }}
            exit={{ opacity: 0, transition: transition.exit }}
            className="flex flex-wrap items-center gap-2"
          >
            {lead === "make_routine" ? (
              <QuietButton aria-expanded={routineOpen} onClick={() => press(lead)}>
                {LABELS[lead]}
              </QuietButton>
            ) : (
              <VerbButton label={LABELS[lead]} armed={busy === null} busy={busy === lead} onClick={() => press(lead)} />
            )}
            {rest.map((action) => (
              <QuietButton
                key={action}
                onClick={() => press(action)}
                disabled={busy !== null && action !== "make_routine"}
                aria-expanded={action === "make_routine" ? routineOpen : undefined}
              >
                {LABELS[action]}
              </QuietButton>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <Collapse open={routineOpen}>
        <RoutineProposalCard proposal={proposal} startInEdit onClose={closeRoutine} className="bg-background/60" />
      </Collapse>
    </div>
  );
}
