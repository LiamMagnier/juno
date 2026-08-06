"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Pause, Play, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isTerminalStatus } from "@/lib/work/domain";
import type {
  ClientWorkEvent,
  ClientWorkHost,
  ClientWorkRun,
  ClientWorkSession,
} from "@/lib/work/serializers";
import {
  WorkActionsPerformed,
  WorkLiveMeter,
  WorkReferences,
  WorkRunSettings,
  deriveArtifacts,
  deriveReferences,
} from "@/components/work/work-detail-panels";
import { WorkDocuments } from "@/components/work/work-documents";
import { WorkToolbox } from "@/components/work/work-toolbox";
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
  WorkPlan,
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
  const openApprovals = approvals.filter((approval) => approval.decision === "pending");
  const host = React.useMemo(
    () =>
      run?.hostId == null ? null : (hosts ?? []).find((entry) => entry.id === run.hostId) ?? null,
    [hosts, run]
  );

  const answer = React.useCallback(
    async (questionId: string, text: string) => {
      setAnswering(true);
      const result = await answerWorkQuestion(id, questionId, text);
      setAnswering(false);
      if (result.kind === "ok") {
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : "Couldn’t send that answer, so Juno hasn’t seen it. Try again."
      );
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
    async (text: string) => {
      setAnswering(true);
      const result = await steerWorkRun(id, text);
      setAnswering(false);
      if (result.kind === "ok") {
        toast.success(result.value.explanation);
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : "Couldn’t add that to the task. Nothing was recorded."
      );
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

  const dispatch = React.useCallback(
    async (origin: "manual" | "retry") => {
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
        return;
      }
      if (result.kind === "blocked") {
        setBlocked(result);
        return;
      }
      toast.error(
        result.cause === "offline"
          ? "Couldn’t reach Juno to start this. Nothing was queued."
          : "Couldn’t start this. Nothing was queued, so trying again is safe."
      );
    },
    [id, run, load, restream]
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
              className="h-16 w-full rounded-xl"
              style={{ animationDelay: `${index * 70}ms` }}
            />
          ))}
        </div>
      </ThreadFrame>
    );
  }

  /*
   * What the box at the bottom is for.
   *
   * An open question outranks everything: while one is open, `POST /answer`
   * refuses an unprompted instruction on purpose — the runner reads the newest
   * `question_answered` on the run, so an instruction recorded on top of an
   * answer would leave the run waiting for a reply it had already been given.
   * The oldest open question is the one chosen, because it is the one blocking.
   *
   * With no question open the box takes an instruction instead, which the route
   * records on the task. A finished task and a task nothing can execute take
   * neither, and say which.
   */
  const openQuestion = questions[0] ?? null;
  const composerMode: WorkComposerMode =
    openQuestion !== null
      ? { kind: "answer", question: openQuestion.question }
      : blocked !== null
        ? {
            kind: "closed",
            reason:
              "Juno cannot act on this right now, so there is nowhere for a new instruction to go.",
          }
        : isTerminalStatus(session.status)
          ? {
              kind: "closed",
              reason: "This task has finished. Start it again above, or begin a new one, to say more.",
            }
          : run === null
            ? {
                kind: "closed",
                reason:
                  "This is still a draft. Start it, and everything in the goal goes with it — there is no attempt yet for anything else to join.",
              }
            : { kind: "steer" };

  const notStarted = run === null;

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
          </div>
        </div>
      </header>

      {/* One scroll region on a phone, two on a desktop. The right column is not
          a sidebar that can be collapsed away: it holds the approvals, so it
          must never be somewhere the user has to go looking. */}
      <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
        <div className="mx-auto grid w-full max-w-[80rem] grid-cols-1 gap-8 px-4 py-6 sm:px-6 lg:h-full lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-10 lg:overflow-hidden lg:py-0 xl:grid-cols-[minmax(0,1fr)_26rem]">
          <div className="min-w-0 lg:h-full lg:overflow-y-auto lg:py-6">
            <WorkConversation
              session={session}
              turns={turns}
              sending={answering}
              mode={composerMode}
              onSend={(text) => {
                if (openQuestion !== null) {
                  void answer(openQuestion.id, text);
                  return;
                }
                void steer(text);
              }}
            />
          </div>

          <div className="min-w-0 space-y-7 lg:h-full lg:overflow-y-auto lg:border-l lg:border-border/60 lg:py-6 lg:pl-8">
            {questions.length > 0 && (
              <Panel title="Waiting on you">
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
              </Panel>
            )}

            <Panel title="Plan">
              <div className="space-y-3">
                <WorkCurrentAction action={currentAction} />
                <WorkPlan steps={plan} />
              </div>
            </Panel>

            {/* Not "Progress". Progress is a percentage; this is the record of
                what Juno actually did, step by step, and it is the answer to the
                question the whole page exists for. */}
            <Panel title="Activity">
              <WorkActivity entries={activity} phase={activityPhase} />
            </Panel>

            <Panel title="Approvals">
              <WorkApprovals approvals={approvals} busyId={busyApprovalId} onDecide={decide} />
            </Panel>

            <Panel title="Files and sources">
              <WorkReferences references={references} />
            </Panel>

            <Panel title="Documents">
              <WorkDocuments sessionId={session.id} fromEvents={artifacts} />
            </Panel>

            <Panel title="Skills and apps">
              <WorkToolbox />
            </Panel>

            <Panel title="Actions performed">
              <WorkActionsPerformed performed={performed} />
            </Panel>

            <Panel title="Run settings">
              <WorkRunSettings run={run} host={host} />
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2.5 font-mono text-label text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}
