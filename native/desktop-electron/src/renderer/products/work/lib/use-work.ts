/**
 * The Work surface's state.
 *
 * One hook owns one task: it attaches main's poller, folds the deltas that come
 * back, and exposes the six things the UI can ask for. Components below it are
 * pure — they receive derived shapes and render them.
 *
 * The clock is a first-class citizen here, which is unusual and deliberate.
 * Every "as of" label on this surface is only true for a few seconds, so a
 * ticking `now` is threaded through rendering rather than each component reading
 * `Date.now()` on paint. `useNow` is the only thing in the product that ticks
 * for its own sake, and it ticks at 1s while a run is live and at 15s otherwise
 * — a settled task does not need a per-second re-render to tell you it finished
 * three hours ago.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  WorkApproval,
  WorkAuditEntry,
  WorkCapabilitiesSnapshot,
  WorkEmittedEvent,
  WorkPollState,
  WorkQuestion,
  WorkRun,
  WorkSession,
  WorkSnapshot,
} from '../contract.js';
import { describeWorkError, isWorkBridgeAvailable, workInvoke, workOn } from './bridge.js';
import type { WorkApprovalAnswer, WorkPermissionPolicy, WorkStatus } from './vocabulary.js';
import { approvalRefusalCopy, isLiveStatus } from './vocabulary.js';
import type { WorkControl } from './derive.js';

/* -------------------------------------------------------------------------- */
/* Clock                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A `now` that actually advances.
 *
 * Initialised in a lazy initialiser and advanced from an effect, so the value
 * is stable within a render pass. `intervalMs` is a hint, not a guarantee: the
 * timer is cleared while the window is hidden, because a background window
 * re-rendering once a second to update a label nobody is looking at is the
 * cheapest battery bug there is.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (typeof document !== 'undefined' && document.hidden) return undefined;
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(id);
    };
  }, [intervalMs]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVisibility = (): void => {
      if (!document.hidden) setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return now;
}

/* -------------------------------------------------------------------------- */
/* Task state                                                                  */
/* -------------------------------------------------------------------------- */

interface TaskState {
  readonly session: WorkSession | null;
  readonly run: WorkRun | null;
  readonly events: readonly WorkEmittedEvent[];
  readonly approvals: readonly WorkApproval[];
  readonly questions: readonly WorkQuestion[];
  readonly poll: WorkPollState;
  /** True until the first snapshot lands, whether it succeeds or fails. */
  readonly loading: boolean;
  /** A failure that is *this app's*, not the poller's. Actions set it. */
  readonly actionError: string | null;
}

type TaskAction =
  | { type: 'attach'; sessionId: string | null }
  | { type: 'snapshot'; snapshot: WorkSnapshot }
  | { type: 'poll'; poll: WorkPollState }
  | { type: 'action-error'; message: string | null };

function initialPoll(sessionId: string | null): WorkPollState {
  return {
    sessionId,
    phase: 'idle',
    intervalMs: 15_000,
    lastSucceededAt: null,
    lastAttemptedAt: null,
    nextAttemptAt: null,
    consecutiveFailures: 0,
    online: true,
    error: null,
    cursorSeq: 0,
  };
}

function initialState(sessionId: string | null): TaskState {
  return {
    session: null,
    run: null,
    events: [],
    approvals: [],
    questions: [],
    poll: initialPoll(sessionId),
    loading: sessionId !== null,
    actionError: null,
  };
}

/**
 * Folding a poll result into the log.
 *
 * `replaced` decides everything. A full replay must replace, or the same events
 * accumulate twice on every reconnect; a delta must append, or the earlier
 * history is thrown away every fifteen seconds. Getting this backwards produces
 * a plan that flickers between two versions, which is precisely the symptom the
 * server's `replaced` flag exists to prevent.
 */
function foldEvents(
  existing: readonly WorkEmittedEvent[],
  incoming: readonly WorkEmittedEvent[],
  replaced: boolean,
): readonly WorkEmittedEvent[] {
  if (replaced) return [...incoming].sort((a, b) => a.seq - b.seq);
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((event) => event.seq));
  const merged = [...existing];
  for (const event of incoming) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    merged.push(event);
  }
  merged.sort((a, b) => a.seq - b.seq);
  return merged;
}

function reduce(state: TaskState, action: TaskAction): TaskState {
  switch (action.type) {
    case 'attach':
      return initialState(action.sessionId);
    case 'snapshot': {
      const { snapshot } = action;
      return {
        ...state,
        session: snapshot.session,
        run: snapshot.run,
        events: foldEvents(state.events, snapshot.events, snapshot.replaced),
        approvals: snapshot.approvals,
        questions: snapshot.questions,
        loading: false,
      };
    }
    case 'poll':
      return { ...state, poll: action.poll, loading: state.loading && action.poll.phase === 'polling' };
    case 'action-error':
      return { ...state, actionError: action.message };
    default:
      return state;
  }
}

export interface WorkTaskActions {
  /** Refresh now, out of band. Resets the interval rather than queueing behind it. */
  readonly refresh: () => Promise<void>;
  readonly control: (control: Extract<WorkControl, 'pause' | 'resume' | 'cancel'>) => Promise<void>;
  /** A new attempt. Overrides are attempt-scoped and do not edit the task. */
  readonly retry: (overrides?: {
    readonly permissionPolicy?: WorkPermissionPolicy;
    readonly model?: string;
  }) => Promise<void>;
  /** With a question id it answers; without, it records steering. */
  readonly answer: (
    questionId: string | null,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  readonly resolveApproval: (
    approval: WorkApproval,
    decision: WorkApprovalAnswer,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  readonly openArtifact: (
    artifactId: string,
    version: number,
    reveal: boolean,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  readonly clearError: () => void;
}

export interface WorkTaskView extends TaskState {
  /** The status the surface should trust: the run's, falling back to the task's. */
  readonly status: WorkStatus | null;
  /** Which control is mid-flight, so the UI can disable it without inventing a state. */
  readonly busy: WorkControl | null;
  readonly bridgeAvailable: boolean;
  readonly actions: WorkTaskActions;
}

export function useWorkTask(sessionId: string | null): WorkTaskView {
  const [state, dispatch] = useReducer(reduce, sessionId, initialState);
  const [busy, setBusy] = useState<WorkControl | null>(null);
  const bridgeAvailable = useMemo(() => isWorkBridgeAvailable(), []);

  /* The attached session, read inside callbacks without making every callback
     change identity when the snapshot does. */
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = state.run?.id ?? null;

  useEffect(() => {
    dispatch({ type: 'attach', sessionId });
    let cancelled = false;

    void workInvoke('work:watch-task', { sessionId })
      .then((poll) => {
        if (!cancelled) dispatch({ type: 'poll', poll });
      })
      .catch((error: unknown) => {
        if (!cancelled) dispatch({ type: 'action-error', message: describeWorkError(error) });
      });

    return () => {
      cancelled = true;
      /* Detach rather than leaving main polling a task nobody is looking at.
         Fire-and-forget: a failed detach is main's problem to time out, and
         surfacing it here would be an error about a screen that is gone. */
      void workInvoke('work:watch-task', { sessionId: null }).catch(() => undefined);
    };
  }, [sessionId]);

  useEffect(() => {
    const offSnapshot = workOn('work:snapshot', (snapshot) => {
      if (snapshot.session.id !== sessionIdRef.current) return;
      dispatch({ type: 'snapshot', snapshot });
    });
    const offPoll = workOn('work:poll-state', (poll) => {
      if (poll.sessionId !== sessionIdRef.current) return;
      dispatch({ type: 'poll', poll });
    });
    return () => {
      offSnapshot();
      offPoll();
    };
  }, []);

  const run = useCallback(
    async (control: WorkControl, work: () => Promise<void>): Promise<void> => {
      setBusy(control);
      dispatch({ type: 'action-error', message: null });
      try {
        await work();
      } catch (error: unknown) {
        dispatch({ type: 'action-error', message: describeWorkError(error) });
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const actions = useMemo<WorkTaskActions>(() => {
    const refresh = async (): Promise<void> => {
      const id = sessionIdRef.current;
      if (id === null) return;
      try {
        const poll = await workInvoke('work:poll-now', { sessionId: id });
        dispatch({ type: 'poll', poll });
      } catch (error: unknown) {
        dispatch({ type: 'action-error', message: describeWorkError(error) });
      }
    };

    return {
      refresh,

      control: async (control) => {
        const runId = runIdRef.current;
        if (runId === null) return;
        await run(control, async () => {
          await workInvoke('work:control-run', { runId, action: control });
          await refresh();
        });
      },

      retry: async (overrides) => {
        const id = sessionIdRef.current;
        if (id === null) return;
        await run('retry', async () => {
          await workInvoke('work:dispatch-run', {
            sessionId: id,
            ...(overrides?.permissionPolicy === undefined
              ? {}
              : { permissionPolicy: overrides.permissionPolicy }),
            ...(overrides?.model === undefined ? {} : { model: overrides.model }),
          });
          await refresh();
        });
      },

      answer: async (questionId, text) => {
        const id = sessionIdRef.current;
        if (id === null) return { ok: false, message: 'No task is open.' };
        try {
          const result = await workInvoke('work:answer', { sessionId: id, questionId, text });
          if (result.ok) {
            await refresh();
            return { ok: true };
          }
          return { ok: false, message: ANSWER_REFUSALS[result.reason] };
        } catch (error: unknown) {
          return { ok: false, message: describeWorkError(error) };
        }
      },

      resolveApproval: async (approval, decision) => {
        try {
          const result = await workInvoke('work:resolve-approval', {
            approvalId: approval.id,
            decision,
            actionDigest: approval.actionDigest,
          });
          await refresh();
          if (result.ok) return { ok: true };
          /* Each of the five refusals has its own sentence and its own next
             move. `detail` is the server's own words and is appended only when
             it adds something — a refusal rendered as a generic error is a user
             pressing the same button again. */
          const named = approvalRefusalCopy(result.refusal);
          return {
            ok: false,
            message: result.detail.trim().length === 0 ? named : `${named} (${result.detail})`,
          };
        } catch (error: unknown) {
          return { ok: false, message: describeWorkError(error) };
        }
      },

      openArtifact: async (artifactId, version, reveal) => {
        try {
          const result = await workInvoke('work:open-artifact', { artifactId, version, reveal });
          return result.ok ? { ok: true } : { ok: false, message: result.reason };
        } catch (error: unknown) {
          return { ok: false, message: describeWorkError(error) };
        }
      },

      clearError: () => {
        dispatch({ type: 'action-error', message: null });
      },
    };
  }, [run]);

  const status: WorkStatus | null = state.run?.status ?? state.session?.status ?? null;

  return { ...state, status, busy, bridgeAvailable, actions };
}

/**
 * The three ways the answer route says no, each with its own sentence.
 *
 * `waiting_input` is the one worth reading twice: a stopped run refuses a
 * *steering* message, because delivering one would tell the user their words
 * reached something that had not moved.
 */
const ANSWER_REFUSALS: Record<'waiting_input' | 'not_live' | 'unknown_question', string> = {
  waiting_input:
    'This run is stopped on a question. Answer the question above — an instruction sent now would reach nothing.',
  not_live: 'This attempt is over, so there is nothing to send it to. Start another attempt instead.',
  unknown_question:
    'That question is no longer open — it may have been answered from another device.',
};

/**
 * How fast the surface should re-render for its own labels.
 *
 * One second while a run is live, because "3s ago" going stale is the entire
 * point of the freshness affordance. Fifteen otherwise.
 */
export function clockIntervalFor(status: WorkStatus | null): number {
  if (status === null) return 15_000;
  return isLiveStatus(status) ? 1_000 : 15_000;
}

/* -------------------------------------------------------------------------- */
/* Secondary fetches                                                           */
/* -------------------------------------------------------------------------- */

export interface AsyncValue<T> {
  readonly value: T | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

/**
 * The audit trail, fetched only when somebody opens it.
 *
 * Separate from the snapshot on purpose: it is a different table behind a
 * different route, it can be long, and nobody reads it on the way past. Loading
 * it with every poll would put a security log on the wire every fifteen seconds
 * for the benefit of nobody.
 */
export function useWorkAudit(sessionId: string | null, enabled: boolean): AsyncValue<readonly WorkAuditEntry[]> {
  const [value, setValue] = useState<readonly WorkAuditEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (sessionId === null || !enabled) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void workInvoke('work:audit-trail', { sessionId })
      .then((result) => {
        if (cancelled) return;
        setValue(result.entries);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(describeWorkError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled, nonce]);

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  return { value, loading, error, reload };
}

/** What the composer may offer. Server truth; nothing is assumed available. */
export function useWorkCapabilities(enabled: boolean): AsyncValue<WorkCapabilitiesSnapshot> {
  const [value, setValue] = useState<WorkCapabilitiesSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void workInvoke('work:capabilities')
      .then((result) => {
        if (!cancelled) setValue(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(describeWorkError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce]);

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  return { value, loading, error, reload };
}
