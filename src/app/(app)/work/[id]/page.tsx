"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Pause, Play, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { isTerminalStatus } from "@/lib/work/domain";
import type {
  ClientWorkEvent,
  ClientWorkHost,
  ClientWorkRun,
  ClientWorkSession,
} from "@/lib/work/serializers";
import {
  WorkLiveMeter,
  WorkPlannedSettings,
  WorkRunSettings,
  deriveArtifacts,
  deriveReferences,
} from "@/components/work/work-detail-panels";
import {
  RAIL_ORDER,
  RAIL_POLICY,
  RailDisclosure,
  RailSection,
  WorkRunAnnouncer,
  deriveRunPhase,
  sectionTitle,
  type RailSectionName,
} from "@/components/work/detail/work-rail";
import { WorkAttempts } from "@/components/work/detail/work-attempts";
import { WorkContextSection } from "@/components/work/detail/work-context";
import { WorkOutcomeDigest } from "@/components/work/detail/work-outcome";
import { WorkOutputsSection } from "@/components/work/detail/work-outputs";
import { WorkProgressChecklist, planTally } from "@/components/work/detail/work-progress";
import { staggerDelay } from "@/lib/motion";
import {
  WorkConversation,
  deriveTurns,
  type WorkComposerMode,
} from "@/components/work/work-conversation";
import {
  WorkApprovalPrompt,
  WorkApprovals,
  WorkQuestionCard,
  deriveApprovals,
  deriveOpenQuestions,
  type WorkApprovalCard,
} from "@/components/work/work-decisions";
import {
  WorkActivity,
  WorkCurrentAction,
  deriveActivity,
  deriveCurrentAction,
  derivePerformedActions,
  derivePlan,
  type ActivityPhase,
} from "@/components/work/work-timeline";
import {
  WORK_SYNC_EVENT,
  answerWorkQuestion,
  controlWorkRun,
  decideWorkApproval,
  fetchWorkHosts,
  fetchWorkThread,
  startWorkRun,
  steerWorkRun,
  subscribeToWorkEvents,
  workIdempotencyKey,
  type WorkApprovalDecisionInput,
  type WorkBlocked,
  type WorkControlAction,
  type WorkTransportFailure,
} from "@/components/work/work-transport";
import {
  DegradationNotes,
  WorkStateNote,
  WorkStatusPill,
  statusSentence,
} from "@/components/work/work-vocabulary";

/**
 * One Work task, end to end.
 *
 * The split is deliberate and, on a narrow screen, is not a split at all: the
 * conversation is what you read, the right column is what you check, and on a
 * phone checking follows reading rather than competing with it. Two independent
 * scroll regions appear only once there is room for both to be worth having.
 *
 * Most of the right-hand column is a projection of one event list: the plan, the
 * approvals, the sources and the timeline are all derived here from the same
 * stream the resume cursor replays, so a panel and the timeline beside it can
 * never contradict each other about whether something happened.
 *
 * Two panels are not, and both earn it. Documents reads /api/work/artifacts,
 * because the stream says a file was written and only the store knows its size,
 * its hash and where the bytes are. Skills and apps reads /api/work/skills and
 * /api/connectors, because what this task may reach for is a fact about the
 * account and not about this run. Everything else stays derived.
 *
 * The page has no loading state that outlives an answer. A task nothing can
 * execute is refused at dispatch with a sentence, and that sentence is rendered
 * where a spinner would otherwise sit for ever.
 *
 * ── The rail ──────────────────────────────────────────────────────────────
 *
 * The right column is three questions and a footnote, always in this order:
 * Progress — how far did it get; Outputs — what did it make; Context — what
 * could it see and reach; How it ran — the model, the target and the budget
 * bars, which are reference rather than narrative and sit last and closed.
 *
 * The order does not vary. Only openness does, and `RAIL_POLICY` in
 * `detail/work-rail.tsx` is that judgement, written as a table so the whole
 * hierarchy can be read in one place. This page supplies the contents and the
 * counts; it does not decide the ranking.
 *
 * Everything subordinate — the activity feed, the decided approvals, the
 * actions that changed something outside Juno — is a disclosure inside the
 * section it belongs to rather than a panel beside it. That is the whole shape
 * of the rewrite: the eight sibling panels this replaced were eight true labels
 * and not one of them was a question anybody arrives with.
 *
 * Anything blocking on a person is lifted out of that rail entirely and rendered
 * as its own grid item — pinned above the reference panels on a desktop, and
 * above the conversation on a phone. It is one element in one place in the DOM,
 * placed by grid rather than duplicated per breakpoint, so there is never a
 * second copy of an Allow button to press by mistake.
 */
export default function WorkThreadPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [session, setSession] = React.useState<ClientWorkSession | null>(null);
  const [run, setRun] = React.useState<ClientWorkRun | null>(null);
  const [events, setEvents] = React.useState<ClientWorkEvent[]>([]);
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [blocked, setBlocked] = React.useState<WorkBlocked | null>(null);
  const [loadFailure, setLoadFailure] = React.useState<WorkTransportFailure["cause"] | null>(null);
  const [streamLost, setStreamLost] = React.useState(false);
  const [answering, setAnswering] = React.useState(false);
  const [busyApprovalId, setBusyApprovalId] = React.useState<string | null>(null);
  const [busyControl, setBusyControl] = React.useState(false);
  /**
   * Bumped to force the event stream to reconnect.
   *
   * The route closes the stream with a `done` frame the moment a run reaches a
   * terminal status, and the subscriber then stops for good — which is right,
   * because the run is over. It stops being right the instant the user starts a
   * NEW attempt or resumes a paused one from this page: without something to
   * reopen the stream, the second run would produce a live transcript nobody was
   * listening to, and the page would sit on the first run's last frame for ever.
   */
  const [streamEpoch, setStreamEpoch] = React.useState(0);
  const restream = React.useCallback(() => setStreamEpoch((epoch) => epoch + 1), []);

  /**
   * The last session state this page told the rest of the app about.
   *
   * The stream polls roughly once a second while a run is going, and every frame
   * carries the session. Broadcasting `WORK_SYNC_EVENT` on each of them would
   * have the sidebar re-fetch the whole session list at that rate for as long as
   * the tab is open — a request storm produced by a page that is already
   * receiving the updates it is asking everyone else to go and fetch. Only the
   * two facts other surfaces actually render are worth waking them for.
   */
  const broadcastRef = React.useRef<string | null>(null);
  const broadcast = React.useCallback((current: ClientWorkSession) => {
    const signature = `${current.status}:${current.needsAttention}:${current.title}`;
    if (broadcastRef.current === signature) return;
    broadcastRef.current = signature;
    window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
  }, []);

  // The resume cursor, both halves. A ref rather than state because the stream's
  // reconnect loop reads it on every attempt, and a captured value would replay
  // the whole run from zero after each drop. `seq` is unique per run, so the run
  // id travels with it — the route ignores an `after` that belongs to a
  // different attempt, and silently starting from zero would double the
  // timeline.
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

  const load = React.useCallback(async () => {
    setLoadFailure(null);
    const result = await fetchWorkThread(id);
    if (result.kind === "blocked") {
      setBlocked(result);
      return;
    }
    if (result.kind === "failed") {
      setLoadFailure(result.cause);
      return;
    }
    setSession(result.value.session);
    setRun(result.value.run);
  }, [id]);

  const loadHosts = React.useCallback(async () => {
    const result = await fetchWorkHosts();
    // A failed host load leaves `hosts` null, which the run settings panel reads
    // as "the Mac is not named yet" rather than as "there is no Mac". Blanking a
    // known list on a dropped request would state something the failure did not
    // establish.
    if (result.kind === "ok") setHosts(result.value);
  }, []);

  React.useEffect(() => {
    void load();
    void loadHosts();
  }, [load, loadHosts]);

  // The stream opens once the session is known, so the first connection carries
  // the run id the snapshot will be judged against.
  const ready = session !== null;
  React.useEffect(() => {
    if (!ready) return;
    setStreamLost(false);
    const unsubscribe = subscribeToWorkEvents(id, {
      cursor: () => cursor.current,
      onFrame: (frame) => {
        setSession(frame.session);
        setRun(frame.run);
        broadcast(frame.session);

        if (frame.type === "done") return;

        // A snapshot for a run this page was not already following means the
        // server re-based: either this is the first connection, or a newer
        // attempt took over and its sequence starts again at 1. Keeping the old
        // attempt's events would interleave two runs under one set of seqs.
        // A snapshot for the SAME run is a resume and carries only the delta,
        // so it must not clear anything.
        const frameRunId = frame.run?.id ?? null;
        if (frame.type === "snapshot" && frameRunId !== cursor.current.runId) {
          cursor.current = { runId: frameRunId, after: 0 };
          setEvents([]);
        }
        if (frameRunId !== null) cursor.current.runId = frameRunId;

        mergeEvents(frame.events);
      },
      onStopped: (outcome) => {
        if (outcome.kind === "blocked") {
          setBlocked(outcome);
          return;
        }
        // A finished run is not a lost stream, and neither is a signed-out tab —
        // only a stream that gave up while the run was still going leaves the
        // page showing something that will never update again.
        if (outcome.kind === "failed" && outcome.cause !== "unauthorized") setStreamLost(true);
      },
    });
    return unsubscribe;
  }, [id, ready, streamEpoch, mergeEvents, broadcast]);

  const plan = React.useMemo(() => derivePlan(events), [events]);
  const turns = React.useMemo(() => deriveTurns(events), [events]);
  const questions = React.useMemo(() => deriveOpenQuestions(events), [events]);
  const approvals = React.useMemo(() => deriveApprovals(events), [events]);
  const references = React.useMemo(() => deriveReferences(events), [events]);
  const artifacts = React.useMemo(() => deriveArtifacts(events), [events]);
  const activity = React.useMemo(() => deriveActivity(events), [events]);
  const performed = React.useMemo(() => derivePerformedActions(events), [events]);
  const live = session !== null && !isTerminalStatus(session.status);
  const currentAction = React.useMemo(
    () => (live ? deriveCurrentAction(events) : null),
    [events, live]
  );
  const activityPhase: ActivityPhase = run === null ? "not-started" : live ? "live" : "settled";
  // Split rather than filtered twice. The two halves go to different places: an
  // undecided approval is a thing blocking a person and is lifted above the
  // conversation, while a decided one is history and belongs in the rail with
  // the rest of the record. Rendering the whole list in both would offer the
  // same Allow button in two places.
  const openApprovals = approvals.filter((approval) => approval.decision === "pending");
  const decidedApprovals = approvals.filter((approval) => approval.decision !== "pending");
  const host = React.useMemo(
    () =>
      run?.hostId == null ? null : (hosts ?? []).find((entry) => entry.id === run.hostId) ?? null,
    [hosts, run]
  );

  /**
   * Answers the question the run asked.
   *
   * Resolves true only when the answer landed. Every sender on this page returns
   * that boolean and the composer keeps the reader's words until it sees one:
   * a refused send that had already emptied the box costs somebody a paragraph
   * they then have to retype from memory.
   */
  const answer = React.useCallback(
    async (questionId: string, text: string): Promise<boolean> => {
      setAnswering(true);
      const result = await answerWorkQuestion(id, questionId, text);
      setAnswering(false);
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
    [id]
  );

  /**
   * An instruction that answers nothing.
   *
   * The server's own sentence about what it did with it is what gets shown,
   * rather than a "Sent" of our own. A cloud run reads the instruction before
   * its next step and a run on a Mac does not, and the route is the only side
   * that knows which of the two this is; a toast written here would be this page
   * inventing a promise on behalf of an executor it cannot see.
   */
  const steer = React.useCallback(
    async (text: string): Promise<boolean> => {
      setAnswering(true);
      const result = await steerWorkRun(id, text);
      setAnswering(false);
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
    [id]
  );

  const decide = React.useCallback(
    async (approval: WorkApprovalCard, decision: WorkApprovalDecisionInput) => {
      // Guaranteed non-null by the card, which removes its own buttons when the
      // request arrived without a digest. Re-checked because the alternative is
      // a 400 the user reads as a bug.
      if (approval.actionDigest === null) return;
      setBusyApprovalId(approval.id);
      const result = await decideWorkApproval(approval.id, approval.actionDigest, decision);
      setBusyApprovalId(null);
      if (result.kind === "ok") {
        // Nothing is patched into local state. The server appends an
        // `approval_resolved` event as part of recording the decision, and the
        // stream is a second away — writing an optimistic answer here would mean
        // two sources for the same fact, and the optimistic one would win on
        // screen even when the server had refused.
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : "Couldn’t record your decision, so Juno has not acted on it. Try again."
      );
    },
    []
  );

  const control = React.useCallback(
    async (action: WorkControlAction) => {
      if (run === null) return;
      setBusyControl(true);
      const result = await controlWorkRun(run.id, action);
      setBusyControl(false);
      if (result.kind === "ok") {
        setRun(result.value);
        setBlocked(null);
        // A resume puts the run back to `queued`, and the stream that was
        // watching it has already closed itself on the pause. Reopening is what
        // makes the resumed run visible here rather than only in the database.
        restream();
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        void load();
        return;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : "Couldn’t reach Juno to do that. Nothing changed."
      );
      // The run may have moved underneath the button, so the authoritative state
      // is re-read rather than guessed at.
      void load();
    },
    [run, load, restream]
  );

  /**
   * Starts an attempt. Resolves the run it started, or null if nothing started.
   *
   * The return value exists for `startCarrying` below, which has a second
   * request to make and may only make it once this one has genuinely produced a
   * run. The header's own buttons ignore it.
   */
  const dispatch = React.useCallback(
    async (origin: "manual" | "retry"): Promise<ClientWorkRun | null> => {
      setBusyControl(true);
      setBlocked(null);
      const result = await startWorkRun(id, {
        origin,
        // The plan decides what this attempt needs; the browser does not get to
        // narrow it. An empty list means "nothing local", which `selectTarget`
        // reads as the cloud — the correct reading for a caller that has not
        // planned. A previous attempt's requirements are carried forward so a
        // retry is judged against the same bar the first attempt was.
        requiredCapabilities: run?.requiredCapabilities ?? [],
        idempotencyKey: workIdempotencyKey(),
      });
      setBusyControl(false);
      if (result.kind === "ok") {
        setRun(result.value.run);
        // The new attempt writes its own sequence starting at 1, and the stream
        // watching the previous one closed when that one finished. Reopening
        // re-bases on the new run, which is what clears the old transcript.
        restream();
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        void load();
        return result.value.run;
      }
      if (result.kind === "blocked") {
        setBlocked(result);
        return null;
      }
      toast.error(
        result.cause === "offline"
          ? "Couldn’t reach Juno to start this. Nothing was queued."
          : "Couldn’t start this. Nothing was queued, so trying again is safe."
      );
      return null;
    },
    [id, run, load, restream]
  );

  /**
   * Saying something to a task that is not running: start it, carrying the words.
   *
   * This is the capability the thread was missing. A finished, failed or
   * cancelled task took nothing at all — the composer removed itself and the
   * reader was told to press "Try again" and then say nothing to it — and a
   * draft was the same story with a different sentence.
   *
   * It is two requests, in this order, and the order is the whole mechanism:
   *
   *   1. `POST /sessions/[id]/runs` dispatches the attempt.
   *   2. `POST /sessions/[id]/answer` records the message on it.
   *
   * The second cannot come first. That route reads the newest run and refuses a
   * terminal one with `run_finished` and a never-dispatched session with
   * `run_not_started` — the two states this function exists for. Once the new
   * attempt is in the table it is the newest, it is `queued`, and the
   * instruction lands on it.
   *
   * And it is genuinely carried rather than merely stored. `openSteering` in
   * scripts/work-runner.ts starts its cursor at zero and drains inside the FIRST
   * `provider.stream` call, so an instruction written between dispatch and the
   * first turn is put in front of the model before it does anything — framed by
   * `framedInstruction` as something that comes after the goal and wins where
   * the two disagree. On a Mac the same words go over the relay as a `steer`
   * command. Nothing here forwards the message itself; both executors already
   * read the row.
   *
   * The failure that matters is the half one: the attempt started and the
   * message did not reach it. Saying "couldn't send" alone would be a lie by
   * omission — the task is now running — so it is reported as what it is, and
   * false comes back so the composer keeps the words. The mode has moved to
   * `steer` by then, and pressing send again delivers them to the run that is
   * already going.
   */
  const startCarrying = React.useCallback(
    async (origin: "manual" | "retry", text: string): Promise<boolean> => {
      setAnswering(true);
      const started = await dispatch(origin);
      if (started === null) {
        setAnswering(false);
        // `dispatch` has already said why, either as a toast or as the blocked
        // note at the top of the page. A second sentence here would be the same
        // refusal reported twice in two wordings.
        return false;
      }
      const result = await steerWorkRun(id, text);
      setAnswering(false);
      if (result.kind === "ok") {
        toast.success(result.value.explanation);
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return true;
      }
      toast.error(
        "This task started again, but your message didn’t reach it. It is running on the goal " +
          "alone — send the message again and Juno will read it before its next step."
      );
      return false;
    },
    [dispatch, id]
  );

  if (loadFailure !== null) {
    return (
      <ThreadFrame onBack={() => router.push("/work")}>
        <WorkStateNote
          tone="error"
          action={
            loadFailure === "not_found" || loadFailure === "unauthorized" ? undefined : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load()}
                className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
              </Button>
            )
          }
        >
          {loadFailure === "not_found"
            ? "This task no longer exists. It may have been deleted from another device."
            : loadFailure === "unauthorized"
              ? "You are signed out, so this task can’t be loaded."
              : "Couldn’t load this task. Nothing has been changed by the attempt."}
        </WorkStateNote>
      </ThreadFrame>
    );
  }

  if (session === null) {
    return (
      <ThreadFrame onBack={() => router.push("/work")}>
        <div className="space-y-3">
          {[...Array(4)].map((_, index) => (
            <Skeleton
              key={index}
              className="h-16 w-full rounded-field"
              style={staggerDelay(index, "tight")}
            />
          ))}
        </div>
      </ThreadFrame>
    );
  }

  /*
   * What the box at the bottom is for. There is always a box.
   *
   * An open question outranks everything: while one is open, `POST /answer`
   * refuses an unprompted instruction on purpose — the runner reads the newest
   * `question_answered` on the run, so an instruction recorded on top of an
   * answer would leave the run waiting for a reply it had already been given.
   * The oldest open question is the one chosen, because it is the one blocking.
   *
   * Then the two states that used to close the composer and no longer do. A
   * draft has no attempt for an instruction to join and a finished one has no
   * attempt still listening, so in both the send starts a run and hands the
   * message to it — see `startCarrying`. That is the same answer to the same
   * question the reader was asking when the field disappeared on them.
   *
   * `blocked` is deliberately not a mode. It means the LAST dispatch was
   * refused, and its sentence is already at the top of this page where it
   * cannot be scrolled away; the refusal is about an attempt, not about the
   * reader's ability to type, and a Mac that has since woken makes the next
   * press succeed. Greying the box out on the strength of a stale refusal is
   * how this surface got into trouble in the first place.
   */
  const openQuestion = questions[0] ?? null;
  const composerMode: WorkComposerMode =
    openQuestion !== null
      ? { kind: "answer", question: openQuestion.question }
      : run === null
        ? { kind: "start" }
        : isTerminalStatus(session.status)
          ? { kind: "restart" }
          : { kind: "steer" };

  /**
   * One send, routed by the mode the composer is already showing.
   *
   * Written here rather than in the composer because each branch is a different
   * request with different preconditions, and the composer's job is to say which
   * one is about to be made — not to know how it is made.
   */
  const sendFromComposer = async (text: string): Promise<boolean> => {
    if (openQuestion !== null) return answer(openQuestion.id, text);
    if (run === null) return startCarrying("manual", text);
    if (isTerminalStatus(session.status)) return startCarrying("retry", text);
    return steer(text);
  };

  const notStarted = run === null;

  /*
   * What state the rail arranges itself for, and what it puts where.
   *
   * `needsYou` outranks liveness on purpose: a run parked on an approval is
   * technically still running, but a rail that leads with the plan while a
   * person is being waited on has ranked the wrong thing.
   */
  const needsYou = questions.length > 0 || openApprovals.length > 0;
  const phase = deriveRunPhase({
    hasRun: run !== null,
    live,
    needsYou,
    terminalReason: run?.terminalReason ?? null,
  });
  const policy = RAIL_POLICY[phase];

  /*
   * "How it ran" is closed almost everywhere, and must not be closed here.
   *
   * That section is where a run's degradations are printed — "your Mac was
   * asleep, so the local half was skipped", "the model you asked for is not in
   * your plan". Those are the sentences that explain a disappointing result, and
   * a reader who has to find and open a collapsed section to reach them will
   * instead conclude the product simply did the wrong thing.
   */
  const setupOpen = policy.setup.open || (run !== null && run.degradation.length > 0);

  /*
   * The two halves of the reference list go to different sections, and the
   * direction each entry already carries is what splits them.
   *
   * A page the run read is context — it is part of the answer to "what could
   * this see". A file the run wrote is an output. They lived in one panel called
   * "Files and sources" because they arrive on the same events, which is a fact
   * about the stream and not about the reader.
   */
  const readSources = references.filter((reference) => reference.direction === "read");
  const writtenFiles = references.filter((reference) => reference.direction === "written");
  const tally = planTally(plan);

  const sections: Record<RailSectionName, React.ReactNode> = {
    progress: policy.progress.shown && (
      <RailSection
        key="progress"
        name="progress"
        title={sectionTitle("progress", phase)}
        // The tally rather than a percentage. "4/7" is a position in a list
        // somebody can see; "57%" is a number they have to convert back.
        meta={tally.total > 0 ? `${tally.done}/${tally.total}` : null}
        defaultOpen={policy.progress.open}
      >
        {/* On a failure the digest leads, because how far it got and whether it
            left anything behind are the two things somebody decides "Try again"
            on, and the checklist below is the detail of the first of them. */}
        {phase === "failed" && run !== null && (
          <WorkOutcomeDigest run={run} plan={plan} performed={performed} />
        )}
        <WorkCurrentAction action={currentAction} />
        <WorkProgressChecklist steps={plan} />

        {/*
         * The feed, subordinate to the plan rather than beside it.
         *
         * It opens by default only when there is no plan to be subordinate to.
         * A run that never wrote one still did the work, and on that run the
         * feed is the only record of it — leaving it collapsed would make
         * Progress an empty heading over a task that ran for ten minutes.
         */}
        <RailDisclosure
          storageKey="progress.activity"
          title="Activity"
          meta={activity.length > 0 ? String(activity.length) : null}
          defaultOpen={plan.length === 0}
        >
          {/* Marked busy rather than live. The feed gains a row a second while a
              run is going, and announcing each one would make the page unusable
              for the reader who most needs it — `WorkRunAnnouncer` in the header
              carries the state changes instead. `aria-busy` says the region is
              still filling without reading it aloud. */}
          <div aria-busy={live}>
            <WorkActivity entries={activity} phase={activityPhase} />
          </div>
        </RailDisclosure>

        {decidedApprovals.length > 0 && (
          <RailDisclosure
            storageKey="progress.approvals"
            title="Approvals"
            meta={String(decidedApprovals.length)}
          >
            <WorkApprovals approvals={decidedApprovals} busyId={busyApprovalId} onDecide={decide} />
          </RailDisclosure>
        )}
      </RailSection>
    ),

    outputs: policy.outputs.shown && (
      <WorkOutputsSection
        key="outputs"
        sessionId={session.id}
        phase={phase}
        defaultOpen={policy.outputs.open}
        artifacts={artifacts}
        written={writtenFiles}
        performed={performed}
        // The page's only evidence that documents may exist which this attempt's
        // stream knows nothing about. See the note in work-outputs.tsx.
        hasEarlierAttempts={run !== null && run.attempt > 1}
      />
    ),

    context: policy.context.shown && (
      <WorkContextSection key="context" read={readSources} defaultOpen={policy.context.open} />
    ),

    setup: policy.setup.shown && (
      <RailSection
        key="setup"
        name="setup"
        title={sectionTitle("setup", phase)}
        defaultOpen={setupOpen}
      >
        {/* An attempt history exists only once there has been more than one
            attempt. On a first run this would be a heading over a single row the
            reader is already looking at.

            Titled "Attempts" rather than "Earlier attempts" because the attempt
            on screen is in the list too, marked rather than omitted — a
            comparison with a gap where the thing being compared should be is not
            a comparison. */}
        {run !== null && run.attempt > 1 && (
          <RailDisclosure
            storageKey="setup.attempts"
            title="Attempts"
            meta={String(run.attempt)}
            defaultOpen
          >
            <WorkAttempts sessionId={session.id} current={run} />
          </RailDisclosure>
        )}
        {run === null ? (
          // A draft has no run to describe, and saying "nothing to describe yet"
          // and then starting the task on settings the reader was never shown is
          // how somebody discovers their choice of Mac was ignored by watching
          // the cloud do the work.
          <WorkPlannedSettings session={session} hosts={hosts} />
        ) : (
          <WorkRunSettings run={run} host={host} />
        )}
      </RailSection>
    ),
  };

  /*
   * What the rail leads with, which on a phone is also what it is called.
   *
   * Every section above is either an element or `false`, so this finds the first
   * one that will genuinely render rather than the first one listed — a link
   * promising "progress" that lands on "how it will run" because a draft has no
   * progress to show is a worse link than none.
   *
   * It doubles as the guard for the jump link itself: null means the rail
   * rendered nothing at all, and there is nothing to jump to.
   */
  const railLead = RAIL_ORDER.find((name) => Boolean(sections[name])) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/60 px-4 py-4 sm:px-6">
        <div className="mx-auto w-full max-w-[80rem]">
          <div className="mb-1 flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => router.push("/work")}
              aria-label="Back to Work"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="font-mono text-label text-muted-foreground">Work</span>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-serif text-display font-medium tracking-tight">
                {session.title || "Untitled task"}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <WorkStatusPill status={session.status} />
                <span className="text-[13px] text-muted-foreground">
                  {statusSentence(session.status)}
                </span>
              </div>
              {/* What it is costing, where it can be seen without scrolling.
                  The same three numbers appear as bars against their ceilings at
                  the bottom of the reference column; these are the glance, those
                  are the check. A draft has no run and therefore no numbers —
                  showing three zeroes would imply it had started. */}
              {run !== null && (
                <div className="mt-2">
                  <WorkLiveMeter run={run} />
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 pt-1">
              {notStarted && (
                <Button
                  size="sm"
                  disabled={busyControl}
                  onClick={() => void dispatch("manual")}
                  className="h-8 gap-1.5"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden="true" /> Start
                </Button>
              )}
              {run !== null && run.status === "paused" && (
                <Button
                  size="sm"
                  disabled={busyControl}
                  onClick={() => void control("resume")}
                  className="h-8 gap-1.5"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden="true" /> Resume
                </Button>
              )}
              {run !== null && !isTerminalStatus(run.status) && run.status !== "paused" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyControl}
                  onClick={() => void control("pause")}
                  className="h-8 gap-1.5"
                >
                  <Pause className="h-3.5 w-3.5" aria-hidden="true" /> Pause
                </Button>
              )}
              {run !== null && !isTerminalStatus(run.status) && (
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={busyControl}
                  onClick={() => void control("cancel")}
                  className="h-8 gap-1.5"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden="true" /> Stop
                </Button>
              )}
              {run !== null && isTerminalStatus(run.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyControl}
                  onClick={() => void dispatch("retry")}
                  className="h-8 gap-1.5"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
                </Button>
              )}
            </div>
          </div>

          {/* Every reason this task is not simply proceeding, stated once, at the
              top, where a spinner would otherwise be. */}
          <div className="mt-3 space-y-2.5">
            {blocked !== null && (
              <WorkStateNote tone="blocked">
                <p>{blocked.explanation}</p>
                <DegradationNotes degradation={blocked.degradation} className="mt-2" />
              </WorkStateNote>
            )}
            {notStarted && blocked === null && (
              <WorkStateNote tone="info">
                This is a draft. Nothing is queued and nothing is running until you start it.
              </WorkStateNote>
            )}
            {run?.terminalReason != null && run.terminalReason !== "completed" && (
              <WorkStateNote tone="warning">
                {run.terminalDetail ?? statusSentence(session.status)}
              </WorkStateNote>
            )}
            {streamLost && (
              <WorkStateNote
                tone="warning"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // Both halves: re-read the session, and reopen the stream.
                      // Refetching alone would refresh the status once and leave
                      // the page just as dead as it was.
                      void load();
                      restream();
                    }}
                    className="gap-1.5"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Reconnect
                  </Button>
                }
              >
                Live updates stopped. What is on screen is real but may be out of date — the task
                itself carries on regardless of this page.
              </WorkStateNote>
            )}
            <WorkApprovalPrompt count={openApprovals.length} />
            {/*
             * The two ways down the page, on the screen where both are furthest
             * away.
             *
             * On a desktop neither exists: the block that needs answering is
             * pinned at the top of the second column and the rail is the rest of
             * it, so both are already in view and a link would point at
             * something the reader is looking at.
             *
             * On a phone there is one column, and everything the rail holds sits
             * below a transcript that can run to many screens. Without these,
             * "what did it actually produce" is a question you answer by
             * scrolling past the whole conversation, which is barely better than
             * the rail being dropped from the layout altogether. Both targets
             * carry `tabIndex={-1}`, so following one moves the keyboard as well
             * as the viewport rather than leaving focus at the top of the page.
             *
             * The rail's link is named after whatever the rail is leading with,
             * so it says "what happened" on a failure and "what it produced" on
             * a finished task — the reader is told where they are going in the
             * same words they will land on.
             */}
            {(needsYou || railLead !== null) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 lg:hidden">
                {needsYou && <JumpLink href="#work-needs-you">Go to what needs you</JumpLink>}
                {railLead !== null && (
                  <JumpLink href="#work-rail">
                    Go to {uncapitalize(sectionTitle(railLead, phase))}
                  </JumpLink>
                )}
              </div>
            )}
          </div>

          {/* The one thing a screen reader is interrupted for. See
              `WorkRunAnnouncer` — the activity feed deliberately is not a live
              region, and this carries the state changes in its place. */}
          <WorkRunAnnouncer status={session.status} detail={run?.terminalDetail ?? null} />
        </div>
      </header>

      {/*
       * One scroll region on a phone, two on a desktop — and three grid items in
       * one DOM order, placed differently at each size rather than duplicated.
       *
       * On a phone the order is: what needs you, the conversation, the reference
       * rail. Reading follows the decision rather than burying it, and the rail
       * is still there below rather than dropped — which is what it was before
       * this: eight panels of reference material stacked under a transcript,
       * with the one panel holding an Allow button somewhere among them.
       *
       * On a desktop the rail's two halves take the second column in two rows.
       * The block that needs answering takes the auto row at the top and does
       * NOT scroll; the reference panels take the remaining row and scroll under
       * it. So an approval cannot be scrolled out of view while the reader is
       * reading the thing it is about, which is the invariant the old single
       * scrolling column only had by luck.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
        <div className="mx-auto grid w-full max-w-[80rem] grid-cols-1 gap-x-10 gap-y-8 px-4 py-6 sm:px-6 lg:h-full lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-y-0 lg:overflow-hidden lg:py-0 xl:grid-cols-[minmax(0,1fr)_26rem]">
          {needsYou && (
            <section
              id="work-needs-you"
              tabIndex={-1}
              aria-label="Waiting on you"
              className="min-w-0 space-y-4 lg:col-start-2 lg:row-start-1 lg:border-l lg:border-border/60 lg:pb-7 lg:pl-8 lg:pt-6"
            >
              {questions.length > 0 && (
                <div>
                  <h2 className="mb-2.5 font-mono text-[11px] tracking-[0.1em] text-foreground">
                    Waiting on you
                  </h2>
                  <div className="space-y-2.5">
                    {questions.map((question) => (
                      <WorkQuestionCard
                        key={question.id}
                        question={question}
                        busy={answering}
                        onAnswer={(questionId, text) => void answer(questionId, text)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {openApprovals.length > 0 && (
                <div>
                  <h2 className="mb-2.5 font-mono text-[11px] tracking-[0.1em] text-foreground">
                    {openApprovals.length === 1 ? "Approval needed" : "Approvals needed"}
                  </h2>
                  <WorkApprovals
                    approvals={openApprovals}
                    busyId={busyApprovalId}
                    onDecide={decide}
                  />
                </div>
              )}
            </section>
          )}

          <div className="min-w-0 lg:col-start-1 lg:row-start-1 lg:row-span-2 lg:h-full lg:overflow-y-auto lg:py-6">
            <WorkConversation
              session={session}
              run={run}
              events={events}
              turns={turns}
              sending={answering}
              mode={composerMode}
              onSend={sendFromComposer}
            />
          </div>

          {/* The rail proper. Its four sections are always in `RAIL_ORDER`, and a
              section this phase has no use for renders nothing at all — no
              heading, no rule, no apology. */}
          <aside
            id="work-rail"
            // Focusable only by the jump link above, never by tabbing: a landmark
            // that took a tab stop of its own would put an unlabelled stop
            // between the conversation and the first panel for every keyboard
            // user on every screen size, to serve one link that exists on one.
            tabIndex={-1}
            aria-label="Run detail"
            className={cn(
              "min-w-0 space-y-8 focus-visible:outline-none lg:col-start-2 lg:row-start-2 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-border/60 lg:pb-6 lg:pl-8",
              !needsYou && "lg:pt-6"
            )}
          >
            {RAIL_ORDER.map((name) => sections[name])}
          </aside>
        </div>
      </div>
    </div>
  );
}

/**
 * A link down the page, on the layout where down the page is a long way.
 *
 * `lg:hidden` lives here rather than at the call sites because it is the whole
 * reason these exist: on a desktop both targets are already on screen, and a
 * link to something visible is noise a reader has to rule out.
 */
function JumpLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex rounded-sm font-mono text-[10px] text-muted-foreground underline underline-offset-4 transition-colors duration-base ease-out-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </a>
  );
}

/**
 * A section's title as the tail of a sentence.
 *
 * The titles are written to stand alone as headings — "How it will run" — and
 * "Go to How it will run" reads like a proper noun. Only the first character is
 * touched, so a title that begins with a word which is capitalised in its own
 * right would need a different treatment; none currently does.
 */
function uncapitalize(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The header + centred column used by the pre-content states. */
function ThreadFrame({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="mb-4 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to Work">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label text-muted-foreground">Work</span>
        </div>
        {children}
      </div>
    </div>
  );
}
