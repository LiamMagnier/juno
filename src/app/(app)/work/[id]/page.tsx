"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, GripVertical, Pause, Play, Square } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { splitBounds, useSplitPane } from "@/hooks/use-split-pane";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
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
import {
  WorkConversation,
  deriveTurns,
  type WorkComposerMode,
} from "@/components/work/work-conversation";
import {
  WorkQuestionCard,
  deriveApprovals,
  deriveOpenQuestions,
  type WorkApprovalCard,
} from "@/components/work/work-decisions";
import { ApprovalPrompt, ApprovalQueue } from "@/components/work/approvals/approval-queue";
import { CaptureSkillButton, canCaptureSkill } from "@/components/work/skills/capture-skill";
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
/* ─── The rail's width ────────────────────────────────────────────────────────
 * The second column was a fixed track — 22rem, 26rem at xl — which is the one
 * thing this page could not answer for the reader: whether the transcript or
 * the receipts deserve the room is a judgement about the task in front of them,
 * and it changes between a two-step errand and a run with forty tool calls.
 *
 * It is the same drag the canvas and the thought dock have in chat, from the
 * same hook, with the same feel and the same "reset by double-click or Home".
 * A page that morphs differently from the chat two clicks away is a second
 * idiom to learn for no reason. */
const WORK_RAIL_WIDTH_KEY = "juno:work-rail-width";
/* The rail's own floor. Its narrowest content is not prose but the label/value
 * meta rows and the budget bars in "How it ran" — mono captions with a number
 * on the right — and below roughly this they wrap onto two lines each, at which
 * point the reference column costs more height than the width it gave back. */
const WORK_RAIL_MIN_WIDTH = 288;
/* What the conversation keeps no matter what — plus the 40px `gap-x-10` between
 * the columns, which comes out of the same total. Wider than chat's 320 floor
 * on purpose: this column is prose and tool output, not a phone-width fallback,
 * and squeezing it is how you end up reading a transcript four words wide. */
const WORK_CONVERSATION_MIN_WIDTH = 480 + 40;
/* 26rem — the widest track the undragged CSS can hand out (xl). Same rule as the
 * thought dock's 30rem: the class renders regardless of these bounds, so a max
 * below it would only make the handle snap the rail inwards before the user had
 * moved. */
const WORK_RAIL_CSS_WIDTH = 416;

function workRailBounds(containerWidth: number) {
  return splitBounds({
    containerWidth,
    paneMin: WORK_RAIL_MIN_WIDTH,
    paneFloor: 240,
    primaryMin: WORK_CONVERSATION_MIN_WIDTH,
    // Half, not the canvas's 0.82: the rail answers questions about the
    // conversation beside it, so a rail wider than the thing it annotates is
    // never the layout the reader wanted.
    fraction: 0.5,
    cssWidth: WORK_RAIL_CSS_WIDTH,
  });
}

/* The grid drops to one column below lg, where the rail is a section stacked
 * under the transcript and its width is whatever the page is. Same gate the
 * chat panes use, and for the same reason: clamping a stored width against a
 * layout that never reads it is how a width chosen on a monitor gets rewritten
 * to phone bounds by a phone's own scroll. */
const workRailResizeApplies = () =>
  typeof window !== "undefined" && !window.matchMedia("(max-width: 1023px)").matches;

export default function WorkThreadPage() {
  const { id } = useParams<{ id: string }>();

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
  /** True while `decideAll` is walking a batch. Disables every card at once. */
  const [batching, setBatching] = React.useState(false);
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
  /** The two-column grid, measured by the split handle below. */
  const gridRef = React.useRef<HTMLDivElement>(null);

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

  /**
   * Answers one approval.
   *
   * `reason` is what makes "Change it" possible. The decision endpoint takes a
   * free-text reason alongside a refusal and the executor puts it in front of
   * the model, so amending a proposed action is a refusal plus an instruction —
   * which is the only shape it CAN take, because `actionDigest` is computed over
   * the action and its detail and the server refuses a decision whose digest
   * does not match. That check is the reason the gate can be trusted at all; a
   * client that edited the arguments and submitted the old digest would be
   * defeating it. See the note in `approval-card.tsx`.
   */
  const decide = React.useCallback(
    async (
      approval: WorkApprovalCard,
      decision: WorkApprovalDecisionInput,
      reason?: string
    ): Promise<boolean> => {
      // Guaranteed non-null by the card, which removes its own buttons when the
      // request arrived without a digest. Re-checked because the alternative is
      // a 400 the user reads as a bug.
      if (approval.actionDigest === null) return false;
      setBusyApprovalId(approval.id);
      const result = await decideWorkApproval(
        approval.id,
        approval.actionDigest,
        decision,
        reason
      );
      setBusyApprovalId(null);
      if (result.kind === "ok") {
        // Nothing is patched into local state. The server appends an
        // `approval_resolved` event as part of recording the decision, and the
        // stream is a second away — writing an optimistic answer here would mean
        // two sources for the same fact, and the optimistic one would win on
        // screen even when the server had refused.
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

  /**
   * Answers several approvals with one press.
   *
   * SEQUENTIAL, AND IT STOPS AT THE FIRST REFUSAL. Each decision is a POST the
   * executor may act on the moment it lands, so firing six in parallel at a run
   * that resolves them in order produces interleaved side effects nobody asked
   * for. And a refusal means the policy narrowed or the run moved on — carrying
   * on through the rest would turn one stale card into five failed requests and
   * a stack of toasts that say nothing about which of them actually happened.
   *
   * The queue decides WHICH approvals may be here; this only walks the list it
   * is handed. Keeping the risk rule in one place (`mayBatchApprove`) is what
   * stops a second caller from batching a permanent delete.
   */
  const decideAll = React.useCallback(
    async (batch: readonly WorkApprovalCard[]) => {
      setBatching(true);
      let done = 0;
      for (const approval of batch) {
        const ok = await decide(approval, "allowed");
        if (!ok) break;
        done += 1;
      }
      setBatching(false);
      if (done === batch.length) {
        toast.success(done === 1 ? "Allowed." : `Allowed all ${done}.`);
      } else if (done > 0) {
        toast.warning(
          `Allowed ${done} of ${batch.length}. The rest were left alone — answer them one at a time.`
        );
      }
    },
    [decide]
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

  /**
   * The split between the conversation and the rail.
   *
   * Measured from the grid rather than from the rail: mid-drag the rail's own
   * width is the thing being changed, and the grid's right edge IS the rail's
   * right edge (the page padding moved out to the scroll container below,
   * precisely so that is true — with the padding still on the grid, every drag
   * landed the rail's edge 24px to the left of the pointer).
   *
   * Declared above the early returns, like every other hook here: the loading
   * and error states render a different tree, and a hook called only on the
   * loaded one would change the hook order between renders.
   */
  const rail = useSplitPane({
    storageKey: WORK_RAIL_WIDTH_KEY,
    containerRef: gridRef,
    bounds: workRailBounds,
    // null = never dragged = the 22rem/26rem track the CSS already gives it.
    resetWidth: () => null,
    cssWidth: WORK_RAIL_CSS_WIDTH,
    applies: workRailResizeApplies,
    // The grid only exists once the task has loaded — the pre-content states
    // below render a single narrow column instead. Without this the hook would
    // measure its bounds against nothing while the skeleton was up and never
    // look again, so a width stored on a wider window survived into a layout
    // that could not hold it until the next window resize.
    active: session !== null,
  });

  if (loadFailure !== null) {
    return (
      <ThreadFrame>
        {/* No Retry on the two that answer the same way every time: a task that
            is gone stays gone, and a signed-out tab needs a sign-in rather than
            a second request. */}
        <WorkLoadError
          onRetry={
            loadFailure === "not_found" || loadFailure === "unauthorized"
              ? undefined
              : () => void load()
          }
        >
          {loadFailure === "not_found"
            ? "This task no longer exists. It may have been deleted from another device."
            : loadFailure === "unauthorized"
              ? "You are signed out, so this task can’t be loaded."
              : "Couldn’t load this task. Nothing has been changed by the attempt."}
        </WorkLoadError>
      </ThreadFrame>
    );
  }

  if (session === null) {
    return (
      <ThreadFrame>
        {/* Four short blocks rather than four task-row-shaped ones: what resolves
            here is a header and a transcript, not a list, so the placeholder is
            sized to the paragraphs it stands in for. */}
        <WorkRowSkeletons count={4} height={64} className="space-y-3" />
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
         * "That worked — do it again next month."
         *
         * Placed directly under the finished checklist, and only there, because
         * this is the one moment the offer makes sense: the steps that would
         * become the skill are on the screen, and the reader has just decided
         * the run was good. Skills could previously only be written from a blank
         * textarea, in advance, for a job nobody had done yet — which is the
         * hardest moment to write them and the reason skill libraries stay
         * empty. `canCaptureSkill` keeps it off failed runs and off anything too
         * small to generalise.
         */}
        {canCaptureSkill(session.status, plan) && (
          <div className="mt-3">
            <CaptureSkillButton session={session} plan={plan} performed={performed} />
          </div>
        )}

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
            <ApprovalQueue
              approvals={decidedApprovals}
              busyId={busyApprovalId}
              batching={batching}
              onDecide={decide}
              onDecideAll={decideAll}
            />
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
            {/* A real link, not a router.push behind a button: this is a URL
                somebody cmd-clicks, middle-clicks and hovers to preview, and a
                button also reports itself to assistive tech as the wrong thing.
                `WorkPageFrame` and `AppPageHeader` both already do it this way,
                so back behaved differently here than on every sibling page. */}
            <Button asChild variant="ghost" size="icon-sm" aria-label="Back to Work">
              <Link href="/work">
                <ArrowLeft className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            {/* Identical to ThreadFrame's eyebrow below. The same word in the
                same position was changing face, size and tracking the moment the
                task resolved. */}
            <span className="font-mono text-label text-muted-foreground">Work</span>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {/* `text-display` and the serif face, the same pair the Work home's
                  h1 uses. Two page titles one click apart were on two bespoke
                  clamps, neither of them on the ladder. */}
              <h1 className="font-serif text-display">
                {session.title || "Untitled task"}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <WorkStatusPill status={session.status} />
                <span className="text-ui text-muted-foreground">
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
                  <Play className="size-3.5" aria-hidden="true" /> Start
                </Button>
              )}
              {run !== null && run.status === "paused" && (
                <Button
                  size="sm"
                  disabled={busyControl}
                  onClick={() => void control("resume")}
                  className="h-8 gap-1.5"
                >
                  <Play className="size-3.5" aria-hidden="true" /> Resume
                </Button>
              )}
              {/*
                THE TWO SPEEDS, AND THEY ARE GENUINELY DIFFERENT THINGS.
                Pause parks the run at the next point it can stop cleanly and
                keeps the checkpoint, so Resume picks up where it left off. Stop
                ends the attempt: `isResumableTerminalReason` returns false for a
                cancel, so the checkpoint is dropped and anything after it starts
                from the goal again.

                The `title` on each is not decoration. "Pause" and "Stop" are
                near-synonyms in ordinary speech, and the difference between them
                here is whether an hour of work survives — which is exactly the
                kind of thing a reader should not have to discover by pressing
                one.
              */}
              {run !== null && !isTerminalStatus(run.status) && run.status !== "paused" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyControl}
                  onClick={() => void control("pause")}
                  title="Stops at the next clean point and keeps its progress. You can resume it."
                  className="h-8 gap-1.5"
                >
                  <Pause className="size-3.5" aria-hidden="true" /> Pause
                </Button>
              )}
              {run !== null && !isTerminalStatus(run.status) && (
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={busyControl}
                  onClick={() => void control("cancel")}
                  title="Ends this attempt now. Its progress is not kept, and running it again starts from the goal."
                  className="h-8 gap-1.5"
                >
                  <Square className="size-3.5" aria-hidden="true" /> Stop
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
                  <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Try again
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
                    <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Reconnect
                  </Button>
                }
              >
                Live updates stopped. What is on screen is real but may be out of date — the task
                itself carries on regardless of this page.
              </WorkStateNote>
            )}
            <ApprovalPrompt count={openApprovals.length} />
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
      {/* The page padding lives on the SCROLL box, not on the grid, so the grid's
          box is exactly the two columns and nothing else. The split handle
          measures `grid.right - pointerX`; with `px-4 sm:px-6` still on the grid
          that measurement was over by the padding, and the rail's edge landed a
          padding-width to the left of the pointer for the whole drag. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6 lg:overflow-hidden">
        <div
          ref={gridRef}
          style={
            rail.width != null
              ? ({ "--juno-work-rail-width": `${rail.width}px` } as React.CSSProperties)
              : undefined
          }
          className={cn(
            "mx-auto grid w-full max-w-[80rem] grid-cols-1 gap-x-10 gap-y-8 py-6 lg:h-full lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-y-0 lg:overflow-hidden lg:py-0",
            // Undragged: the ORIGINAL tracks, byte-for-byte, including the xl
            // step. A dragged width is one number at every size above lg —
            // stepping it at xl would move a column the user had just placed.
            rail.width == null
              ? "lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_26rem]"
              : "lg:grid-cols-[minmax(0,1fr)_var(--juno-work-rail-width)]"
          )}
        >
          {needsYou && (
            <section
              id="work-needs-you"
              tabIndex={-1}
              aria-label="Waiting on you"
              className="min-w-0 space-y-4 lg:col-start-2 lg:row-start-1 lg:border-l lg:border-border/60 lg:pb-7 lg:pl-8 lg:pt-6"
            >
              {questions.length > 0 && (
                <div>
                  <NeedsYouHeading count={questions.length}>Waiting on you</NeedsYouHeading>
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
                  <NeedsYouHeading count={openApprovals.length}>
                    {openApprovals.length === 1 ? "Approval needed" : "Approvals needed"}
                  </NeedsYouHeading>
                  <ApprovalQueue
                    approvals={openApprovals}
                    busyId={busyApprovalId}
                    batching={batching}
                    onDecide={decide}
                    onDecideAll={decideAll}
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

          {/* The handle spans BOTH rows of the second column, because both of
              them move: the block that needs answering sits in row 1 and the
              reference panels in row 2, and a grip that only covered the rail
              would be missing exactly when an approval is open. An overlay grid
              item rather than a child of either — it is `pointer-events-none`
              apart from the 12px grip, so the panels underneath keep every
              click. Hidden below lg, where there is one column and nothing to
              split.

              LAST in the DOM although it paints down the middle: grid places it
              explicitly, so source order is free to be tab order, and a splitter
              is the last thing a keyboard user wants between them and the
              conversation. */}
          <div className="pointer-events-none relative hidden lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:block">
            <button
              type="button"
              {...rail.separatorProps}
              aria-label="Resize the detail column"
              title="Drag to resize. Arrow keys adjust, Home resets."
              className="group pointer-events-auto absolute inset-y-0 left-0 z-popper flex w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center"
            >
              {/* The same grip the canvas and the thought dock use, down to the
                  rung it floats on. */}
              <span className="flex h-12 w-1.5 items-center justify-center rounded-full border border-border/70 bg-popover text-muted-foreground opacity-0 shadow-soft transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
                <GripVertical className="size-3.5" />
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A heading in the block that is holding the task up.
 *
 * Amber, and it is the only amber heading in Work — the same ink the home list's
 * "Needs you" section takes, so a reader who has learned the colour on the list
 * meets it again on the task it sent them to. The rail's own headings a few
 * pixels below are `text-foreground/80` and stay that way: this block and that
 * rail are the same visual column, and if both were coloured the column would
 * have no rank in it at all.
 *
 * The count is the rail's `meta` idiom — mono, `caption`, tabular — rather than
 * a second thing to learn. Two open approvals and one are a different amount of
 * work, and the heading is where that is cheapest to say.
 */
function NeedsYouHeading({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <h2 className="mb-2.5 flex items-baseline gap-2">
      <span className="font-mono text-label text-warning-foreground">{children}</span>
      {count > 1 && (
        <span className="font-mono text-caption tabular-nums text-warning-foreground/80">
          {count}
        </span>
      )}
    </h2>
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
      className="inline-flex rounded-sm font-mono text-micro text-muted-foreground underline underline-offset-4 transition-colors duration-base ease-out-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

/**
 * The header + centred column used by the pre-content states.
 *
 * `mb-1` on the nav row, not `mb-4`: this row is the same row as the loaded
 * header's above and as `AppPageHeader`'s, and it was sitting at a third gap —
 * so the eyebrow visibly jumped down the page the moment the task resolved.
 */
function ThreadFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-2xl">
        <div className="mb-1 flex items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm" aria-label="Back to Work">
            <Link href="/work">
              <ArrowLeft className="size-4" aria-hidden="true" />
            </Link>
          </Button>
          <span className="font-mono text-label text-muted-foreground">Work</span>
        </div>
        {children}
      </div>
    </div>
  );
}
