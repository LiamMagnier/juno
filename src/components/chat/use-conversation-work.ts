"use client";

import * as React from "react";
import { toast } from "sonner";
import { isTerminalStatus } from "@/lib/work/domain";
import { delegatedComposerMode, type DelegatedComposerMode } from "@/lib/work/delegation";
import type { ClientWorkEvent, ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import {
  WORK_SYNC_EVENT,
  answerWorkQuestion,
  controlWorkRun,
  decideWorkApproval,
  fetchWorkSessions,
  steerWorkRun,
  subscribeToWorkEvents,
  type WorkApprovalDecisionInput,
} from "@/components/work/work-transport";
import { derivePendingSteers, type PendingSteer } from "@/components/work/steering/pending-steers";
import {
  deriveApprovals,
  deriveOpenQuestions,
  type OpenQuestion,
  type WorkApprovalCard,
} from "@/components/work/work-decisions";
import {
  deriveCurrentAction,
  derivePlan,
  type CurrentAction,
  type PlanStep,
} from "@/components/work/work-timeline";
import { useWorkArtifactList, type WorkArtifactList } from "@/components/work/work-documents";
import { deriveArtifacts } from "@/components/work/work-detail-panels";

/**
 * The delegated task attached to a conversation, followed once.
 *
 * This is `useConversationResearch`'s shape for the other kind of run, and the
 * reason it is shaped that way is the same: two components now need the run and
 * they sit a row apart. The panel in the transcript DRAWS it, the composer at
 * the bottom ANSWERS and STEERS it, and each of them opening its own stream
 * would be two event cursors for one run — and a cursor is the one piece of
 * state that must not be duplicated, because each copy re-reads from wherever
 * the other left off. So the owner is whoever renders both, which is the chat
 * view, and this hook is what it owns.
 *
 * DISCOVERY IS A POLL, THE RUN IS A STREAM. `?conversationId=` answers "does
 * this chat have a task" and nothing else; it is cheap, it is indexed, and it
 * has to keep being asked because a task can be started from a phone while this
 * tab is open. Once there is one, its events come down the same SSE stream the
 * task page reads, with the same resume cursor — a poll at that granularity
 * would lose the run's own words between ticks.
 *
 * Nothing here decides what to DRAW. Every derivation below is one the task page
 * already performs over the same stream (`derivePlan`, `deriveOpenQuestions`,
 * `deriveApprovals`, …), imported rather than re-written, so a run in a
 * transcript and the same run on its own page cannot disagree about whether
 * something happened.
 *
 * ONE TASK, THE NEWEST. A conversation that has delegated twice draws the
 * second run and not the first, which is a real limitation and is stated here
 * rather than discovered: the alternative is one open SSE stream per historical
 * task in the transcript, and a chat somebody has worked out of for a week
 * would hold a dozen. Research solves this by re-fetching a finished run's
 * report on demand (`HistoricalResearchRunPanel`); a task has no equivalent
 * one-shot read yet — its state is the event stream — so the honest thing is to
 * follow the one that is still moving.
 */

/** How often a conversation re-asks whether it has a task. Research's interval. */
const DISCOVERY_POLL_MS = 4_000;

export interface ConversationWorkSteering {
  /** What send does right now: answer the open question, or steer. */
  mode: DelegatedComposerMode;
  /** Resolves true only when the server took it; the draft clears only then. */
  send: (text: string) => Promise<boolean>;
  /** Ends the attempt. Terminal — its progress is not kept. */
  stop: () => void;
}

export interface ConversationWork {
  session: ClientWorkSession | null;
  run: ClientWorkRun | null;
  events: ClientWorkEvent[];
  plan: PlanStep[];
  questions: OpenQuestion[];
  openApprovals: WorkApprovalCard[];
  currentAction: CurrentAction | null;
  pendingSteers: PendingSteer[];
  documents: WorkArtifactList;
  /** True while a send is in flight, so the panel's own buttons dim with it. */
  busy: boolean;
  /** Null when this conversation has no task, or its task takes nothing. */
  steering: ConversationWorkSteering | null;
  /** Answers one approval card from the panel. */
  decide: (
    approval: WorkApprovalCard,
    decision: WorkApprovalDecisionInput,
    reason?: string
  ) => Promise<boolean>;
  /** Answers a question with one of its own options, without typing. */
  answer: (questionId: string, text: string) => Promise<boolean>;
  /**
   * Shows a task the composer has just dispatched, before the poll would find
   * it. Without this the reader presses send and watches an empty transcript
   * for up to four seconds — the one moment they are most certain something
   * should have happened.
   */
  adopt: (session: ClientWorkSession) => void;
}

export function useConversationWork(conversationId: string | null): ConversationWork {
  const [session, setSession] = React.useState<ClientWorkSession | null>(null);
  const [run, setRun] = React.useState<ClientWorkRun | null>(null);
  const [events, setEvents] = React.useState<ClientWorkEvent[]>([]);
  const [busy, setBusy] = React.useState(false);

  const sessionId = session?.id ?? null;

  /*
   * The resume cursor, both halves, in a ref.
   *
   * `seq` is unique per RUN rather than per session, so the run id travels with
   * it: the events route ignores an `after` that belongs to a different attempt,
   * and a cursor read from a captured value would replay the whole run from zero
   * after every reconnect. Copied from the task page deliberately — it is the
   * same stream with the same contract.
   */
  const cursor = React.useRef<{ runId: string | null; after: number }>({ runId: null, after: 0 });

  const mergeEvents = React.useCallback((incoming: readonly ClientWorkEvent[]) => {
    if (incoming.length === 0) return;
    setEvents((current) => {
      const seen = new Set(current.map((event) => event.id));
      const added = incoming.filter((event) => !seen.has(event.id));
      if (added.length === 0) return current;
      return [...current, ...added].sort((a, b) => a.seq - b.seq);
    });
    for (const event of incoming) {
      cursor.current.after = Math.max(cursor.current.after, event.seq);
    }
  }, []);

  // Discovery. Everything is dropped when the conversation changes, including
  // the cursor: a seq from the previous chat's run would have the stream resume
  // this one from the middle of a transcript that belongs to somebody else's
  // errand.
  React.useEffect(() => {
    setSession(null);
    setRun(null);
    setEvents([]);
    cursor.current = { runId: null, after: 0 };
    if (!conversationId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const discover = async () => {
      const result = await fetchWorkSessions({ conversationId, limit: 1 });
      if (!cancelled && result.kind === "ok") {
        const newest = result.value[0] ?? null;
        // Only when it is genuinely a different task. Writing the same row back
        // every four seconds would re-render the panel — and the composer — on
        // a timer, for a fact that did not change.
        setSession((current) => (current?.id === newest?.id ? current : newest));
      }
      if (!cancelled) timer = setTimeout(discover, DISCOVERY_POLL_MS);
    };
    void discover();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [conversationId]);

  // The run's own events. Opened once there is a task to follow, and closed
  // again when the conversation moves. A finished run closes the stream from the
  // server with a `done` frame and is not reopened: it is over, and there is
  // nothing further to hear.
  React.useEffect(() => {
    if (sessionId === null) return;
    return subscribeToWorkEvents(sessionId, {
      cursor: () => cursor.current,
      onFrame: (frame) => {
        setSession(frame.session);
        setRun(frame.run);
        if (frame.type === "done") return;
        // A snapshot for a run this hook was not already following means the
        // server re-based — a first connection, or a newer attempt whose seqs
        // start again at 1. Keeping the old attempt's events would interleave
        // two runs under one numbering. A snapshot for the SAME run is a resume
        // carrying only the delta and must not clear anything.
        const frameRunId = frame.run?.id ?? null;
        if (frame.type === "snapshot" && frameRunId !== cursor.current.runId) {
          cursor.current = { runId: frameRunId, after: 0 };
          setEvents([]);
        }
        if (frameRunId !== null) cursor.current.runId = frameRunId;
        mergeEvents(frame.events);
      },
      // A conversation whose run cannot be followed simply stops updating. This
      // is an addition to a chat and is never a reason to break one, so there is
      // no error state here: the panel keeps the last frame it had, and the task
      // page is where a reader goes to find out why.
      onStopped: () => {},
    });
  }, [sessionId, mergeEvents]);

  const plan = React.useMemo(() => derivePlan(events), [events]);
  const questions = React.useMemo(() => deriveOpenQuestions(events), [events]);
  const approvals = React.useMemo(() => deriveApprovals(events), [events]);
  const artifacts = React.useMemo(() => deriveArtifacts(events), [events]);
  const pendingSteers = React.useMemo(() => derivePendingSteers(events), [events]);
  const live = session !== null && !isTerminalStatus(session.status);
  const currentAction = React.useMemo(
    () => (live ? deriveCurrentAction(events) : null),
    [events, live]
  );
  const openApprovals = React.useMemo(
    () => approvals.filter((approval) => approval.decision === "pending"),
    [approvals]
  );
  const documents = useWorkArtifactList(sessionId ?? "", artifacts.length, run !== null);

  const answer = React.useCallback(
    async (questionId: string, text: string): Promise<boolean> => {
      if (sessionId === null) return false;
      setBusy(true);
      const result = await answerWorkQuestion(sessionId, questionId, text);
      setBusy(false);
      if (result.kind === "ok") {
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return true;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : "Couldn’t send that answer, so Juno hasn’t seen it. Try again."
      );
      return false;
    },
    [sessionId]
  );

  /**
   * An instruction that answers nothing.
   *
   * The server's own sentence about what it did with it is what gets shown. A
   * cloud run reads the instruction before its next step and a run on a Mac does
   * not, and the route is the only side that knows which of the two this is; a
   * "Sent" written here would be the chat inventing a promise on behalf of an
   * executor it cannot see.
   */
  const steer = React.useCallback(
    async (text: string): Promise<boolean> => {
      if (sessionId === null) return false;
      setBusy(true);
      const result = await steerWorkRun(sessionId, text);
      setBusy(false);
      if (result.kind === "ok") {
        toast.success(result.value.explanation);
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return true;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : "Couldn’t add that to the task. Nothing was recorded."
      );
      return false;
    },
    [sessionId]
  );

  const decide = React.useCallback(
    async (
      approval: WorkApprovalCard,
      decision: WorkApprovalDecisionInput,
      reason?: string
    ): Promise<boolean> => {
      // Guaranteed non-null by the card, which removes its own buttons when the
      // request arrived without a digest. Re-checked because the alternative is
      // a 400 the reader reads as a bug.
      if (approval.actionDigest === null) return false;
      setBusy(true);
      const result = await decideWorkApproval(
        approval.id,
        approval.actionDigest,
        decision,
        reason
      );
      setBusy(false);
      if (result.kind === "ok") {
        // Nothing is patched into local state: the server appends an
        // `approval_resolved` event as part of recording the decision and the
        // stream is a second away. An optimistic answer here would be a second
        // source for the same fact, and it would win on screen even where the
        // server had refused.
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return true;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : "Couldn’t record your decision, so Juno has not acted on it. Try again."
      );
      return false;
    },
    []
  );

  const openQuestion = questions[0] ?? null;
  const mode = React.useMemo(
    () =>
      delegatedComposerMode({
        status: session?.status ?? null,
        openQuestion,
      }),
    [session?.status, openQuestion]
  );

  const steering = React.useMemo<ConversationWorkSteering | null>(() => {
    if (mode === null || sessionId === null) return null;
    return {
      mode,
      send: (text: string) =>
        mode.kind === "answer" ? answer(mode.questionId, text) : steer(text),
      stop: () => {
        if (run === null) return;
        void controlWorkRun(run.id, "cancel").then((result) => {
          if (result.kind === "ok") {
            setRun(result.value);
            window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
            return;
          }
          toast.error(
            result.kind === "blocked"
              ? result.explanation
              : "Couldn’t reach Juno to stop that. The task is still going."
          );
        });
      },
    };
  }, [mode, sessionId, answer, steer, run]);

  const adopt = React.useCallback((next: ClientWorkSession) => {
    cursor.current = { runId: null, after: 0 };
    setEvents([]);
    setRun(null);
    setSession(next);
  }, []);

  return {
    session,
    run,
    events,
    plan,
    questions,
    openApprovals,
    currentAction,
    pendingSteers,
    documents,
    busy,
    steering,
    decide,
    answer,
    adopt,
  };
}
