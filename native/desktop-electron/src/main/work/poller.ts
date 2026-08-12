/**
 * The Work poller — and, first, the pure arithmetic it is made of.
 *
 * ## Why a poller exists at all
 *
 * Work is not in the account change feed. `src/main/sync/types.ts` enumerates
 * the 22 entity types the server's change-capture triggers emit and no `work_*`
 * type is among them, so no Work state change reaches this process on its own.
 * Main has to ask. That is not a limitation to be hidden behind a spinner: the
 * interval is a fact the reader is entitled to, and `work:poll-state` is the
 * channel that carries it.
 *
 * ## Why the scheduling is a set of pure functions
 *
 * Everything below the `WorkPoller` class is a function of its arguments —
 * no timer, no socket, no clock read. `reducePollState` takes the state, one
 * event and a context carrying `now`, and returns the next state. That is the
 * part with the invariants worth being sure about (a failure must not blank the
 * data, a watched session must poll faster than an unwatched one, backoff must
 * be bounded), and it is exercised in `tests/unit/work-service.test.ts` without
 * a single fake timer.
 *
 * `WorkPoller` is then a thin shell: it holds a `setTimeout`, calls an injected
 * fetch function, and feeds the result back through the reducer.
 */

import type { WorkPollState, WorkSessionSummary, WorkSnapshot } from '../../shared/contracts/work.js';
import { isTerminalStatus, needsAttention } from '../../shared/contracts/work-vocabulary.js';

/* -------------------------------------------------------------------------- */
/* Timing                                                                      */
/* -------------------------------------------------------------------------- */

export interface PollTiming {
  /** Watched, and an executor could still move. The reader is watching it work. */
  readonly liveMs: number;
  /**
   * Watched, and stopped on a question or an approval.
   *
   * Slower than `liveMs` on purpose: nothing will change until the reader acts
   * or the approval's own TTL expires, and polling hard at a run that is
   * waiting for *them* is spend with nothing to find.
   */
  readonly attentionMs: number;
  /** Watched, and the run has finished. Only a new attempt can change anything. */
  readonly terminalMs: number;
  /** Watched, and no attempt has ever been dispatched. */
  readonly draftMs: number;
  /**
   * Unwatched. `null` means "do not poll this session at all", which is the
   * honest setting: nothing is on screen to go stale.
   */
  readonly unwatchedMs: number | null;
  /** The task list's own cadence. Independent of whichever session is watched. */
  readonly tasksMs: number;
  readonly backoffFactor: number;
  readonly maxBackoffMs: number;
  /** ±ratio of jitter, so N windows do not stampede the backend in lockstep. */
  readonly jitterRatio: number;
}

/**
 * The defaults.
 *
 * `liveMs` is 3s rather than the sub-second rate the web's SSE route polls
 * Postgres at, because this is a network round trip from a laptop and not a
 * query inside the datacentre. The freshness bar makes the difference legible —
 * "read 2s ago" is a true sentence and a fake liveness animation is not.
 */
export const WORK_POLL_TIMING: PollTiming = {
  liveMs: 3_000,
  attentionMs: 8_000,
  terminalMs: 60_000,
  draftMs: 30_000,
  unwatchedMs: null,
  tasksMs: 30_000,
  backoffFactor: 2,
  maxBackoffMs: 5 * 60_000,
  jitterRatio: 0.1,
};

/* -------------------------------------------------------------------------- */
/* Activity — what the poller knows about the thing it is polling              */
/* -------------------------------------------------------------------------- */

/**
 * How lively the watched session is, as four mutually exclusive facts.
 *
 * Derived from the status vocabulary rather than guessed: `isTerminalStatus`
 * and `needsAttention` are transcriptions of the contract, and re-deriving
 * either here would be a second copy that can drift from the server's.
 */
export type PollActivity = 'live' | 'attention' | 'terminal' | 'draft';

export function activityForStatus(status: string | null): PollActivity {
  if (status === null) return 'draft';
  if (!isKnownStatus(status)) {
    /* A status this build cannot name is polled at the live rate. The cost of
       being wrong that way is a few extra requests; the other way is a UI that
       stops refreshing a run it does not understand. */
    return 'live';
  }
  if (needsAttention(status)) return 'attention';
  if (isTerminalStatus(status)) return 'terminal';
  return 'live';
}

function isKnownStatus(value: string): value is Parameters<typeof needsAttention>[0] {
  try {
    needsAttention(value as Parameters<typeof needsAttention>[0]);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* The pure scheduling arithmetic                                              */
/* -------------------------------------------------------------------------- */

export interface ScheduleInput {
  readonly watched: boolean;
  readonly activity: PollActivity;
  /** Zero after any success. Drives the backoff and nothing else. */
  readonly consecutiveFailures: number;
}

/**
 * The interval before backoff. `null` means "do not schedule anything".
 *
 * An unwatched session is the case that matters here: the contract says exactly
 * one session is polled at a time and `work:watch-task` is how the renderer says
 * which. A session nobody is looking at is not polled rarely — it is not polled,
 * and the freshness bar for it would be about a screen that is not on screen.
 */
export function baseIntervalMs(input: ScheduleInput, timing: PollTiming): number | null {
  if (!input.watched) return timing.unwatchedMs;
  switch (input.activity) {
    case 'live':
      return timing.liveMs;
    case 'attention':
      return timing.attentionMs;
    case 'terminal':
      return timing.terminalMs;
    case 'draft':
      return timing.draftMs;
  }
}

/**
 * Exponential backoff, capped, with symmetric jitter.
 *
 * `jitter01` is supplied rather than read from `Math.random`, which is what
 * makes this assertable: the tests pass 0.5 and get the un-jittered value back.
 */
export function backoffMs(
  base: number,
  consecutiveFailures: number,
  timing: PollTiming,
  jitter01 = 0.5,
): number {
  if (consecutiveFailures <= 0) return base;
  const grown = base * Math.pow(timing.backoffFactor, consecutiveFailures);
  const capped = Math.min(grown, timing.maxBackoffMs);
  /* jitter01 of 0.5 is the midpoint and therefore no jitter at all, so a test
     that pins it reads the pure exponential. */
  const spread = capped * timing.jitterRatio * (jitter01 * 2 - 1);
  return Math.max(0, Math.round(capped + spread));
}

/** The whole schedule in one call: base interval, then backoff. `null` = never. */
export function pollIntervalMs(
  input: ScheduleInput,
  timing: PollTiming,
  jitter01 = 0.5,
): number | null {
  const base = baseIntervalMs(input, timing);
  if (base === null) return null;
  return backoffMs(base, input.consecutiveFailures, timing, jitter01);
}

/* -------------------------------------------------------------------------- */
/* The pure state machine                                                      */
/* -------------------------------------------------------------------------- */

export type PollEvent =
  /** The renderer attached or detached the poller. */
  | { readonly type: 'watch'; readonly sessionId: string | null }
  /** A request went out. */
  | { readonly type: 'attempt' }
  /** A request came back with data. `cursorSeq` is the highest seq now held. */
  | { readonly type: 'success'; readonly cursorSeq: number }
  /**
   * A request failed. `offline` distinguishes "this app could not reach the
   * network" from "the backend answered and said no", which the freshness bar
   * words differently and which is the difference between waiting and acting.
   */
  | { readonly type: 'failure'; readonly error: string; readonly offline: boolean }
  /** Signed out, or the app is shutting down. Nothing is scheduled. */
  | { readonly type: 'suspend' }
  /** Signed back in. The next attempt is scheduled immediately. */
  | { readonly type: 'resume' };

export interface PollContext {
  readonly now: number;
  readonly activity: PollActivity;
  readonly timing: PollTiming;
  /** 0..1. Injected so the reducer is a function of its arguments. */
  readonly jitter01: number;
}

export const INITIAL_POLL_STATE: WorkPollState = {
  sessionId: null,
  phase: 'idle',
  intervalMs: 0,
  lastSucceededAt: null,
  lastAttemptedAt: null,
  nextAttemptAt: null,
  consecutiveFailures: 0,
  online: true,
  error: null,
  cursorSeq: 0,
};

/**
 * The whole poller, as a function.
 *
 * Three invariants live here and nowhere else:
 *
 *  1. **A failure never clears `lastSucceededAt` or `cursorSeq`.** The data the
 *     UI is drawing is still the last data that was true, and blanking the
 *     freshness stamp would turn "this is 40 seconds old" into "there is
 *     nothing", which is a different and false claim.
 *  2. **Watching a different session resets the cursor.** `seq` is unique per
 *     run, not per account, so carrying a cursor across sessions would skip
 *     events rather than replay them.
 *  3. **`suspended` schedules nothing.** `nextAttemptAt` is null, so the bar
 *     stops counting down to a refresh that is not coming.
 */
export function reducePollState(
  state: WorkPollState,
  event: PollEvent,
  context: PollContext,
): WorkPollState {
  const iso = (ms: number): string => new Date(ms).toISOString();

  switch (event.type) {
    case 'watch': {
      if (event.sessionId === null) {
        return { ...INITIAL_POLL_STATE, online: state.online };
      }
      const sameSession = state.sessionId === event.sessionId;
      const interval =
        pollIntervalMs(
          { watched: true, activity: context.activity, consecutiveFailures: 0 },
          context.timing,
          context.jitter01,
        ) ?? 0;
      return {
        sessionId: event.sessionId,
        phase: 'idle',
        intervalMs: interval,
        /* Freshness is about a session. Attaching to a different one means the
           app holds nothing about it yet, and saying otherwise would date the
           new session's panel from the old session's last successful read. */
        lastSucceededAt: sameSession ? state.lastSucceededAt : null,
        lastAttemptedAt: sameSession ? state.lastAttemptedAt : null,
        nextAttemptAt: iso(context.now),
        consecutiveFailures: sameSession ? state.consecutiveFailures : 0,
        online: state.online,
        error: sameSession ? state.error : null,
        cursorSeq: sameSession ? state.cursorSeq : 0,
      };
    }

    case 'attempt':
      return {
        ...state,
        phase: 'polling',
        lastAttemptedAt: iso(context.now),
        nextAttemptAt: null,
      };

    case 'success': {
      const interval =
        pollIntervalMs(
          {
            watched: state.sessionId !== null,
            activity: context.activity,
            consecutiveFailures: 0,
          },
          context.timing,
          context.jitter01,
        ) ?? 0;
      return {
        ...state,
        phase: 'ok',
        intervalMs: interval,
        lastSucceededAt: iso(context.now),
        lastAttemptedAt: iso(context.now),
        nextAttemptAt: interval > 0 ? iso(context.now + interval) : null,
        consecutiveFailures: 0,
        online: true,
        error: null,
        /* Monotonic. A delta that returns fewer events than the client already
           holds must not walk the cursor backwards and replay them. */
        cursorSeq: Math.max(state.cursorSeq, event.cursorSeq),
      };
    }

    case 'failure': {
      const failures = state.consecutiveFailures + 1;
      const interval =
        pollIntervalMs(
          {
            watched: state.sessionId !== null,
            activity: context.activity,
            consecutiveFailures: failures,
          },
          context.timing,
          context.jitter01,
        ) ?? 0;
      return {
        ...state,
        phase: 'failed',
        intervalMs: interval,
        /* Untouched, deliberately — invariant 1. */
        lastSucceededAt: state.lastSucceededAt,
        cursorSeq: state.cursorSeq,
        lastAttemptedAt: iso(context.now),
        nextAttemptAt: interval > 0 ? iso(context.now + interval) : null,
        consecutiveFailures: failures,
        online: !event.offline,
        error: event.error,
      };
    }

    case 'suspend':
      return { ...state, phase: 'suspended', nextAttemptAt: null };

    case 'resume':
      return state.sessionId === null
        ? { ...state, phase: 'idle', nextAttemptAt: null }
        : { ...state, phase: 'idle', nextAttemptAt: iso(context.now) };
  }
}

/* -------------------------------------------------------------------------- */
/* Change detection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Whether a poll actually found anything.
 *
 * A poll that changed nothing must not cause a re-render — that is the
 * difference between a freshness bar that ticks and a transcript that flickers
 * every three seconds. Compared on the fields that can move rather than by
 * deep-equalling the whole snapshot: `fetchedAt` changes on every single poll
 * by construction, so a naive comparison would always report a change.
 */
export function snapshotChanged(previous: WorkSnapshot | null, next: WorkSnapshot): boolean {
  if (previous === null) return true;
  if (next.events.length > 0) return true;
  if (next.replaced && !previous.replaced) return true;
  return snapshotFingerprint(previous) !== snapshotFingerprint(next);
}

function snapshotFingerprint(snapshot: WorkSnapshot): string {
  const run = snapshot.run;
  return [
    snapshot.session.id,
    snapshot.session.status,
    snapshot.session.title,
    snapshot.session.updatedAt,
    snapshot.session.archived ? '1' : '0',
    snapshot.session.pinned ? '1' : '0',
    run?.id ?? '-',
    run?.status ?? '-',
    String(run?.lastSeq ?? 0),
    String(run?.usage.costMicroUsd ?? 0),
    String(run?.usage.tokens ?? 0),
    run?.terminalReason ?? '-',
    /* Approvals and questions are the two things a reader must act on, so their
       identity and decision are part of the fingerprint even though neither
       moves the run's own status until the executor picks the answer up. */
    snapshot.approvals.map((approval) => `${approval.id}:${approval.decision}`).join(','),
    snapshot.questions.map((question) => question.id).join(','),
  ].join('|');
}

/** The same question for the task list. */
export function tasksChanged(
  previous: readonly WorkSessionSummary[] | null,
  next: readonly WorkSessionSummary[],
): boolean {
  if (previous === null) return true;
  if (previous.length !== next.length) return true;
  return tasksFingerprint(previous) !== tasksFingerprint(next);
}

function tasksFingerprint(tasks: readonly WorkSessionSummary[]): string {
  return tasks
    .map((task) =>
      [
        task.id,
        task.status,
        task.title,
        task.updatedAt,
        String(task.attempts),
        task.needsAttention ? '1' : '0',
        task.pinned ? '1' : '0',
        task.archived ? '1' : '0',
        task.openRequestSummary ?? '-',
      ].join(':'),
    )
    .join('|');
}

/* -------------------------------------------------------------------------- */
/* The shell                                                                   */
/* -------------------------------------------------------------------------- */

export interface PollResult {
  readonly snapshot: WorkSnapshot;
  /** The highest seq now held, which becomes the next request's `sinceSeq`. */
  readonly cursorSeq: number;
}

export interface WorkPollerPorts {
  /** One poll. Throws on failure; the reducer turns the throw into a state. */
  fetchSnapshot(sessionId: string, sinceSeq: number, signal: AbortSignal): Promise<PollResult>;
  fetchTasks(signal: AbortSignal): Promise<readonly WorkSessionSummary[]>;
  emitPollState(state: WorkPollState): void;
  emitSnapshot(snapshot: WorkSnapshot): void;
  emitTasks(tasks: readonly WorkSessionSummary[], fetchedAt: string): void;
  /** Message and reachability verdict for a thrown error. Never logs a token. */
  describeFailure(error: unknown): { message: string; offline: boolean };
  now(): number;
  /** 0..1. Defaults to `Math.random` in production, pinned under test. */
  jitter(): number;
  timing?: PollTiming;
}

/**
 * The timer-driven half.
 *
 * Deliberately small. Everything it decides, it decides by calling one of the
 * pure functions above; what is left here is a `setTimeout`, an `AbortController`
 * and the two caches that make "skip the no-op emission" possible.
 */
export class WorkPoller {
  readonly #ports: WorkPollerPorts;
  readonly #timing: PollTiming;

  #state: WorkPollState = INITIAL_POLL_STATE;
  #activity: PollActivity = 'draft';
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: AbortController | null = null;
  #suspended = false;
  #disposed = false;

  /** The last data that was true. A failed poll leaves both of these alone. */
  #lastSnapshot: WorkSnapshot | null = null;
  #lastTasks: readonly WorkSessionSummary[] | null = null;
  #tasksTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ports: WorkPollerPorts) {
    this.#ports = ports;
    this.#timing = ports.timing ?? WORK_POLL_TIMING;
  }

  get state(): WorkPollState {
    return this.#state;
  }

  /** The snapshot the UI is currently drawing, failures included. */
  get lastSnapshot(): WorkSnapshot | null {
    return this.#lastSnapshot;
  }

  /** Attach to a session, or detach with `null`. Returns the new poll state. */
  watch(sessionId: string | null): WorkPollState {
    this.#cancelInFlight();
    if (sessionId === null || sessionId !== this.#state.sessionId) {
      this.#lastSnapshot = null;
    }
    this.#apply({ type: 'watch', sessionId });
    if (sessionId === null) {
      this.#clearTimer();
      return this.#state;
    }
    this.#schedule(0);
    return this.#state;
  }

  /** Refresh now, out of band. Resets the interval; never queues behind it. */
  pollNow(sessionId: string): WorkPollState {
    if (this.#state.sessionId !== sessionId) return this.watch(sessionId);
    this.#cancelInFlight();
    this.#schedule(0);
    return this.#state;
  }

  /** Signed out. Stops every timer and reports `suspended` once. */
  suspend(): void {
    this.#suspended = true;
    this.#cancelInFlight();
    this.#clearTimer();
    if (this.#tasksTimer !== null) {
      clearTimeout(this.#tasksTimer);
      this.#tasksTimer = null;
    }
    this.#lastSnapshot = null;
    this.#lastTasks = null;
    this.#apply({ type: 'suspend' });
  }

  /** Signed back in. */
  resume(): void {
    if (this.#disposed) return;
    this.#suspended = false;
    this.#apply({ type: 'resume' });
    if (this.#state.sessionId !== null) this.#schedule(0);
    this.startTaskList();
  }

  /** Begin the task list's own slower loop. Independent of the watched session. */
  startTaskList(): void {
    if (this.#disposed || this.#suspended || this.#tasksTimer !== null) return;
    void this.#runTaskList();
  }

  dispose(): void {
    this.#disposed = true;
    this.suspend();
  }

  /** Record what the executor is doing, so the next interval is the right one. */
  setActivity(activity: PollActivity): void {
    this.#activity = activity;
  }

  /* ---------------------------------------------------------------------- */

  #context(): PollContext {
    return {
      now: this.#ports.now(),
      activity: this.#activity,
      timing: this.#timing,
      jitter01: this.#ports.jitter(),
    };
  }

  #apply(event: PollEvent): void {
    const next = reducePollState(this.#state, event, this.#context());
    /* Emitted on every transition, including the ones that fail — those are the
       ones the freshness bar exists for. Skipped only when nothing changed, so
       an unchanged bar does not re-render. */
    if (!samePollState(this.#state, next)) {
      this.#state = next;
      this.#ports.emitPollState(next);
    } else {
      this.#state = next;
    }
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #cancelInFlight(): void {
    if (this.#inFlight !== null) {
      this.#inFlight.abort();
      this.#inFlight = null;
    }
  }

  #schedule(delayMs: number): void {
    if (this.#disposed || this.#suspended) return;
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#runOnce();
    }, delayMs);
    this.#timer.unref?.();
  }

  async #runOnce(): Promise<void> {
    const sessionId = this.#state.sessionId;
    if (sessionId === null || this.#suspended || this.#disposed) return;

    const controller = new AbortController();
    this.#inFlight = controller;
    this.#apply({ type: 'attempt' });

    try {
      const result = await this.#ports.fetchSnapshot(
        sessionId,
        this.#state.cursorSeq,
        controller.signal,
      );
      if (controller.signal.aborted || this.#suspended || this.#disposed) return;

      this.#activity = activityForStatus(result.snapshot.run?.status ?? null);
      /* Compared BEFORE the state is replaced, so "nothing changed" is a
         statement about the data rather than about the clock. */
      const changed = snapshotChanged(this.#lastSnapshot, result.snapshot);
      this.#lastSnapshot = result.snapshot;
      this.#apply({ type: 'success', cursorSeq: result.cursorSeq });
      if (changed) this.#ports.emitSnapshot(result.snapshot);
    } catch (error) {
      if (controller.signal.aborted || this.#suspended || this.#disposed) return;
      const described = this.#ports.describeFailure(error);
      /* `#lastSnapshot` is untouched. The panel keeps drawing the last thing
         that was true and the bar says how old it is and why it is stuck. */
      this.#apply({ type: 'failure', error: described.message, offline: described.offline });
    } finally {
      if (this.#inFlight === controller) this.#inFlight = null;
    }

    const next = this.#state.nextAttemptAt;
    if (next !== null) {
      this.#schedule(Math.max(0, Date.parse(next) - this.#ports.now()));
    }
  }

  async #runTaskList(): Promise<void> {
    if (this.#disposed || this.#suspended) return;
    const controller = new AbortController();
    let delay = this.#timing.tasksMs;
    try {
      const tasks = await this.#ports.fetchTasks(controller.signal);
      if (this.#suspended || this.#disposed) return;
      if (tasksChanged(this.#lastTasks, tasks)) {
        this.#lastTasks = tasks;
        this.#ports.emitTasks(tasks, new Date(this.#ports.now()).toISOString());
      }
    } catch {
      /* The task list has no freshness bar of its own — `work:poll-state` is
         about the watched session — so a failure here backs off quietly and
         leaves the last list on screen rather than emptying it. */
      delay = Math.min(this.#timing.tasksMs * 4, this.#timing.maxBackoffMs);
    } finally {
      if (!this.#disposed && !this.#suspended) {
        this.#tasksTimer = setTimeout(() => {
          this.#tasksTimer = null;
          void this.#runTaskList();
        }, delay);
        this.#tasksTimer.unref?.();
      }
    }
  }
}

function samePollState(left: WorkPollState, right: WorkPollState): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.phase === right.phase &&
    left.intervalMs === right.intervalMs &&
    left.lastSucceededAt === right.lastSucceededAt &&
    left.lastAttemptedAt === right.lastAttemptedAt &&
    left.nextAttemptAt === right.nextAttemptAt &&
    left.consecutiveFailures === right.consecutiveFailures &&
    left.online === right.online &&
    left.error === right.error &&
    left.cursorSeq === right.cursorSeq
  );
}
