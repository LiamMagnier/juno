/**
 * The Work service's two testable halves.
 *
 * **The poller's scheduling**, which is written as pure functions precisely so
 * that it can be asserted without a timer or a socket. The clock and the jitter
 * are arguments, so every expectation below is an exact number rather than a
 * range, and the four properties that matter — the interval follows the run, a
 * watched session polls and an unwatched one does not, backoff is exponential
 * and bounded, and **a failure never blanks the last known data** — are each
 * pinned by a test that would fail if it stopped being true.
 *
 * **The refusal mapping**, which is the other place a bug is invisible. Every
 * refusal this surface can produce is a named one, and a refusal reported as a
 * generic error is a user pressing the same button again. The mapping is from
 * the server's own codes (`APPROVAL_DECISION_REFUSALS` and the answer route's
 * 409s), so these tests are as much a record of what the backend sends as they
 * are a check on what this code does with it.
 *
 * Nothing here touches the network, the filesystem or Electron — which is the
 * reason `service.ts` takes its ports rather than importing them.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, NetworkError, TimeoutError, UnauthorizedError } from '../../src/main/auth/transport.js';
import type {
  WorkPollState,
  WorkSessionSummary,
  WorkSnapshot,
} from '../../src/shared/contracts/work.js';
import {
  INITIAL_POLL_STATE,
  WORK_POLL_TIMING,
  WorkPoller,
  activityForStatus,
  backoffMs,
  baseIntervalMs,
  pollIntervalMs,
  reducePollState,
  snapshotChanged,
  tasksChanged,
  type PollContext,
  type PollTiming,
  type WorkPollerPorts,
} from '../../src/main/work/poller.js';
import {
  answerRefusal,
  applySkillSlug,
  approvalRefusal,
  describeFailure,
} from '../../src/main/work/service.js';
import { GrantVault } from '../../src/main/work/grants.js';
import {
  toWorkEvent,
  toWorkHostRef,
  toWorkRun,
  toWorkSessionSummary,
  type WireEvent,
  type WireHost,
  type WireRun,
  type WireSession,
} from '../../src/main/work/wire.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const T0 = Date.parse('2026-08-13T10:00:00.000Z');

/** No jitter: 0.5 is the midpoint of the ±ratio spread. */
const NO_JITTER = 0.5;

function context(overrides: Partial<PollContext> = {}): PollContext {
  return {
    now: T0,
    activity: 'live',
    timing: WORK_POLL_TIMING,
    jitter01: NO_JITTER,
    ...overrides,
  };
}

function watched(sessionId = 'ws_1'): WorkPollState {
  return reducePollState(INITIAL_POLL_STATE, { type: 'watch', sessionId }, context());
}

function wireRun(overrides: Partial<WireRun> = {}): WireRun {
  return {
    id: 'wr_1',
    sessionId: 'ws_1',
    attempt: 2,
    origin: 'manual',
    scheduleId: null,
    status: 'running',
    terminalReason: null,
    terminalDetail: null,
    requestedTarget: 'automatic',
    effectiveTarget: 'cloud',
    hostId: null,
    requestedModel: null,
    effectiveModel: 'claude-x',
    requiredCapabilities: ['web_research'],
    availableCapabilities: ['web_research'],
    degradation: [],
    approvalMode: 'balanced',
    approvalModeNarrowedByHost: false,
    planVersion: 1,
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
    usage: { costMicroUsd: 1_200, inputTokens: 900, outputTokens: 100 },
    inputSensitivity: 'internal',
    outputSensitivity: 'internal',
    lastSeq: 42,
    startedAt: '2026-08-13T09:59:00.000Z',
    finishedAt: null,
    createdAt: '2026-08-13T09:58:00.000Z',
    updatedAt: '2026-08-13T10:00:00.000Z',
    ...overrides,
  };
}

function wireSession(overrides: Partial<WireSession> = {}): WireSession {
  return {
    id: 'ws_1',
    projectId: null,
    conversationId: null,
    title: 'Reconcile the invoices',
    titleSource: 'default',
    goal: 'Reconcile the invoices',
    status: 'running',
    needsAttention: false,
    requestedTarget: 'automatic',
    preferredHostId: null,
    requestedModel: null,
    reasoningEffort: null,
    permissionPolicy: 'balanced',
    pinned: false,
    archived: false,
    lastActivityAt: '2026-08-13T10:00:00.000Z',
    createdAt: '2026-08-13T09:58:00.000Z',
    updatedAt: '2026-08-13T10:00:00.000Z',
    ...overrides,
  };
}

function snapshot(overrides: Partial<WorkSnapshot> = {}): WorkSnapshot {
  return {
    session: {
      id: 'ws_1',
      title: 'Reconcile the invoices',
      goal: 'Reconcile the invoices',
      status: 'running',
      target: 'automatic',
      permissionPolicy: 'balanced',
      model: null,
      sensitivity: 'internal',
      createdAt: '2026-08-13T09:58:00.000Z',
      updatedAt: '2026-08-13T10:00:00.000Z',
      attempts: 2,
      pinned: false,
      archived: false,
      latestRunId: 'wr_1',
      grants: [],
      connectors: [],
      skill: null,
      conversationId: null,
    },
    run: toWorkRun(wireRun(), T0),
    events: [],
    replaced: false,
    approvals: [],
    questions: [],
    fetchedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The interval follows the run                                                */
/* -------------------------------------------------------------------------- */

describe('poll intervals', () => {
  test('a watched, working run is polled at the live rate', () => {
    expect(
      baseIntervalMs({ watched: true, activity: 'live', consecutiveFailures: 0 }, WORK_POLL_TIMING),
    ).toBe(WORK_POLL_TIMING.liveMs);
  });

  test('a run stopped on a question is polled more slowly than a working one', () => {
    const attention = baseIntervalMs(
      { watched: true, activity: 'attention', consecutiveFailures: 0 },
      WORK_POLL_TIMING,
    );
    expect(attention).toBe(WORK_POLL_TIMING.attentionMs);
    /* Nothing can change until the reader acts, so polling harder here is spend
       with nothing to find. */
    expect(attention).toBeGreaterThan(WORK_POLL_TIMING.liveMs);
  });

  test('a finished run is polled rarely, and a draft between the two', () => {
    const terminal = baseIntervalMs(
      { watched: true, activity: 'terminal', consecutiveFailures: 0 },
      WORK_POLL_TIMING,
    );
    const draft = baseIntervalMs(
      { watched: true, activity: 'draft', consecutiveFailures: 0 },
      WORK_POLL_TIMING,
    );
    expect(terminal).toBeGreaterThan(draft ?? 0);
    expect(draft).toBeGreaterThan(WORK_POLL_TIMING.attentionMs);
  });

  test('an unwatched session is not polled at all', () => {
    /* `null` and not "rarely": the contract polls exactly one session at a
       time, and a session nobody is looking at has no freshness to report. */
    expect(
      baseIntervalMs({ watched: false, activity: 'live', consecutiveFailures: 0 }, WORK_POLL_TIMING),
    ).toBeNull();
    expect(
      pollIntervalMs({ watched: false, activity: 'live', consecutiveFailures: 3 }, WORK_POLL_TIMING),
    ).toBeNull();
  });

  test('activity is read off the status vocabulary, not guessed', () => {
    expect(activityForStatus('running')).toBe('live');
    expect(activityForStatus('preparing')).toBe('live');
    expect(activityForStatus('waiting_input')).toBe('attention');
    expect(activityForStatus('waiting_approval')).toBe('attention');
    /* `host_offline` is terminal AND needs attention. Attention wins: the run
       being over does not mean the decision is made. */
    expect(activityForStatus('host_offline')).toBe('attention');
    expect(activityForStatus('completed')).toBe('terminal');
    expect(activityForStatus(null)).toBe('draft');
  });
});

/* -------------------------------------------------------------------------- */
/* Backoff                                                                     */
/* -------------------------------------------------------------------------- */

describe('backoff', () => {
  test('doubles per consecutive failure', () => {
    expect(backoffMs(1_000, 0, WORK_POLL_TIMING, NO_JITTER)).toBe(1_000);
    expect(backoffMs(1_000, 1, WORK_POLL_TIMING, NO_JITTER)).toBe(2_000);
    expect(backoffMs(1_000, 2, WORK_POLL_TIMING, NO_JITTER)).toBe(4_000);
    expect(backoffMs(1_000, 3, WORK_POLL_TIMING, NO_JITTER)).toBe(8_000);
  });

  test('is capped, so a long outage does not schedule a poll next week', () => {
    expect(backoffMs(1_000, 40, WORK_POLL_TIMING, NO_JITTER)).toBe(WORK_POLL_TIMING.maxBackoffMs);
  });

  test('jitter spreads within the ratio and never below zero', () => {
    const low = backoffMs(1_000, 1, WORK_POLL_TIMING, 0);
    const high = backoffMs(1_000, 1, WORK_POLL_TIMING, 1);
    expect(low).toBe(2_000 - 2_000 * WORK_POLL_TIMING.jitterRatio);
    expect(high).toBe(2_000 + 2_000 * WORK_POLL_TIMING.jitterRatio);
    expect(backoffMs(0, 5, WORK_POLL_TIMING, 0)).toBeGreaterThanOrEqual(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The state machine                                                           */
/* -------------------------------------------------------------------------- */

describe('reducePollState', () => {
  test('watching a session schedules an immediate first attempt', () => {
    const state = watched();
    expect(state.sessionId).toBe('ws_1');
    expect(state.phase).toBe('idle');
    expect(state.nextAttemptAt).toBe(new Date(T0).toISOString());
    expect(state.cursorSeq).toBe(0);
  });

  test('detaching clears the session and stops the countdown', () => {
    const attached = reducePollState(
      watched(),
      { type: 'success', cursorSeq: 12 },
      context(),
    );
    const detached = reducePollState(attached, { type: 'watch', sessionId: null }, context());
    expect(detached.sessionId).toBeNull();
    expect(detached.nextAttemptAt).toBeNull();
    expect(detached.cursorSeq).toBe(0);
  });

  test('an attempt reports itself and stops predicting the next one', () => {
    const state = reducePollState(watched(), { type: 'attempt' }, context({ now: T0 + 10 }));
    expect(state.phase).toBe('polling');
    expect(state.lastAttemptedAt).toBe(new Date(T0 + 10).toISOString());
    /* Null while a request is in flight: the bar shows "checking", not a
       countdown to a refresh that is already happening. */
    expect(state.nextAttemptAt).toBeNull();
  });

  test('a success stamps freshness and schedules the next poll', () => {
    const state = reducePollState(
      watched(),
      { type: 'success', cursorSeq: 42 },
      context({ now: T0 + 100 }),
    );
    expect(state.phase).toBe('ok');
    expect(state.lastSucceededAt).toBe(new Date(T0 + 100).toISOString());
    expect(state.consecutiveFailures).toBe(0);
    expect(state.error).toBeNull();
    expect(state.online).toBe(true);
    expect(state.intervalMs).toBe(WORK_POLL_TIMING.liveMs);
    expect(state.nextAttemptAt).toBe(new Date(T0 + 100 + WORK_POLL_TIMING.liveMs).toISOString());
    expect(state.cursorSeq).toBe(42);
  });

  test('the cursor is monotonic — a short delta cannot rewind it', () => {
    const ahead = reducePollState(watched(), { type: 'success', cursorSeq: 42 }, context());
    const behind = reducePollState(ahead, { type: 'success', cursorSeq: 7 }, context());
    expect(behind.cursorSeq).toBe(42);
  });

  test('A FAILURE KEEPS THE LAST KNOWN DATA', () => {
    const succeeded = reducePollState(
      watched(),
      { type: 'success', cursorSeq: 42 },
      context({ now: T0 }),
    );
    const failed = reducePollState(
      succeeded,
      { type: 'failure', error: 'Juno could not be reached.', offline: true },
      context({ now: T0 + 5_000 }),
    );

    expect(failed.phase).toBe('failed');
    /* The two fields the UI dates its panel from. Blanking either would turn
       "this is five seconds old" into "there is nothing", which is a different
       and false claim. */
    expect(failed.lastSucceededAt).toBe(succeeded.lastSucceededAt);
    expect(failed.cursorSeq).toBe(42);

    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.online).toBe(false);
    expect(failed.error).toBe('Juno could not be reached.');
    expect(failed.nextAttemptAt).toBe(
      new Date(T0 + 5_000 + WORK_POLL_TIMING.liveMs * 2).toISOString(),
    );
  });

  test('consecutive failures compound the backoff, and one success clears it', () => {
    let state = watched();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      state = reducePollState(state, { type: 'failure', error: 'nope', offline: false }, context());
    }
    expect(state.consecutiveFailures).toBe(3);
    expect(state.intervalMs).toBe(WORK_POLL_TIMING.liveMs * 8);

    const recovered = reducePollState(state, { type: 'success', cursorSeq: 1 }, context());
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.intervalMs).toBe(WORK_POLL_TIMING.liveMs);
  });

  test('a 5xx is not reported as being offline', () => {
    const state = reducePollState(
      watched(),
      { type: 'failure', error: 'Juno returned HTTP 503.', offline: false },
      context(),
    );
    expect(state.online).toBe(true);
    expect(state.phase).toBe('failed');
  });

  test('switching sessions resets the cursor, because seq is per run', () => {
    const first = reducePollState(watched('ws_1'), { type: 'success', cursorSeq: 99 }, context());
    const second = reducePollState(first, { type: 'watch', sessionId: 'ws_2' }, context());
    expect(second.cursorSeq).toBe(0);
    expect(second.lastSucceededAt).toBeNull();

    /* Re-watching the SAME session keeps what is already held. */
    const again = reducePollState(first, { type: 'watch', sessionId: 'ws_1' }, context());
    expect(again.cursorSeq).toBe(99);
    expect(again.lastSucceededAt).toBe(first.lastSucceededAt);
  });

  test('signing out suspends and schedules nothing', () => {
    const live = reducePollState(watched(), { type: 'success', cursorSeq: 3 }, context());
    const suspended = reducePollState(live, { type: 'suspend' }, context());
    expect(suspended.phase).toBe('suspended');
    expect(suspended.nextAttemptAt).toBeNull();

    const resumed = reducePollState(suspended, { type: 'resume' }, context({ now: T0 + 1 }));
    expect(resumed.phase).toBe('idle');
    expect(resumed.nextAttemptAt).toBe(new Date(T0 + 1).toISOString());
  });
});

/* -------------------------------------------------------------------------- */
/* No-op polls must not re-render                                              */
/* -------------------------------------------------------------------------- */

describe('change detection', () => {
  test('a poll that found nothing is not a change, even though fetchedAt moved', () => {
    const first = snapshot();
    const second = snapshot({ fetchedAt: new Date(T0 + 3_000).toISOString() });
    expect(snapshotChanged(first, second)).toBe(false);
  });

  test('any new event is a change', () => {
    const first = snapshot();
    const second = snapshot({
      events: [{ kind: 'assistant_message', text: 'Working on it.', seq: 43, at: '2026-08-13T10:00:01.000Z' }],
    });
    expect(snapshotChanged(first, second)).toBe(true);
  });

  test('a status move, a spend move and a new approval are each a change', () => {
    const first = snapshot();
    expect(
      snapshotChanged(first, snapshot({ run: toWorkRun(wireRun({ status: 'completed' }), T0) })),
    ).toBe(true);
    expect(
      snapshotChanged(
        first,
        snapshot({
          run: toWorkRun(
            wireRun({ usage: { costMicroUsd: 9_999, inputTokens: 900, outputTokens: 100 } }),
            T0,
          ),
        }),
      ),
    ).toBe(true);
    expect(
      snapshotChanged(
        first,
        snapshot({
          approvals: [
            {
              id: 'wa_1',
              callId: 'wa_1',
              action: 'work.file.write',
              tool: 'work.file.write',
              risk: 'edit',
              summary: 'Write report.md',
              detail: {},
              digestInput: '',
              actionDigest: 'a'.repeat(64),
              policyDigest: '',
              expiresAt: '2026-08-13T10:05:00.000Z',
              decision: 'pending',
              decidedAt: null,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test('the first snapshot is always a change', () => {
    expect(snapshotChanged(null, snapshot())).toBe(true);
  });

  test('an unchanged task list is not re-emitted', () => {
    const tasks: WorkSessionSummary[] = [toWorkSessionSummary(wireSession())];
    expect(tasksChanged(tasks, [toWorkSessionSummary(wireSession())])).toBe(false);
    expect(
      tasksChanged(tasks, [toWorkSessionSummary(wireSession({ status: 'completed' }))]),
    ).toBe(true);
    expect(tasksChanged(tasks, [])).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The poller shell                                                            */
/* -------------------------------------------------------------------------- */

describe('WorkPoller', () => {
  const FAST: PollTiming = { ...WORK_POLL_TIMING, liveMs: 1_000, unwatchedMs: null };

  let clock = T0;
  let states: WorkPollState[];
  let snapshots: WorkSnapshot[];
  let fetchSnapshot: ReturnType<typeof vi.fn>;

  function makePoller(): WorkPoller {
    const ports: WorkPollerPorts = {
      fetchSnapshot: (sessionId, sinceSeq, signal) =>
        fetchSnapshot(sessionId, sinceSeq, signal) as Promise<{
          snapshot: WorkSnapshot;
          cursorSeq: number;
        }>,
      fetchTasks: async () => [],
      emitPollState: (state) => void states.push(state),
      emitSnapshot: (value) => void snapshots.push(value),
      emitTasks: () => undefined,
      describeFailure: (error) => describeFailure(error),
      now: () => clock,
      jitter: () => NO_JITTER,
      timing: FAST,
    };
    return new WorkPoller(ports);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clock = T0;
    states = [];
    snapshots = [];
    fetchSnapshot = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a failed poll keeps the last snapshot and reports the failure', async () => {
    fetchSnapshot
      .mockResolvedValueOnce({ snapshot: snapshot(), cursorSeq: 42 })
      .mockRejectedValueOnce(new NetworkError('econnrefused'));

    const poller = makePoller();
    poller.watch('ws_1');
    await vi.advanceTimersByTimeAsync(1);
    const afterSuccess = poller.lastSnapshot;
    expect(afterSuccess).not.toBeNull();
    expect(poller.state.phase).toBe('ok');

    clock += FAST.liveMs;
    await vi.advanceTimersByTimeAsync(FAST.liveMs + 1);

    /* The panel keeps drawing the last thing that was true. */
    expect(poller.lastSnapshot).toBe(afterSuccess);
    expect(poller.state.phase).toBe('failed');
    expect(poller.state.online).toBe(false);
    expect(poller.state.cursorSeq).toBe(42);
    expect(poller.state.lastSucceededAt).not.toBeNull();

    poller.dispose();
  });

  test('a poll that changed nothing emits poll-state but not a snapshot', async () => {
    fetchSnapshot.mockImplementation(async () => ({
      snapshot: snapshot({ fetchedAt: new Date(clock).toISOString() }),
      cursorSeq: 42,
    }));

    const poller = makePoller();
    poller.watch('ws_1');
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshots).toHaveLength(1);

    clock += FAST.liveMs;
    await vi.advanceTimersByTimeAsync(FAST.liveMs + 1);

    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    /* Two polls, one render. */
    expect(snapshots).toHaveLength(1);
    expect(states.filter((state) => state.phase === 'ok')).toHaveLength(2);

    poller.dispose();
  });

  test('the cursor is carried into the next request', async () => {
    fetchSnapshot.mockResolvedValue({ snapshot: snapshot(), cursorSeq: 42 });

    const poller = makePoller();
    poller.watch('ws_1');
    await vi.advanceTimersByTimeAsync(1);
    clock += FAST.liveMs;
    await vi.advanceTimersByTimeAsync(FAST.liveMs + 1);

    expect(fetchSnapshot.mock.calls[0]?.[1]).toBe(0);
    expect(fetchSnapshot.mock.calls[1]?.[1]).toBe(42);

    poller.dispose();
  });

  test('an unwatched poller makes no requests', async () => {
    const poller = makePoller();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSnapshot).not.toHaveBeenCalled();
    poller.dispose();
  });

  test('signing out stops the loop', async () => {
    fetchSnapshot.mockResolvedValue({ snapshot: snapshot(), cursorSeq: 1 });
    const poller = makePoller();
    poller.watch('ws_1');
    await vi.advanceTimersByTimeAsync(1);
    const calls = fetchSnapshot.mock.calls.length;

    poller.suspend();
    clock += FAST.liveMs * 10;
    await vi.advanceTimersByTimeAsync(FAST.liveMs * 10);

    expect(fetchSnapshot.mock.calls.length).toBe(calls);
    expect(poller.state.phase).toBe('suspended');
    poller.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

function conflict(code: string, message = 'refused'): ApiError {
  return new ApiError(409, code, 'req_1', false, null, message);
}

describe('answer refusals', () => {
  test('steering a run that is waiting for an answer is refused as waiting_input', () => {
    /* The contract names this one: a `waiting_input` run refuses steering
       because it is stopped, and saying otherwise would lie. */
    expect(answerRefusal(conflict('answer_expected'))).toBe('waiting_input');
  });

  test('the three "not in a state to hear you" codes map to not_live', () => {
    expect(answerRefusal(conflict('run_not_waiting_input'))).toBe('not_live');
    expect(answerRefusal(conflict('run_finished'))).toBe('not_live');
    expect(answerRefusal(conflict('run_not_started'))).toBe('not_live');
  });

  test('a code this build has never seen is NOT filed as not_live', () => {
    /* It falls through and is thrown as the error it is. Quietly reporting an
       unknown refusal as one of the three the UI can explain would put the
       wrong sentence under the composer. */
    expect(answerRefusal(conflict('some_new_code'))).toBeNull();
  });

  test('a 404 or a 500 is not a refusal', () => {
    expect(answerRefusal(new ApiError(404, null, null, false, null, 'Not found'))).toBeNull();
    expect(answerRefusal(new ApiError(500, null, null, true, null, 'boom'))).toBeNull();
    expect(answerRefusal(new Error('boom'))).toBeNull();
  });
});

describe('approval refusals', () => {
  test('all five come back named, with the server’s own sentence', () => {
    const cases = [
      ['digest_mismatch', 'This approval is for a different action than the one you were shown.'],
      ['policy_changed', 'The permissions changed after you were asked. Juno will ask again.'],
      ['expired', 'This request expired before it was answered.'],
      ['already_decided', 'This request has already been answered.'],
      [
        'not_standing_allowable',
        'Juno will not stop asking about this one. Allow it this time if you want it to happen.',
      ],
    ] as const;

    for (const [code, message] of cases) {
      const mapped = approvalRefusal(conflict(code, message));
      expect(mapped).toEqual({ reason: code, detail: message });
    }
  });

  test('a refusal is never invented from a status alone', () => {
    expect(approvalRefusal(conflict('something_else'))).toBeNull();
    expect(approvalRefusal(new ApiError(409, null, null, false, null, 'conflict'))).toBeNull();
    expect(approvalRefusal(new ApiError(403, 'expired', null, false, null, 'x'))).toBeNull();
  });
});

describe('describeFailure', () => {
  test('signed out reads as signed out, not as a status code', () => {
    const notSignedIn = new Error('No Juno account is signed in on this device.');
    notSignedIn.name = 'NotSignedInError';
    expect(describeFailure(notSignedIn)).toEqual({
      message: 'No Juno account is signed in on this Mac. Sign in to see your tasks.',
      offline: false,
    });
  });

  test('a revoked device says so, and is not reported as being offline', () => {
    const described = describeFailure(
      new UnauthorizedError(401, 'device_revoked', null, false, null, 'x'),
    );
    expect(described.offline).toBe(false);
    expect(described.message).toContain('Sign in again');
  });

  test('only a network failure or a timeout claims the app is offline', () => {
    expect(describeFailure(new NetworkError('econnrefused')).offline).toBe(true);
    expect(describeFailure(new TimeoutError('slow')).offline).toBe(true);
    expect(describeFailure(new ApiError(503, null, null, true, null, 'deploying')).offline).toBe(
      false,
    );
  });

  test('no message carries a token or a header', () => {
    const described = describeFailure(
      new NetworkError('Juno could not reach https://chat.example/api/work/sessions'),
    );
    expect(described.message).not.toContain('Bearer');
    expect(described.message).not.toContain('authorization');
  });
});

/* -------------------------------------------------------------------------- */
/* Skill slugs                                                                 */
/* -------------------------------------------------------------------------- */

describe('applySkillSlug', () => {
  test('prefixes the goal, because that is where the runner reads the skill from', () => {
    expect(applySkillSlug('Summarise the deck', 'research')).toBe('/research Summarise the deck');
  });

  test('is idempotent — the picker and a typed command are one choice', () => {
    expect(applySkillSlug('/research Summarise the deck', 'research')).toBe(
      '/research Summarise the deck',
    );
    expect(applySkillSlug('/Research Summarise', 'research')).toBe('/Research Summarise');
  });

  test('leaves the goal exactly as written when no skill was picked', () => {
    expect(applySkillSlug('Summarise the deck', null)).toBe('Summarise the deck');
  });
});

/* -------------------------------------------------------------------------- */
/* Grant tokens                                                                */
/* -------------------------------------------------------------------------- */

describe('GrantVault', () => {
  test('the token is opaque — nothing about the path can be read out of it', () => {
    const vault = new GrantVault(() => T0);
    const record = vault.mint({
      kind: 'local_folder',
      accessMode: 'read',
      path: '/Users/someone/Documents/Q3 close',
      label: 'Q3 close',
    });
    expect(record.token).toMatch(/^wgt_[0-9a-f]{64}$/);
    expect(record.token).not.toContain('Documents');
    expect(record.token).not.toContain('Q3');

    /* Deterministic derivation would make the token an oracle for whether a
       given path was granted. Two mints of the same path must differ. */
    const second = vault.mint({
      kind: 'local_folder',
      accessMode: 'read',
      path: '/Users/someone/Documents/Q3 close',
      label: 'Q3 close',
    });
    expect(second.token).not.toBe(record.token);
  });

  test('resolves its own tokens and refuses everything else', () => {
    const vault = new GrantVault(() => T0);
    const record = vault.mint({
      kind: 'local_file',
      accessMode: 'read_write',
      path: '/tmp/a.txt',
      label: 'a.txt',
    });
    expect(vault.resolve(record.token)?.path).toBe('/tmp/a.txt');
    expect(vault.resolve('wgt_' + 'f'.repeat(64))).toBeNull();
  });

  test('a token expires rather than granting a path forever', () => {
    let now = T0;
    const vault = new GrantVault(() => now);
    const record = vault.mint({
      kind: 'local_folder',
      accessMode: 'read',
      path: '/tmp/x',
      label: 'x',
    });
    now += 61 * 60_000;
    expect(vault.resolve(record.token)).toBeNull();
  });

  test('resolveAll names the tokens it did not recognise', () => {
    const vault = new GrantVault(() => T0);
    const record = vault.mint({
      kind: 'local_folder',
      accessMode: 'read',
      path: '/tmp/x',
      label: 'x',
    });
    const result = vault.resolveAll([record.token, 'wgt_nope']);
    expect(result.records).toHaveLength(1);
    expect(result.unknown).toEqual(['wgt_nope']);
  });
});

/* -------------------------------------------------------------------------- */
/* Wire mapping                                                                */
/* -------------------------------------------------------------------------- */

describe('wire mapping', () => {
  test('usage is totalled, and runtime is derived from the two timestamps', () => {
    const run = toWorkRun(wireRun(), T0);
    expect(run.usage.tokens).toBe(1_000);
    expect(run.usage.inputTokens).toBe(900);
    expect(run.usage.outputTokens).toBe(100);
    /* startedAt is 60s before T0 and the run has not finished. */
    expect(run.usage.runtimeMs).toBe(60_000);
  });

  test('a run that never started has spent no time', () => {
    expect(toWorkRun(wireRun({ startedAt: null }), T0).usage.runtimeMs).toBe(0);
  });

  test('an undispatched run reports the cloud target rather than a third value', () => {
    expect(toWorkRun(wireRun({ effectiveTarget: null }), T0).target).toBe('cloud');
    expect(toWorkRun(wireRun({ effectiveTarget: 'local' }), T0).target).toBe('local');
  });

  test('an unreadable approval mode narrows rather than widens', () => {
    expect(toWorkRun(wireRun({ approvalMode: null }), T0).permissionPolicy).toBe('conservative');
    expect(toWorkRun(wireRun({ approvalMode: 'nonsense' }), T0).permissionPolicy).toBe(
      'conservative',
    );
  });

  test('the list uses the server’s attention flag rather than re-deriving it', () => {
    /* `setSessionAttention` clears the flag the moment a question is answered,
       before the executor moves the run off `waiting_input`. Re-deriving would
       put the task straight back on the "Needs you" list. */
    const summary = toWorkSessionSummary(
      wireSession({ status: 'waiting_input', needsAttention: false }),
    );
    expect(summary.status).toBe('waiting_input');
    expect(summary.needsAttention).toBe(false);
  });

  test('an operator-only event never reaches the renderer', () => {
    expect(toWorkEvent(wireEvent({ visibility: 'operator' }))).toBeNull();
    expect(toWorkEvent(wireEvent({ visibility: 'internal' }))).toBeNull();
  });

  test('the payload is flattened onto the event with seq and at', () => {
    const mapped = toWorkEvent(
      wireEvent({ kind: 'assistant_message', payload: { text: 'Working on it.' }, seq: 7 }),
    );
    expect(mapped).toEqual({
      kind: 'assistant_message',
      text: 'Working on it.',
      seq: 7,
      at: '2026-08-13T10:00:00.000Z',
    });
  });

  test('a steering message gets the one documented fill-in', () => {
    /* The route writes `{text, answeredVia, steering}`; the contract also asks
       whether the run has picked it up, and nothing on the wire says. `false`
       draws it as still pending, which is the state a reader can act on. */
    const mapped = toWorkEvent(
      wireEvent({
        kind: 'user_message',
        payload: { text: 'Use the Q3 file.', answeredVia: 'macos', steering: true },
      }),
    );
    expect(mapped).toMatchObject({ kind: 'user_message', text: 'Use the Q3 file.', consumed: false });
  });

  test('an event whose payload does not match the contract is dropped, not invented', () => {
    /* `run_started` needs a runId, a goal and a model. Filling those in would
       put a card on screen making claims nothing sent. */
    expect(toWorkEvent(wireEvent({ kind: 'run_started', payload: { runId: 'wr_1' } }))).toBeNull();
    expect(toWorkEvent(wireEvent({ kind: 'not_a_kind', payload: {} }))).toBeNull();
  });

  test('a Mac advertises only what its own toggles allow', () => {
    const host = toWorkHostRef(wireHost({ allowsFileWork: true, allowsShell: false }));
    expect(host.capabilities).toContain('local_files');
    expect(host.capabilities).not.toContain('local_shell');
  });

  test('a revoked or switched-off Mac advertises nothing and reads as offline', () => {
    /* Not a display choice: `admissionRefusal` refuses a run at either, so a
       composer that still offered the capability would offer a run that cannot
       start. */
    const revoked = toWorkHostRef(wireHost({ revokedAt: '2026-08-01T00:00:00.000Z' }));
    expect(revoked.capabilities).toEqual([]);
    expect(revoked.state).toBe('offline');

    const disabled = toWorkHostRef(wireHost({ enabled: false }));
    expect(disabled.capabilities).toEqual([]);
    expect(disabled.state).toBe('offline');
  });
});

function wireEvent(overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    id: 'we_1',
    runId: 'wr_1',
    seq: 1,
    kind: 'assistant_message',
    payloadVersion: 1,
    visibility: 'user',
    payload: { text: 'hello' },
    eventKey: null,
    agentId: null,
    createdAt: '2026-08-13T10:00:00.000Z',
    ...overrides,
  };
}

function wireHost(overrides: Partial<WireHost> = {}): WireHost {
  return {
    id: 'wh_1',
    deviceId: 'dev_1',
    displayName: 'Liam’s MacBook Pro',
    platform: 'macos',
    appVersion: '1.0.0',
    protocolVersion: 3,
    enabled: true,
    allowsFileWork: true,
    allowsBrowser: true,
    allowsComputerUse: false,
    allowsShell: true,
    allowsBackground: false,
    approvalPolicy: 'balanced',
    state: 'idle',
    lastSeenAt: '2026-08-13T09:59:00.000Z',
    activeRunCount: 0,
    queuedRunCount: 0,
    revokedAt: null,
    ...overrides,
  };
}
