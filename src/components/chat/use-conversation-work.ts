"use client";

import * as React from "react";
import { toast } from "sonner";
import { isTerminalStatus } from "@/lib/work/domain";
import {
  adoptDiscoveredSession,
  delegatedComposerMode,
  type DelegatedComposerMode,
} from "@/lib/work/delegation";
import type { ClientWorkEvent, ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import {
  WORK_SYNC_EVENT,
  answerWorkQuestion,
  controlWorkRun,
  decideWorkApproval,
  fetchConversationTasks,
  fetchWorkSessions,
  startWorkSessionRun,
  steerWorkRun,
  subscribeToWorkEvents,
  workIdempotencyKey,
  type WorkApprovalDecisionInput,
} from "@/components/work/work-transport";
import { mergeDiscoveredTasks, nextDiscoveryDelay, shouldResubscribe } from "@/lib/work/conversation-tasks";
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
import { PRODUCT_NAME } from "@/lib/brand/names";

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
 * SEVERAL TASKS, EACH FOLLOWED ONCE. A conversation can carry several live
 * tasks now (up to `MAX_LIVE_TASKS_PER_CONVERSATION`): the person's request, a
 * routine that fired in a crew member's thread, a hand-off it took.
 * `useConversationWorkSessions` discovers every task the conversation draws
 * (`GET /api/conversations/{id}/tasks`: all live ones plus the newest finished
 * one), and each card follows its own task with `useWorkSessionFollower`, one
 * stream and one cursor per task. A finished task's stream is a one-shot read:
 * the server sends the snapshot and a `done` frame and closes it. Older
 * finished tasks still leave the transcript on reload, as before; a task the
 * page has already drawn is never taken away while it is open.
 *
 * `useConversationWork` keeps the old contract (follow the newest task) for the
 * one caller that wants exactly that, the computer overlay.
 *
 * A NEW ATTEMPT IN THE SAME TASK IS FOLLOWED TOO. The stream ends on its
 * `done` frame, and the card used to reopen it only when the session id
 * changed, so a routine re-firing in the same session, or a Retry, left the
 * plan and events frozen on the old run under a header showing the new status.
 * The follower now reopens the stream when discovery says the task moved on
 * after the stream's last word (`shouldResubscribe`), and when the card itself
 * starts another attempt; the first frame re-bases on the current run.
 *
 * DISCOVERY ASKS ONLY AS OFTEN AS IT HAS TO. Four seconds while a task is live
 * or something just changed, backing off to thirty when nothing is; not at all
 * while the tab is hidden; once straight away on coming back, on focus and on
 * any Work mutation (`startDiscoveryLoop`, `nextDiscoveryDelay`). The model's
 * own task never waits for it: the chat stream's `work` frame adopts it.
 */

/**
 * The discovery loop: ask, wait as long as `nextDiscoveryDelay` says, ask
 * again. Stops while the tab is hidden and asks once on the way back, and
 * asks at once on window focus and on `WORK_SYNC_EVENT`. `discover` reports
 * whether the answer changed and whether anything is live, or null when the
 * read failed (which backs off like a quiet answer). Returns the cleanup.
 */
function startDiscoveryLoop(
  discover: () => Promise<{ changed: boolean; anyLive: boolean } | null>
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay: number | null = null;
  let inFlight = false;
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

  const tick = async () => {
    if (cancelled || inFlight) return;
    // Hidden: nothing is scheduled; `wake` asks again when the tab returns.
    if (hidden()) return;
    inFlight = true;
    const outcome = await discover().catch(() => null);
    inFlight = false;
    if (cancelled) return;
    delay = nextDiscoveryDelay({
      previousMs: delay,
      changed: outcome?.changed ?? false,
      anyLive: outcome?.anyLive ?? false,
    });
    clearTimeout(timer);
    if (!hidden()) timer = setTimeout(() => void tick(), delay);
  };
  const wake = () => {
    if (cancelled || hidden()) return;
    clearTimeout(timer);
    delay = null;
    void tick();
  };

  if (typeof window !== "undefined") {
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener(WORK_SYNC_EVENT, wake);
  }
  void tick();
  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (typeof window !== "undefined") {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener(WORK_SYNC_EVENT, wake);
    }
  };
}

/** What the finished card's buttons ask for. */
export type WorkStartAgainKind = "retry" | "run_again" | "continue";

export type WorkStartAgainOutcome =
  | { kind: "started" }
  /** The route quoted a cost above the bar; ask, then call again with `confirmExpensive`. */
  | { kind: "confirm"; estimatedCostMicroUsd: number }
  /** Refused or failed, already said in a toast. */
  | { kind: "refused" };

export interface ConversationWorkActions {
  /** Pauses the running attempt. True when the server took it. */
  pause: () => Promise<boolean>;
  /** Resumes an attempt a person paused. True when the server took it. */
  resume: () => Promise<boolean>;
  /** Another attempt at the task: Retry, Run again, or Continue with the card's brief. */
  startAgain: (
    kind: WorkStartAgainKind,
    options?: { continuation?: string; confirmExpensive?: boolean }
  ) => Promise<WorkStartAgainOutcome>;
}

export interface ConversationWorkSteering {
  /** What send does right now: answer the open question, or steer. */
  mode: DelegatedComposerMode;
  /** Resolves true only when the server took it; the draft clears only then. */
  send: (text: string) => Promise<boolean>;
  /**
   * Ends the attempt. Terminal: its progress is not kept. Resolves true when
   * the server took the cancel (the stream then carries the new status), and
   * false after saying why it did not.
   */
  stop: () => Promise<boolean>;
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
   * Shows a task the model has just started from this chat (the stream's
   * `work` frame), before the poll would find it. Without this the reply says
   * "I started a task" and the transcript shows nothing for up to four
   * seconds, which is the one moment the reader is most certain something
   * should be there.
   */
  adopt: (session: ClientWorkSession) => void;
  /**
   * `lost` when the run's stream stopped for a reason it will not retry on its
   * own (signed out, refused, gone): the card says so and offers Reconnect
   * instead of freezing on the last frame. Absent on hand-built fixtures.
   */
  connection?: "live" | "lost";
  /** Opens the stream again from its cursor. */
  reconnect?: () => void;
  /** Pause, Resume and the finished card's new attempts. Absent on fixtures. */
  actions?: ConversationWorkActions;
}

/**
 * The newest task on a conversation, followed. The contract every caller had
 * before a conversation could carry several tasks; the computer overlay still
 * wants exactly this, and a chat view draws every task with
 * `useConversationWorkSessions` instead.
 */
export function useConversationWork(conversationId: string | null): ConversationWork {
  const [newest, setNewest] = React.useState<ClientWorkSession | null>(null);
  /*
   * Bumped by every `adopt`. A discovery answer is only applied when none
   * happened while it was in flight: one that left before the task existed
   * says this chat has no task (or only an older one), and landing after the
   * stream's `work` frame it would take the new panel off the screen until the
   * next poll put it back.
   */
  const adoptions = React.useRef(0);

  const newestRef = React.useRef<ClientWorkSession | null>(null);
  newestRef.current = newest;

  React.useEffect(() => {
    setNewest(null);
    if (!conversationId) return;

    let cancelled = false;
    const discover = async () => {
      const asked = adoptions.current;
      const result = await fetchWorkSessions({ conversationId, limit: 1 });
      if (cancelled || result.kind !== "ok") return null;
      // An adoption overtook this answer: it may predate the adopted task, so
      // none of it is applied (not even the same-task refresh below, which
      // could read a stale `newestRef` before the adoption has rendered). The
      // next read comes quickly.
      if (asked !== adoptions.current) return { changed: true, anyLive: true };
      const before = newestRef.current;
      // Only when it is genuinely a different task, and never a draft. Writing
      // the same row back on every read would re-render the panel — and the
      // composer — on a timer, for a fact that did not change; the draft rule
      // is argued over `adoptDiscoveredSession`.
      const found = result.value[0] ?? null;
      let after = adoptDiscoveredSession(before, found);
      // The same task, touched since: handed on so the follower can tell a new
      // attempt from the one it finished following (`shouldResubscribe`). The
      // follower never resets its cursor for the same id, so this is safe.
      if (after === before && before && found && found.id === before.id && found.updatedAt !== before.updatedAt) {
        after = found;
      }
      if (after !== before) setNewest(after);
      return { changed: after !== before, anyLive: found !== null && !isTerminalStatus(found.status) };
    };
    const stop = startDiscoveryLoop(discover);
    return () => {
      cancelled = true;
      stop();
    };
  }, [conversationId]);

  const follower = useWorkSessionFollower(newest);
  const followerAdopt = follower.adopt;
  const adopt = React.useCallback(
    (next: ClientWorkSession) => {
      adoptions.current += 1;
      setNewest((current) => (current?.id === next.id ? current : next));
      followerAdopt(next);
    },
    [followerAdopt]
  );
  return React.useMemo(() => ({ ...follower, adopt }), [follower, adopt]);
}

/**
 * One task, followed: its event stream with a resume cursor, and everything the
 * card and the composer derive from it.
 *
 * `initial` is the row discovery found (or the stream's `work` frame handed
 * over). The stream's own frames replace it from then on, because they are the
 * authoritative read; a later discovery row replaces it only when it is newer,
 * which covers the moment before the stream's first frame.
 */
export function useWorkSessionFollower(initial: ClientWorkSession | null): ConversationWork {
  const [session, setSession] = React.useState<ClientWorkSession | null>(initial);
  const [run, setRun] = React.useState<ClientWorkRun | null>(null);
  const [events, setEvents] = React.useState<ClientWorkEvent[]>([]);
  const [busy, setBusy] = React.useState(false);

  const sessionId = session?.id ?? null;
  const sessionIdRef = React.useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const sessionRef = React.useRef<ClientWorkSession | null>(null);
  sessionRef.current = session;

  /*
   * Which subscription this is. Bumped to reopen the stream for the same task:
   * a new attempt discovery found after the stream's `done`, one the card just
   * started, or a Reconnect. `streamEnded` is set by the stream's own end, so
   * a discovery row is only read as "a new attempt" once the old one is over.
   */
  const [epoch, setEpoch] = React.useState(0);
  const streamEnded = React.useRef(false);
  const [connection, setConnection] = React.useState<"live" | "lost">("live");

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

  // A different task handed in (a card re-used for another row, or the newest
  // task changing under `useConversationWork`) starts over: its cursor, run and
  // events belong to the old one. The same task arriving again only refreshes
  // the row when it is newer than what the stream already said.
  React.useEffect(() => {
    if (!initial) {
      if (sessionIdRef.current !== null) {
        cursor.current = { runId: null, after: 0 };
        streamEnded.current = false;
        setEvents([]);
        setRun(null);
        setSession(null);
        setConnection("live");
      }
      return;
    }
    if (initial.id !== sessionIdRef.current) {
      cursor.current = { runId: null, after: 0 };
      streamEnded.current = false;
      setEvents([]);
      setRun(null);
      setSession(initial);
      setConnection("live");
      return;
    }
    // The same task, finished following, has moved on: a routine fired again
    // in this session, or another client retried it. Reopen the stream; its
    // first frame re-bases on the current attempt.
    if (shouldResubscribe({ streamEnded: streamEnded.current, followed: sessionRef.current, discovered: initial })) {
      streamEnded.current = false;
      setEpoch((value) => value + 1);
    }
    setSession((current) =>
      current && Date.parse(initial.updatedAt) > Date.parse(current.updatedAt) ? initial : current
    );
  }, [initial]);

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

  // The run's own events. Opened once there is a task to follow, and closed
  // again when the conversation moves. A finished run closes the stream from the
  // server with a `done` frame; it is reopened only when the task moves on
  // (`epoch`, above): a new attempt, or a Reconnect.
  React.useEffect(() => {
    if (sessionId === null) return;
    streamEnded.current = false;
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
      // A finished run is the normal end. Anything else that stops the stream
      // for good (signed out, refused, gone) used to leave the card frozen on
      // its last frame, reading as a task that had stalled; now the card says
      // it lost the connection and offers Reconnect. The chat is never broken
      // by it.
      onStopped: (outcome) => {
        streamEnded.current = true;
        if (outcome.kind !== "finished") setConnection("lost");
      },
    });
  }, [sessionId, epoch, mergeEvents]);

  const reconnect = React.useCallback(() => {
    streamEnded.current = false;
    setConnection("live");
    setEpoch((value) => value + 1);
  }, []);

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
        // Kept, but not carrying on yet: the server says what it is waiting for.
        if (!result.value.resumed && result.value.explanation) toast(result.value.explanation);
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return true;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : `Couldn’t send that answer, so ${PRODUCT_NAME} hasn’t seen it. Try again.`
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
        // Kept, but not carrying on yet: the server says what it is waiting for.
        if (!result.value.resumed && result.value.explanation) toast(result.value.explanation);
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return true;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : `Couldn’t record your decision, so ${PRODUCT_NAME} has not acted on it. Try again.`
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
      stop: async () => {
        // There IS a window where the panel is up and this is null: between
        // `adopt` putting the session on screen and the first SSE frame naming
        // the run. A press in it used to return silently, which on a control
        // labelled "Stop the task" reads as a stop that worked.
        if (run === null) {
          toast.error("This task hasn’t reported in yet, so there is nothing to stop. Try again in a moment.");
          return false;
        }
        const result = await controlWorkRun(run.id, "cancel");
        if (result.kind === "ok") {
          setRun(result.value);
          window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
          return true;
        }
        toast.error(
          result.kind === "blocked"
            ? result.explanation
            : `Couldn’t reach ${PRODUCT_NAME} to stop that. The task is still going.`
        );
        return false;
      },
    };
  }, [mode, sessionId, answer, steer, run]);

  /** Pause or resume the attempt on screen, with the server's refusal said aloud. */
  const control = React.useCallback(
    async (action: "pause" | "resume"): Promise<boolean> => {
      if (run === null) {
        toast.error("This task hasn’t reported in yet. Try again in a moment.");
        return false;
      }
      const result = await controlWorkRun(run.id, action);
      if (result.kind === "ok") {
        setRun(result.value);
        setSession((current) => (current ? { ...current, status: result.value.status } : current));
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return true;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : action === "pause"
            ? `Couldn’t reach ${PRODUCT_NAME} to pause that. The task is still going.`
            : `Couldn’t reach ${PRODUCT_NAME} to resume that. It is still paused.`
      );
      return false;
    },
    [run]
  );

  /**
   * Another attempt at this task: Retry (same brief, after a failure), Run
   * again (after a success) or Continue (a new attempt told where the last one
   * stopped). The stream is reopened at once so the card follows the new run
   * rather than waiting for discovery to notice it.
   */
  const startAgain = React.useCallback(
    async (
      kind: WorkStartAgainKind,
      options: { continuation?: string; confirmExpensive?: boolean } = {}
    ): Promise<WorkStartAgainOutcome> => {
      if (sessionId === null) return { kind: "refused" };
      const continuing = kind === "continue" && run !== null && !!options.continuation;
      const result = await startWorkSessionRun(sessionId, {
        origin: kind === "retry" ? "retry" : kind === "continue" ? "resume" : "manual",
        idempotencyKey: workIdempotencyKey(),
        ...(continuing ? { continueFromRunId: run!.id, continuation: options.continuation } : {}),
        ...(options.confirmExpensive ? { confirmExpensive: true } : {}),
      });
      if (result.kind === "ok") {
        // The last attempt's plan and events belong to it; the new stream's
        // snapshot fills the card again from the new attempt's first event.
        cursor.current = { runId: null, after: 0 };
        setEvents([]);
        setRun(result.value);
        setSession((current) => (current ? { ...current, status: result.value.status } : current));
        streamEnded.current = false;
        setConnection("live");
        setEpoch((value) => value + 1);
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return { kind: "started" };
      }
      if (result.kind === "blocked" && result.confirmation?.kind === "expensive_work") {
        return { kind: "confirm", estimatedCostMicroUsd: result.confirmation.estimatedCostMicroUsd };
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : (result.message ?? `Couldn’t start that again. Nothing was started, so trying again is safe.`)
      );
      return { kind: "refused" };
    },
    [sessionId, run]
  );

  const actions = React.useMemo<ConversationWorkActions>(
    () => ({ pause: () => control("pause"), resume: () => control("resume"), startAgain }),
    [control, startAgain]
  );

  const adopt = React.useCallback((next: ClientWorkSession) => {
    // Already following it: the discovery poll found the row first, or a
    // reconnected stream replayed the frame. Resetting here would clear the
    // events while the open stream carried on from its cursor, and the panel
    // would lose everything the run had said so far.
    if (sessionIdRef.current === next.id) return;
    cursor.current = { runId: null, after: 0 };
    streamEnded.current = false;
    setEvents([]);
    setRun(null);
    setSession(next);
    setConnection("live");
  }, []);

  // One object per change, not per render: the chat view keeps each card's
  // follower beside the composer, and a new identity every render would loop.
  return React.useMemo(
    () => ({
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
      connection,
      reconnect,
      actions,
    }),
    [session, run, events, plan, questions, openApprovals, currentAction, pendingSteers, documents, busy, steering, decide, answer, adopt, connection, reconnect, actions]
  );
}

export interface ConversationWorkSessions {
  /** Every task the conversation draws, oldest first: the order the cards stack in. */
  sessions: ClientWorkSession[];
  /**
   * Draws a task the model has just started from this chat (the stream's
   * `work` frame) before the poll would find it.
   */
  adopt: (session: ClientWorkSession) => void;
}

/**
 * Which tasks a conversation draws. Discovery only: each task's run is
 * followed by its own card (`useWorkSessionFollower`).
 *
 * A task the page has drawn is never taken away by a later answer that no
 * longer lists it (`mergeDiscoveredTasks`); only moving to another
 * conversation clears the list.
 */
export function useConversationWorkSessions(conversationId: string | null): ConversationWorkSessions {
  const [sessions, setSessions] = React.useState<ClientWorkSession[]>([]);
  const sessionsRef = React.useRef<ClientWorkSession[]>([]);
  sessionsRef.current = sessions;

  React.useEffect(() => {
    setSessions([]);
    sessionsRef.current = [];
    if (!conversationId) return;
    let cancelled = false;
    // Adaptive, not a fixed four seconds for ever: see `startDiscoveryLoop`.
    const stop = startDiscoveryLoop(async () => {
      const result = await fetchConversationTasks(conversationId);
      if (cancelled || result.kind !== "ok") return null;
      const before = sessionsRef.current;
      const after = mergeDiscoveredTasks(before, result.value);
      if (after !== before) {
        sessionsRef.current = after;
        setSessions(after);
      }
      return { changed: after !== before, anyLive: after.some((row) => !isTerminalStatus(row.status)) };
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [conversationId]);

  const adopt = React.useCallback((next: ClientWorkSession) => {
    if (next.status === "draft") return;
    setSessions((current) => mergeDiscoveredTasks(current, [next]));
  }, []);

  return { sessions, adopt };
}
