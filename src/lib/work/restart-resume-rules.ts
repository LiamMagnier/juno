import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * A cloud Work run across a restart of its runner, as rules with no database
 * and no `server-only` in them, so they are unit-tested as they are. The reads
 * and writes that use them are `src/lib/work/restart-resume.ts`; the runner
 * wires both in `scripts/work-runner.ts`.
 *
 * What happens on SIGINT or SIGTERM (a deploy, a PM2 restart, a memory limit):
 *
 *   1. The runner stops claiming and asks every run it is driving to stop at
 *      its next step boundary (`RunRestartSignal.request`). A step is one model
 *      request and the tool calls it asked for; the boundary is the moment the
 *      next model request would go out, when every tool call of the step before
 *      has returned and its result is in the transcript
 *      (`pauseAtStepBoundary`).
 *   2. A run that reaches it is paused there, checkpointed, and parked with
 *      `pauseReason: "server_restart"`, its lease released; unless a tool
 *      call of the step it just finished may have been cut short by the stop
 *      (`RunRestartSignal.cutShort`), and then it ends `interrupted` as in 3.
 *   3. A run still inside a step when `shutdownStepWaitMs()` runs out is
 *      stopped where it is (`RunRestartSignal.stopNow`) and ends `interrupted`,
 *      as every run did before: a tool cut short may already have changed
 *      something, and nothing can show it did not.
 *   4. The next runner continues a parked run only when its checkpoint shows
 *      nothing in flight (`restartCheckpointVerdict`) and the switch is on
 *      (`restartResumeEnabled`); otherwise it ends it `interrupted`, its
 *      progress kept. The run's budget, spend and lease rules are the ones
 *      every resumed run has: the checkpoint carries the budget, and the claim
 *      takes a fresh lease.
 */

// ---------------------------------------------------------------------------
// Owner-tunable (docs/OPEN_DECISIONS.md §14, "owner to confirm")
// ---------------------------------------------------------------------------

/**
 * Whether a run set aside for a restart is continued by the next runner.
 *
 * On by default. The runner's old rule was that it never restarts a run on its
 * own; this is the one exception, and it is narrow: the run stopped between
 * two steps, by the runner's own hand, and its checkpoint proves no tool call
 * was in flight. `WORK_RESUME_AFTER_RESTART=0` (or `false`, `off`, `no`) turns
 * it off, and a run set aside for a restart then ends `interrupted` with its
 * progress kept, as before.
 */
export function restartResumeEnabled(raw: string | undefined = process.env.WORK_RESUME_AFTER_RESTART): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return true;
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/**
 * How long a run may take to reach the end of the step it is on, after the
 * runner was asked to stop, before it is stopped mid-step.
 *
 * It has to fit inside the time PM2 waits before it kills the process
 * (`kill_timeout` of juno-work in deploy/ecosystem.config.js, 60 s), with room
 * after it for a stopped run to be written down (`HARD_STOP_GRACE_MS`). Most
 * steps are one model reply and a few tool calls, well under this.
 */
export const DEFAULT_SHUTDOWN_STEP_WAIT_MS = 45_000;
const MIN_SHUTDOWN_STEP_WAIT_MS = 1_000;
const MAX_SHUTDOWN_STEP_WAIT_MS = 5 * 60_000;

/** `WORK_SHUTDOWN_STEP_WAIT_MS`, bounded; the default when unset or unreadable. */
export function shutdownStepWaitMs(raw: string | undefined = process.env.WORK_SHUTDOWN_STEP_WAIT_MS): number {
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_SHUTDOWN_STEP_WAIT_MS;
  return Math.min(MAX_SHUTDOWN_STEP_WAIT_MS, Math.max(MIN_SHUTDOWN_STEP_WAIT_MS, value));
}

/**
 * After the step wait, how long a run stopped mid-step is given to unwind and
 * be written down (its checkpoint, its ending, its transcript) before the
 * runner exits regardless. Not tunable: it is the margin between the step wait
 * and PM2's kill.
 */
export const HARD_STOP_GRACE_MS = 8_000;

/** Room left after the grace for the process to exit before PM2's kill. */
export const SHUTDOWN_EXIT_MARGIN_MS = 2_000;

/**
 * The step wait, fitted inside the time PM2 gives this process before it
 * kills it.
 *
 * PM2 hands an app its own settings as environment variables, `kill_timeout`
 * among them (juno-work sets 60 s in deploy/ecosystem.config.js). A step wait
 * raised in the environment without raising `kill_timeout` would otherwise be
 * cut by SIGKILL in the middle of the drain. Outside PM2 (no `kill_timeout`),
 * or with one that cannot be read, the wait is left as it is.
 */
export function fittedShutdownStepWaitMs(
  stepWaitMs: number,
  killTimeoutRaw: string | undefined = process.env.kill_timeout
): number {
  const killTimeoutMs = killTimeoutRaw === undefined || killTimeoutRaw.trim() === "" ? Number.NaN : Number(killTimeoutRaw.trim());
  if (!Number.isFinite(killTimeoutMs) || killTimeoutMs <= 0) return stepWaitMs;
  return Math.max(0, Math.min(stepWaitMs, killTimeoutMs - HARD_STOP_GRACE_MS - SHUTDOWN_EXIT_MARGIN_MS));
}

/**
 * How long after the stop request the runner exits even though its main
 * loop's tick has not returned (a docker CLI or a query that never answers),
 * once the drain has resolved: the step wait, the grace, and half the exit
 * margin. With the step wait fitted to `kill_timeout`, that is before PM2's
 * SIGKILL, which with `treekill: false` would leave the tick's children behind.
 */
export function shutdownExitDeadlineMs(stepWaitMs: number): number {
  return stepWaitMs + HARD_STOP_GRACE_MS + SHUTDOWN_EXIT_MARGIN_MS / 2;
}

/**
 * The longest one heartbeat write may hold the drain. A write that waits on a
 * slow database (its pool waits up to 20 s for a connection) must not push the
 * drain past PM2's kill; the write itself is left to finish or fail on its own.
 */
export const DRAIN_POLL_WRITE_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** `WorkRun.pauseReason` of a run set aside for a restart. Not a client vocabulary. */
export const RESTART_PAUSE_REASON = "server_restart";

/** The `cause` the runner writes on the `paused` and `resumed` events of such a run. */
export const RESTART_EVENT_CAUSE = "server_restart";
/** The `cause` on the `paused` event of a run stopped in the middle of a step. */
export const RESTART_MID_STEP_EVENT_CAUSE = "server_restart_mid_step";
/**
 * The `cause` on the `paused` event of a run that reached its step boundary
 * after a tool call that may have been cut short by the restart.
 */
export const RESTART_CUT_SHORT_EVENT_CAUSE = "server_restart_tool_cut";

/** What the timeline says when the run is set aside (the `paused` event's reason). */
export const RESTART_PAUSED_COPY = "Stopped between two steps for a server restart. Its progress is saved.";

/** What the timeline says when a run is stopped mid-step (the `paused` event's reason). */
export const RESTART_STOPPED_MID_STEP_COPY = "Stopped in the middle of a step for a server restart.";

/**
 * The detail of the `resumed` event of a run the next runner continued
 * ("Resumed", then this).
 */
export const RESTART_RESUMED_DETAIL = "After a server restart.";

/** Why a run stopped mid-step ended (its terminal detail). */
export const RESTART_MID_STEP_DETAIL =
  `The server restarted while this task was in the middle of a step, so it was stopped there. ${PRODUCT_NAME} ` +
  "does not continue a task on its own when a step may have been cut short, because it may already have " +
  "changed something. Its progress is saved: review what it did, then continue it if you want to.";

/**
 * Why a run that reached its step boundary ended all the same: a tool call
 * that was running when the restart began failed, or ran in a process of its
 * own that the restart may have stopped (`RunRestartSignal`).
 */
export const RESTART_TOOL_CUT_DETAIL =
  `The server restarted while this task was using a tool, and that tool may have been cut short, so ${PRODUCT_NAME} ` +
  "did not continue the task on its own: it may already have changed something. Its progress is saved: review " +
  "what it did, then continue it if you want to.";

/** Why a run set aside for a restart was not continued: its checkpoint did not show every step finished. */
export const RESTART_NOT_RESUMED_DETAIL =
  `The server restarted while this task was running, and its saved progress does not show its last step ` +
  `finished, so ${PRODUCT_NAME} did not continue it on its own: it may already have changed something. Its ` +
  "progress is saved: review what it did, then continue it if you want to.";

/** Why a run set aside for a restart was not continued: continuing after a restart is switched off. */
export const RESTART_RESUME_OFF_DETAIL =
  "The server restarted while this task was running. It stopped between two steps and its progress is " +
  "saved; continue it when you're ready.";

/** The message of the park signal thrown at a step boundary (`WorkRunParked`). */
export const RESTART_PARK_MESSAGE = "paused-for-server-restart";

// ---------------------------------------------------------------------------
// The clean-checkpoint rule
// ---------------------------------------------------------------------------

/**
 * The results the agent loop writes for a tool call that never finished
 * (runner/agent-core/src/loop.ts): one that threw or was cut short, and ones
 * that never started because the run stopped first. Any of them in the
 * trailing exchange means the run was not stopped between two steps.
 */
export const STOPPED_TOOL_RESULTS: ReadonlySet<string> = new Set([
  "Stopped before this finished.",
  "Cancelled.",
  "Not started — the run stopped first.",
]);

export type RestartCheckpointVerdict =
  | { clean: true }
  | {
      clean: false;
      why:
        /** No checkpoint at all: nothing proves anything. */
        | "missing"
        /** Not the shape this runtime restores (`persistedCheckpoint` in the runner). */
        | "unreadable"
        /** The model asked for a tool call whose result is not in the transcript. */
        | "unanswered_call"
        /** A tool call of the last step stopped before it finished, or never started. */
        | "tool_in_flight";
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parts(message: Record<string, unknown> | null): Record<string, unknown>[] {
  const content = message?.content;
  return Array.isArray(content) ? content.map(record).filter((part): part is Record<string, unknown> => part !== null) : [];
}

/**
 * Whether a run's checkpoint proves it stopped between two steps: the last
 * step's tool calls all have their results recorded, and none of them is a
 * stopped placeholder.
 *
 * Read from the trailing exchange only, the way `parkedToolCalls` reads it in
 * the runtime: the model's last message and the results that answer it. An
 * older stopped call is one the model already read and moved past. A run whose
 * transcript ends on the model's own words with no tool call (it was answering)
 * or on the goal (it had not asked for anything yet) has nothing in flight.
 *
 * Conservative where it cannot tell: a call stopped at an earlier park whose
 * placeholder is still the newest result reads as in flight, and that run ends
 * `interrupted` rather than being continued.
 *
 * The second line, not the first. A tool that gave up part-way when its run
 * was stopped may record an error of its own, which no shape can tell from a
 * call that finished; so the runner never parks a run it stopped mid-step, and
 * only ever parks one that stopped itself at a step boundary with no tool call
 * the restart may have reached (`RunRestartSignal.outcome`). This check then
 * holds every parked run to the same proof before it is continued.
 */
export function restartCheckpointVerdict(checkpoint: unknown, runId: string): RestartCheckpointVerdict {
  if (checkpoint === null || checkpoint === undefined) return { clean: false, why: "missing" };
  const value = record(checkpoint);
  if (
    !value ||
    value.version !== 1 ||
    value.runId !== runId ||
    !Array.isArray(value.messages) ||
    !record(value.plan) ||
    !record(value.budget)
  ) {
    return { clean: false, why: "unreadable" };
  }
  const messages = (value.messages as unknown[]).map(record);
  if (messages.some((message) => message === null)) return { clean: false, why: "unreadable" };
  const last = messages[messages.length - 1] ?? null;
  if (!last) return { clean: true };

  if (last.role === "assistant") {
    return parts(last).some((part) => part.type === "tool_call") ? { clean: false, why: "unanswered_call" } : { clean: true };
  }
  if (last.role !== "user") return { clean: false, why: "unreadable" };

  const results = parts(last).filter((part) => part.type === "tool_result");
  if (results.some((part) => typeof part.content !== "string" || STOPPED_TOOL_RESULTS.has(part.content))) {
    return { clean: false, why: "tool_in_flight" };
  }
  const asked = messages[messages.length - 2] ?? null;
  if (asked?.role === "assistant") {
    const answered = new Set(results.map((part) => part.toolCallId));
    const unanswered = parts(asked).some((part) => part.type === "tool_call" && !answered.has(part.id));
    if (unanswered) return { clean: false, why: "unanswered_call" };
  }
  return { clean: true };
}

// ---------------------------------------------------------------------------
// Stopping one run at a step boundary
// ---------------------------------------------------------------------------

/**
 * Tool calls that do their work through a child process of the runner: the
 * Work browser (Chromium, through Playwright) and the computer tools (`docker
 * exec`, through the broker). A signal that reaches the runner's process tree
 * reaches them too, and what they report afterwards ("the browser has been
 * closed", "exit 130") cannot be told from a call that really failed, or from
 * one whose command is still running inside the computer. Every computer tool
 * counts, whichever provider serves it (a separate computer host is reached
 * over HTTPS instead): a command cut off from its runner may still be running
 * in the computer, and treating one as reached costs only an automatic resume.
 */
export function toolRunsInChildProcess(tool: string): boolean {
  return tool === "browser" || tool.startsWith("computer_");
}

/**
 * One driven run's side of a restart: asked to stop at its next step boundary,
 * and, when the wait runs out, to stop where it is.
 *
 * Created when the run is claimed and held beside its lease renewal, so the
 * shutdown reaches every run in flight. A run claimed after the shutdown began
 * starts already asked, and stops before its first model request.
 *
 * It also watches the run's tool calls (`toolStarted`, `toolFinished`, fed from
 * the session's `tool_started` and `tool_finished` events), because reaching a
 * step boundary only proves every call returned, not that the restart left
 * each one alone. PM2 is told to signal the runner only (`treekill: false` on
 * juno-work), but a stop can still come from elsewhere: a terminal's Ctrl-C,
 * or a host shutdown that signals every process. So a run whose boundary
 * follows a call the restart may have reached is not set aside to be
 * continued; it ends `interrupted` like a run stopped mid-step
 * (`outcome()` is `"cut_short"`). A call may have been reached when:
 *   - it was running when the restart was asked for and then failed;
 *   - it was running then and works through a child process
 *     (`toolRunsInChildProcess`), whatever it reported;
 *   - it works through a child process, started after the restart was asked
 *     for, and failed.
 */
export class RunRestartSignal {
  /** The runner is shutting down: stop at the next step boundary. */
  requested = false;
  /** The run stopped at a step boundary (`pauseAtStepBoundary`). */
  pausedAtBoundary = false;
  /** The run was stopped where it was, after the wait ran out. */
  hardStopApplied = false;
  /** The tool call the restart may have cut short, once there is one. */
  cutShort: { callId: string; tool: string } | null = null;
  private hardStop: (() => boolean) | null = null;
  /** Calls started and not yet finished: call id to tool name. */
  private readonly running = new Map<string, string>();
  /** Calls that were running when the restart was asked for. */
  private readonly runningAtRequest = new Set<string>();

  constructor(requested = false) {
    this.requested = requested;
  }

  request(): void {
    if (this.requested) return;
    this.requested = true;
    for (const [callId, tool] of this.running) {
      if (toolRunsInChildProcess(tool)) this.cutShort ??= { callId, tool };
      this.runningAtRequest.add(callId);
    }
  }

  /** A tool call of this run (or of a child it delegated to) started. */
  toolStarted(callId: string, tool: string): void {
    this.running.set(callId, tool);
  }

  /** That call returned, with `isError` as recorded in the transcript. */
  toolFinished(callId: string, isError: boolean): void {
    const tool = this.running.get(callId) ?? "";
    this.running.delete(callId);
    const wasRunning = this.runningAtRequest.delete(callId);
    if (!isError || !this.requested) return;
    if (wasRunning || toolRunsInChildProcess(tool)) this.cutShort ??= { callId, tool };
  }

  /**
   * How to stop the run where it is: pause its session, which aborts the step
   * in progress. Returns whether there was a session to pause. Set once the
   * session exists; before that, the boundary check stops the run at its
   * first model request instead.
   */
  onHardStop(stop: () => boolean): void {
    this.hardStop = stop;
  }

  /** Stops the run where it is, unless it already stopped at a boundary. */
  stopNow(): void {
    this.request();
    if (this.pausedAtBoundary || this.hardStopApplied) return;
    if (this.hardStop?.()) this.hardStopApplied = true;
  }

  /**
   * How the run stopped for the restart, if it did: at a step boundary with
   * nothing the restart may have reached (the only way it may be continued),
   * at a step boundary after a tool call it may have cut short, or in the
   * middle of a step.
   */
  outcome(): RestartStopOutcome | null {
    if (this.pausedAtBoundary) return this.cutShort ? "cut_short" : "boundary";
    if (this.hardStopApplied) return "mid_step";
    return null;
  }
}

/** How a run stopped for a restart; only `boundary` is set aside to be continued. */
export type RestartStopOutcome = "boundary" | "cut_short" | "mid_step";

/** The part of a model provider the boundary wrapper needs; agent-core's `ProviderAdapter` is one. */
export interface StepProvider<Capabilities, Request extends { cacheKey?: string }, Event> {
  id: string;
  name: string;
  defaultModel: string;
  models(): string[];
  capabilities(model: string): Capabilities;
  stream(request: Request): AsyncGenerator<Event>;
}

/**
 * The run's provider, stopping the run at its next step boundary once a
 * restart asks it to.
 *
 * The agent loop calls `stream` once at the start of every step, after every
 * tool call of the step before has returned and its result is pushed and
 * checkpointed — so this is the step boundary by construction. When the
 * restart signal is up it pauses the session (`pause`) and throws the
 * runtime's park signal (`park`, `WorkRunParked`) before anything goes out:
 * the loop records nothing for the step that did not start, and the session
 * returns `paused` with the transcript exactly as the last step left it.
 *
 * Only the run's own step requests count: the loop sends them with the run's
 * id as the prompt-cache key (`cacheKey`). A delegated child's requests carry
 * `<runId>:<childId>`, and a context summary carries none, so a child working
 * inside a step finishes that step, and the step's end is where the run stops.
 *
 * Wrapped outside the steering reader, so an instruction the person added is
 * not taken from the queue for a request that never goes out.
 */
export function pauseAtStepBoundary<Capabilities, Request extends { cacheKey?: string }, Event>(
  provider: StepProvider<Capabilities, Request, Event>,
  options: { runId: string; signal: RunRestartSignal; pause: () => void; park: () => Error }
): StepProvider<Capabilities, Request, Event> {
  const { runId, signal } = options;
  return {
    id: provider.id,
    name: provider.name,
    defaultModel: provider.defaultModel,
    models: () => provider.models(),
    capabilities: (model: string) => provider.capabilities(model),
    async *stream(request: Request) {
      if (signal.requested && !signal.pausedAtBoundary && !signal.hardStopApplied && request.cacheKey === runId) {
        signal.pausedAtBoundary = true;
        options.pause();
        throw options.park();
      }
      yield* provider.stream(request);
    },
  };
}

// ---------------------------------------------------------------------------
// Draining a runner
// ---------------------------------------------------------------------------

export interface DrainRunsInput {
  /** The signals of the runs still being driven, read afresh on every check. */
  signals: () => Iterable<RunRestartSignal>;
  /** How many runs are still being driven. */
  remaining: () => number;
  stepWaitMs: number;
  hardStopGraceMs?: number;
  pollMs?: number;
  /**
   * Called on every poll while waiting (the runner keeps its heartbeat).
   * Waited on for `onPollTimeoutMs` at most, and never for longer than the
   * wait has left; a failure is ignored.
   */
  onPoll?: () => void | Promise<void>;
  onPollTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Waits for `work`, but `ms` at most; a rejection counts as done. */
async function waitAtMost(work: void | Promise<void>, ms: number): Promise<void> {
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.resolve(work).catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

export interface DrainRunsResult {
  /** Runs still driven when the wait ran out, which were stopped mid-step. */
  stoppedMidStep: number;
  /** Runs still driven after the grace: the process exits with them in flight. */
  left: number;
  waitedMs: number;
}

/**
 * Waits for every driven run to reach its step boundary and be set aside,
 * then stops whatever is still inside a step, then gives those a moment to be
 * written down. Never waits longer than `stepWaitMs + hardStopGraceMs`.
 */
export async function drainRuns(input: DrainRunsInput): Promise<DrainRunsResult> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = input.pollMs ?? 250;
  const started = now();
  for (const signal of input.signals()) signal.request();

  const pollWriteMs = input.onPollTimeoutMs ?? DRAIN_POLL_WRITE_TIMEOUT_MS;
  const waitUntil = async (deadline: number): Promise<void> => {
    while (input.remaining() > 0 && now() < deadline) {
      let polled: void | Promise<void>;
      try {
        polled = input.onPoll?.();
      } catch {
        polled = undefined;
      }
      await waitAtMost(polled, Math.min(pollWriteMs, deadline - now()));
      if (input.remaining() === 0 || now() >= deadline) break;
      await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
    }
  };

  await waitUntil(started + input.stepWaitMs);
  let stoppedMidStep = 0;
  if (input.remaining() > 0) {
    for (const signal of input.signals()) {
      signal.stopNow();
      if (signal.hardStopApplied) stoppedMidStep += 1;
    }
    await waitUntil(now() + (input.hardStopGraceMs ?? HARD_STOP_GRACE_MS));
  }
  return { stoppedMidStep, left: input.remaining(), waitedMs: now() - started };
}
