/**
 * The local agent host: its wire contract, its approval bookkeeping, and its
 * `utilityProcess` entry point.
 *
 * Three units, one file, because they only mean anything together — the entry
 * point's job is to hand parsed frames to the manager, and the manager's job is
 * to make an approval decision unrepeatable. Split across three files the seam
 * between them would be the part nobody tested.
 *
 * What is actually load-bearing here, in the order the source itself ranks it:
 *
 *   1. **A decision is applied to at most one tool call, exactly once.** The
 *      structural guarantee lives in `SessionManager.settleApproval`; the `seq`
 *      guard in `host-protocol.ts` is described in its own comments as "the
 *      cheap half". So the manager tests deliberately bypass the transport and
 *      replay decisions straight into the manager, which is the arrangement in
 *      which the cheap half cannot mask a failure of the load-bearing half.
 *   2. **An approval never resolves to `allow` on its own.** Every path that
 *      ends a wait without a user decision must resolve `deny`. Asserted per
 *      path, and once more globally over every resolver call the suite makes.
 *   3. **Nothing crossing the port carries a credential.** The `configure`
 *      frame holds a session cookie; a canary value is planted in it and no
 *      outbound frame may contain it, on the success path or the error path.
 *
 * `private` is a compile-time modifier, so `sessions`, `awaitApproval` and
 * `emitEvent` are all reachable at runtime and are reached directly. The
 * alternative — standing up a real `AgentSession` to provoke an approval — would
 * need a provider, a home directory and a model turn, which is an integration
 * test, and the property under test would be the least reliable thing in it.
 */

/**
 * `node:child_process` is mocked for one call: the shutdown path runs
 * `execFileSync('/bin/ps', …)` to reap detached children. A unit test in this
 * workspace may not spawn a process (`tests/README.md`), and an empty `ps` table
 * makes "reaped nothing" a fact rather than a property of the machine the suite
 * runs on. The rest of the module is passed through because agent-core is in
 * this file's import graph.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, execFileSync: () => '' };
});

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  PermissionMode,
  SessionMeta,
} from '@juno/agent-core';
import {
  HOST_PROTOCOL_VERSION,
  HostCommandSchema,
  InboundSequenceGuard,
  LIMITS,
  clamp,
  describeError,
  parseHostCommand,
  parseHostMessage,
  redactSecrets,
  type HostCommand,
  type HostMessage,
  type HostMessageDraft,
} from '../../src/agent-host/host-protocol';
import { SessionManager, type SessionManagerOptions } from '../../src/agent-host/session-manager';

/* -------------------------------------------------------------------------- */
/* Shared samples                                                              */
/* -------------------------------------------------------------------------- */

/** The marker `clamp` appends. Restated as data so a change to it fails here. */
const TRUNCATION_MARKER = '…[truncated]';

/**
 * `DEFAULTS` in `session-manager.ts`, restated. A test that read the limits out
 * of the module under test would agree with any value that module chose.
 */
const TOOL_INPUT_LIMIT = 8_192;
const APPROVAL_INPUT_LIMIT = 65_536;

const SESSION_ID = 'sess_1';

function sessionMeta(id: string): SessionMeta {
  return {
    id,
    title: '(new session)',
    cwd: '/Users/x/juno',
    provider: 'anthropic',
    model: 'claude-opus-5',
    mode: 'ask',
    createdAt: '2026-08-12T09:00:00.000Z',
    updatedAt: '2026-08-12T09:00:00.000Z',
    turnCount: 0,
  };
}

/**
 * Typed by agent-core, not by `z.infer` of the schema under test: a sample typed
 * by the validator it exercises agrees with that validator by construction.
 */
function approvalRequest(callId: string): ApprovalRequest {
  return {
    callId,
    toolName: 'shell',
    input: { command: 'rm -rf build' },
    risk: 'command',
    summary: 'Run `rm -rf build` in /Users/x/juno',
  };
}

/* ========================================================================== */
/* host-protocol.ts                                                            */
/* ========================================================================== */

/** Transcribed in source order, so a command added upstream fails this file. */
const DECLARED_COMMAND_TYPES = [
  'configure',
  'start',
  'resume',
  'prompt',
  'approval',
  'set_mode',
  'undo',
  'diff',
  'list_sessions',
  'abort',
  'close_session',
  'heartbeat',
  'shutdown',
] as const;

/** One well-formed sample per command. The mapped type forbids a wrong shape. */
type CommandSamples = {
  [T in HostCommand['type']]: Extract<HostCommand, { type: T }>;
};

const COMMAND_SAMPLES: CommandSamples = {
  configure: {
    type: 'configure',
    seq: 1,
    requestId: 'req_1',
    backend: {
      baseUrl: 'https://juno.example',
      cookie: 'juno_session=abc123def456',
      models: [
        {
          provider: 'backend/anthropic',
          kind: 'anthropic',
          model: 'claude-opus-5',
          label: 'Opus 5',
          available: true,
        },
      ],
    },
  },
  start: { type: 'start', seq: 2, requestId: 'req_2', cwd: '/Users/x/juno', mode: 'ask' },
  resume: { type: 'resume', seq: 3, requestId: 'req_3', sessionId: SESSION_ID, mode: 'plan' },
  prompt: {
    type: 'prompt',
    seq: 4,
    requestId: 'req_4',
    sessionId: SESSION_ID,
    text: 'harden the preload bridge',
  },
  approval: {
    type: 'approval',
    seq: 5,
    requestId: 'req_5',
    sessionId: SESSION_ID,
    callId: 'call_7',
    decision: 'deny',
  },
  set_mode: {
    type: 'set_mode',
    seq: 6,
    requestId: 'req_6',
    sessionId: SESSION_ID,
    mode: 'auto-edit',
  },
  undo: { type: 'undo', seq: 7, requestId: 'req_7', sessionId: SESSION_ID },
  diff: { type: 'diff', seq: 8, requestId: 'req_8', sessionId: SESSION_ID, sinceTurn: 2 },
  list_sessions: { type: 'list_sessions', seq: 9, requestId: 'req_9' },
  abort: { type: 'abort', seq: 10, requestId: 'req_10', sessionId: SESSION_ID },
  close_session: { type: 'close_session', seq: 11, requestId: 'req_11', sessionId: SESSION_ID },
  heartbeat: { type: 'heartbeat', seq: 12 },
  shutdown: { type: 'shutdown', seq: 13, requestId: 'req_13', graceMs: 1_000 },
};

/** The literal `type` of each arm of the discriminated union. */
function commandDiscriminators(): string[] {
  return HostCommandSchema.options.map((option) => String(option.shape.type.value));
}

describe('parseHostCommand', () => {
  test('the union covers every command declared, and no others', () => {
    expect([...commandDiscriminators()].sort()).toEqual([...DECLARED_COMMAND_TYPES].sort());
  });

  test('there is a sample for every command', () => {
    expect(Object.keys(COMMAND_SAMPLES).sort()).toEqual([...DECLARED_COMMAND_TYPES].sort());
  });

  test.each(DECLARED_COMMAND_TYPES)('round-trips a %s frame unchanged', (type) => {
    const sample = COMMAND_SAMPLES[type];
    const result = parseHostCommand(sample);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    /* Deep equality, not `toMatchObject`: a schema that quietly dropped or
       coerced a field would still satisfy a partial match. */
    expect(result.ok && result.value).toEqual(sample);
  });

  test.each(DECLARED_COMMAND_TYPES)('survives a real JSON hop as a %s frame', (type) => {
    const overWire: unknown = JSON.parse(JSON.stringify(COMMAND_SAMPLES[type]));
    expect(parseHostCommand(overWire).ok).toBe(true);
  });

  test('accepts the optional-field-free form of every command that has one', () => {
    const minimal: HostCommand[] = [
      { type: 'configure', seq: 1, requestId: 'r', backend: null },
      { type: 'start', seq: 2, requestId: 'r', cwd: '/Users/x/juno' },
      { type: 'resume', seq: 3, requestId: 'r', sessionId: SESSION_ID },
      { type: 'diff', seq: 4, requestId: 'r', sessionId: SESSION_ID },
      { type: 'shutdown', seq: 5, requestId: 'r' },
    ];

    for (const command of minimal) {
      const result = parseHostCommand(command);
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Rejection — the half that matters                                       */
  /* ---------------------------------------------------------------------- */

  test('rejects an approval frame with no callId', () => {
    /* The single most important rejection in this file. `callId` is the only
       thing a decision is keyed on; a decision that arrived addressed to a
       session alone could be applied to whichever call happened to be waiting,
       which across a reconnect is how "allow" on a file write becomes "allow"
       on `rm -rf`. */
    const { callId: _callId, ...withoutCallId } = COMMAND_SAMPLES.approval;

    expect(parseHostCommand(withoutCallId).ok).toBe(false);
    expect(parseHostCommand({ ...COMMAND_SAMPLES.approval, callId: '' }).ok).toBe(false);
    expect(parseHostCommand({ ...COMMAND_SAMPLES.approval, callId: null }).ok).toBe(false);
    expect(parseHostCommand({ ...COMMAND_SAMPLES.approval, callId: 7 }).ok).toBe(false);
    expect(
      parseHostCommand({ ...COMMAND_SAMPLES.approval, callId: 'c'.repeat(LIMITS.identifier + 1) })
        .ok,
    ).toBe(false);
  });

  test('rejects an approval frame whose decision is not one of the three', () => {
    /* A decision the host does not understand must never be coerced into one it
       does — least of all into the permissive one. */
    for (const decision of ['allow-always', 'ALLOW', 'yes', '', null, true]) {
      expect(parseHostCommand({ ...COMMAND_SAMPLES.approval, decision }).ok).toBe(false);
    }
  });

  test.each([
    ['a type nobody declared', { type: 'telepathy', seq: 1, requestId: 'r' }],
    ['a near-miss on a real type', { type: 'prompts', seq: 1, requestId: 'r', text: 'hi' }],
    ['the wrong case', { type: 'PROMPT', seq: 1, requestId: 'r', text: 'hi' }],
    ['a sidecar command the host does not implement', { type: 'exec', seq: 1, command: 'sh' }],
    ['no discriminator at all', { seq: 1, requestId: 'r' }],
  ])('rejects a frame with %s', (_label, raw) => {
    expect(parseHostCommand(raw).ok).toBe(false);
  });

  test.each([
    ['seq 0', 0],
    ['a negative seq', -1],
    ['a fractional seq', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string seq', '1'],
    ['no seq at all', undefined],
  ])('rejects %s', (_label, seq) => {
    /* `seq` is the replay guard's whole input. Zero is called out separately
       because it is the value a default-initialised counter sends, and it is
       also `InboundSequenceGuard`'s starting point — a frame that could carry
       it would be accepted forever. */
    expect(parseHostCommand({ ...COMMAND_SAMPLES.prompt, seq }).ok).toBe(false);
    expect(parseHostCommand({ ...COMMAND_SAMPLES.heartbeat, seq }).ok).toBe(false);
    expect(parseHostCommand({ ...COMMAND_SAMPLES.approval, seq }).ok).toBe(false);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a raw string', '{"type":"heartbeat","seq":1}'],
    ['a number', 7],
    ['an array', [{ type: 'heartbeat', seq: 1 }]],
    ['an empty object', {}],
  ])('returns ok:false rather than throwing for %s', (_label, raw) => {
    /* One malformed frame must not tear down live sessions; anything that threw
       here would propagate into the port's message handler. */
    expect(() => parseHostCommand(raw)).not.toThrow();
    const result = parseHostCommand(raw);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.length).toBeGreaterThan(0);
  });

  test('rejects a frame that overruns a declared bound', () => {
    expect(
      parseHostCommand({ ...COMMAND_SAMPLES.prompt, text: 'x'.repeat(LIMITS.promptChars + 1) }).ok,
    ).toBe(false);
    expect(
      parseHostCommand({ ...COMMAND_SAMPLES.start, cwd: '/'.repeat(LIMITS.path + 1) }).ok,
    ).toBe(false);
    expect(parseHostCommand({ ...COMMAND_SAMPLES.shutdown, graceMs: 120_001 }).ok).toBe(false);
    expect(parseHostCommand({ ...COMMAND_SAMPLES.shutdown, graceMs: -1 }).ok).toBe(false);
  });

  test('drops keys the contract does not declare rather than passing them through', () => {
    const result = parseHostCommand({ ...COMMAND_SAMPLES.heartbeat, decision: 'allow', extra: 1 });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ type: 'heartbeat', seq: 12 });
  });

  test('the failure message describes the shape without echoing the payload', () => {
    /* The caller logs this string, and one of the fields being validated is a
       session cookie.
       Worth being precise about what this proves: with Zod 4 it passes because
       `prettifyError` names the path and the *expected* type and never quotes
       the received value — the redaction in `describeFailure` is defence in
       depth here, not the thing doing the work (removing it leaves this test
       green). The assertion is on the property that matters regardless of which
       layer provides it, so a future Zod that starts echoing input, or a
       switch to a formatter that does, fails here. `describeError` below is
       where redaction itself is exercised. */
    const result = parseHostCommand({
      type: 'configure',
      seq: 1,
      requestId: 'r',
      backend: {
        baseUrl: 'https://juno.example',
        cookie: 'juno_session=CANARY_COOKIE_VALUE',
        models: [
          {
            provider: 'p',
            kind: 'sk-ant-api03-CANARYKEYMATERIAL',
            model: 'm',
            label: 'l',
            available: true,
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toMatch(/CANARY_COOKIE_VALUE/);
    expect(result.error).not.toMatch(/CANARYKEYMATERIAL/);
    expect(result.error.length).toBeLessThanOrEqual(LIMITS.errorChars + TRUNCATION_MARKER.length);
  });
});

describe('parseHostMessage', () => {
  test('accepts the frames the host actually emits', () => {
    const messages: HostMessage[] = [
      { type: 'ready', seq: 1, protocolVersion: HOST_PROTOCOL_VERSION, pid: 4242 },
      { type: 'ack', seq: 2, requestId: 'r' },
      {
        type: 'approval_settled',
        seq: 3,
        requestId: 'r',
        sessionId: SESSION_ID,
        callId: 'call_7',
        outcome: 'duplicate_ignored',
        decision: 'deny',
      },
      { type: 'protocol_error', seq: 4, code: 'stale_seq', message: 'dropped a heartbeat frame' },
    ];

    for (const message of messages) {
      const result = parseHostMessage(message);
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      expect(result.ok && result.value).toEqual(message);
    }
  });

  test('rejects an approval_settled whose outcome is outside the contract', () => {
    expect(
      parseHostMessage({
        type: 'approval_settled',
        seq: 1,
        requestId: 'r',
        sessionId: SESSION_ID,
        callId: 'call_7',
        outcome: 'probably_fine',
        decision: null,
      }).ok,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* InboundSequenceGuard                                                        */
/* -------------------------------------------------------------------------- */

describe('InboundSequenceGuard', () => {
  test('accepts a strictly increasing sequence and nothing else', () => {
    const guard = new InboundSequenceGuard();

    expect([1, 2, 3, 10, 11].map((seq) => guard.accept(seq))).toEqual([true, true, true, true, true]);
    expect(guard.lastAccepted).toBe(11);
  });

  test('drops a replay, and drops it again however many times it arrives', () => {
    const guard = new InboundSequenceGuard();
    guard.accept(5);

    /* The frame that must never get through twice is an `approval`. Three
       replays rather than one because a guard that toggled would pass the
       second. */
    expect([guard.accept(5), guard.accept(5), guard.accept(5)]).toEqual([false, false, false]);
    expect(guard.lastAccepted).toBe(5);
  });

  test('drops a frame that goes backwards without disarming the guard', () => {
    const guard = new InboundSequenceGuard();
    guard.accept(9);

    expect(guard.accept(8)).toBe(false);
    expect(guard.accept(1)).toBe(false);
    /* A rejected frame must not move the watermark; if it did, the replay it
       came from would become acceptable. */
    expect(guard.lastAccepted).toBe(9);
    expect(guard.accept(10)).toBe(true);
  });

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a fraction', 3.5],
    ['past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
    ['zero', 0],
    ['a negative', -1],
  ])('drops %s, and leaves the watermark alone', (_label, seq) => {
    const guard = new InboundSequenceGuard();
    guard.accept(4);

    expect(guard.accept(seq)).toBe(false);
    expect(guard.lastAccepted).toBe(4);
  });

  test('starts at zero, so the first legitimate frame is seq 1', () => {
    const guard = new InboundSequenceGuard();

    expect(guard.lastAccepted).toBe(0);
    expect(guard.accept(0)).toBe(false);
    expect(guard.accept(1)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* redactSecrets / clamp                                                       */
/* -------------------------------------------------------------------------- */

describe('redactSecrets', () => {
  test('removes an Anthropic key and keeps the sentence around it', () => {
    expect(redactSecrets('the provider rejected sk-ant-api03-abc123DEF456ghi789 as expired')).toBe(
      'the provider rejected [redacted] as expired',
    );
  });

  test('removes a Cookie header value but keeps the field name', () => {
    /* Keeping the name is the point: a log that says only "[redacted]" cannot
       tell whoever is on call *what* was redacted. */
    expect(redactSecrets('sent Cookie: juno_session=abc123def456 to the proxy')).toBe(
      'sent Cookie:[redacted] to the proxy',
    );
  });

  test('removes a KEY-shaped environment assignment', () => {
    expect(redactSecrets('spawned with FOO_API_KEY=9f8e7d6c5b4a in the environment')).toBe(
      'spawned with FOO_API_KEY=[redacted] in the environment',
    );
  });

  test('removes a bearer token', () => {
    expect(redactSecrets('retrying with Bearer A1b2C3d4E5f6G7h8')).toBe(
      'retrying with Bearer [redacted]',
    );
    expect(redactSecrets('retrying with bearer A1b2C3d4E5f6G7h8')).toBe(
      'retrying with bearer [redacted]',
    );
  });

  test('leaves ordinary prose exactly as it was', () => {
    /* A redactor that mangles ordinary text gets turned off, which is the
       failure mode this test exists to prevent. */
    const prose = [
      'Wrote 3 files in src/main and the turn finished cleanly.',
      'No provider has a configured API key.',
      'session 2026-08-12-a1b2c3d4 is not live.',
      'At most 8 sessions may be live at once; close one first.',
      'Run `rm -rf build` in /Users/x/juno',
      '',
    ];

    for (const text of prose) expect(redactSecrets(text)).toBe(text);
  });

  test('is idempotent, so a twice-redacted log line is not double-mangled', () => {
    const once = redactSecrets('sent Cookie: juno_session=abc123def456 to the proxy');
    expect(redactSecrets(once)).toBe(once);
  });

  test('a bearer token behind an Authorization header survives — a known gap', () => {
    /* Recorded, not asserted away. The `authorization|cookie` pattern runs
       before the `bearer|basic` one and consumes the word `Bearer` as its
       value, so the credential after the space is never seen by the pattern
       that would have caught it. The header form is what an HTTP client's error
       text actually looks like, so this is reachable. Pinned here so that
       reordering the patterns (or widening `[^\s,;]+`) is a visible, deliberate
       improvement rather than an accident nobody notices either way. */
    expect(redactSecrets('Authorization: Bearer A1b2C3d4E5f6G7h8')).toBe(
      'Authorization:[redacted] A1b2C3d4E5f6G7h8',
    );
  });
});

describe('describeError', () => {
  /* Every throw the host turns into a `command_error` goes through here, and a
     provider error message is the most likely place for a credential to be
     sitting in plain text. This is the redaction the host actually depends on. */

  test('redacts a credential carried in a thrown message', () => {
    expect(describeError(new Error('POST failed, sent Cookie: juno_session=abc123def456'))).toBe(
      'POST failed, sent Cookie:[redacted]',
    );
    expect(describeError(new Error('key sk-ant-api03-abc123DEF456ghi789 was rejected'))).toBe(
      'key [redacted] was rejected',
    );
  });

  test('collapses the message to one line and never carries the stack', () => {
    const err = new Error('provider failed\n  with a wrapped detail\n');

    /* Stacks name absolute paths in the user's home directory, and everything a
       surface can act on is in the message. */
    expect(describeError(err)).toBe('provider failed with a wrapped detail');
    expect(describeError(err)).not.toMatch(/\n/);
    expect(describeError(err)).not.toMatch(/agent-host/);
  });

  test('renders a non-Error throw rather than losing it', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(42)).toBe('42');
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined');
  });

  test('clamps a message that would otherwise log a novel', () => {
    expect(describeError(new Error('e'.repeat(LIMITS.errorChars + 500)))).toBe(
      `${'e'.repeat(LIMITS.errorChars)}${TRUNCATION_MARKER}`,
    );
  });
});

describe('clamp', () => {
  test('leaves text at or under the limit untouched, with no marker', () => {
    expect(clamp('abc', 3)).toBe('abc');
    expect(clamp('ab', 3)).toBe('ab');
    expect(clamp('', 0)).toBe('');
    expect(clamp('abc', 3)).not.toContain(TRUNCATION_MARKER);
  });

  test('appends the truncation marker past the limit', () => {
    expect(clamp('abcd', 3)).toBe(`abc${TRUNCATION_MARKER}`);
    /* The marker is *appended*, so the result is longer than the limit. That is
       deliberate — a bound that silently ate the marker would produce output
       indistinguishable from a message that happened to end there. */
    expect(clamp('x'.repeat(100), 10)).toBe(`${'x'.repeat(10)}${TRUNCATION_MARKER}`);
    expect(clamp('x'.repeat(100), 10).length).toBe(10 + TRUNCATION_MARKER.length);
  });
});

/* ========================================================================== */
/* session-manager.ts                                                          */
/* ========================================================================== */

/**
 * The runtime shape of `LiveSession`, restated locally.
 *
 * Not imported: the interface is module-private, and restating it is what makes
 * a field added upstream and not set here show up as a broken fake rather than
 * as a passing test over a half-built record.
 */
interface FakePendingApproval {
  callId: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout | null;
}

interface FakeAgentSession {
  abortCount: number;
  abort(): void;
  setMode(mode: PermissionMode): void;
  store: { meta: SessionMeta };
}

interface FakeLiveSession {
  id: string;
  session: FakeAgentSession;
  running: Promise<void> | null;
  aborted: boolean;
  closed: boolean;
  pending: Map<string, FakePendingApproval>;
  decided: Map<string, ApprovalDecision>;
  deltaBuffer: string;
  deltaTimer: NodeJS.Timeout | null;
  turnStreamChars: number;
  turnStreamTruncated: boolean;
}

/** The private surface these tests drive. `private` is erased at runtime. */
interface ManagerInternals {
  sessions: Map<string, FakeLiveSession>;
  awaitApproval(live: FakeLiveSession, request: ApprovalRequest): Promise<ApprovalDecision>;
  emitEvent(live: FakeLiveSession, event: AgentEvent): void;
}

function internals(manager: SessionManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

interface Harness {
  manager: SessionManager;
  sent: HostMessageDraft[];
}

function makeManager(overrides: Omit<SessionManagerOptions, 'send'> = {}): Harness {
  const sent: HostMessageDraft[] = [];
  const manager = new SessionManager({
    send: (message) => {
      sent.push(message);
    },
    ...overrides,
  });

  /* Instrumented in one place rather than at every call site, so the tests read
     as ordinary uses of the public API. The depth counter is what lets the
     resolver wrapper below tell "a decision arrived from outside" apart from
     "the manager settled this by itself", which is the distinction invariant 2
     is about. */
  const applyDecision = manager.resolveApproval.bind(manager);
  manager.resolveApproval = (sessionId, callId, decision) => {
    inboundDepth += 1;
    try {
      return applyDecision(sessionId, callId, decision);
    } finally {
      inboundDepth -= 1;
    }
  };

  return { manager, sent };
}

function installSession(manager: SessionManager, id: string): FakeLiveSession {
  const live: FakeLiveSession = {
    id,
    session: {
      abortCount: 0,
      abort(): void {
        this.abortCount += 1;
      },
      setMode(): void {
        /* nothing to record; mode changes are not what this file tests */
      },
      store: { meta: sessionMeta(id) },
    },
    running: null,
    aborted: false,
    closed: false,
    pending: new Map(),
    decided: new Map(),
    deltaBuffer: '',
    deltaTimer: null,
    turnStreamChars: 0,
    turnStreamTruncated: false,
  };
  internals(manager).sessions.set(id, live);
  return live;
}

/**
 * Every decision every approval in this file ends up with, and whether it came
 * from outside.
 *
 * The per-path assertions below say what each path does; this says what no path
 * does. Invariant 2 in `session-manager.ts` — "an approval never resolves to
 * `allow` on its own" — is a statement about *all* paths at once, so it is
 * checked over the accumulated set at the end of the block. Deliberately never
 * reset between tests: resetting it would leave the final assertion looking at
 * an empty list and passing for that reason.
 *
 * Covers the requests the manager answers immediately as well as the ones it
 * parks. Watching only the parked resolvers would miss the abort / closed /
 * shutting-down paths entirely, which are the paths most likely to be "fixed"
 * into an auto-allow by someone chasing a hung turn.
 */
const allResolverCalls: Array<{
  callId: string;
  decision: ApprovalDecision;
  inbound: boolean;
}> = [];

/** Non-zero while an inbound `approval` frame is being applied. */
let inboundDepth = 0;

interface ParkedApproval {
  /** `'pending'` until the promise settles. Read after `drainMicrotasks()`. */
  readonly state: { outcome: ApprovalDecision | 'pending' };
  /** One entry per *application* of a decision to this call's resolver. */
  readonly resolverCalls: ApprovalDecision[];
  /** False when the manager refused to park it and answered immediately. */
  readonly parked: boolean;
}

/**
 * Drive `requestApproval` the way agent-core does, and instrument the resolver.
 *
 * Wrapping the parked resolver is what makes "applied twice" observable. A
 * promise cannot settle twice regardless, so asserting on the promise alone
 * would pass even if `settleApproval` handed the same resolver two decisions —
 * which is precisely the bug the idempotency guarantee is about.
 */
function requestApproval(
  manager: SessionManager,
  live: FakeLiveSession,
  callId: string,
): ParkedApproval {
  const state: { outcome: ApprovalDecision | 'pending' } = { outcome: 'pending' };
  const resolverCalls: ApprovalDecision[] = [];

  const before = live.pending.get(callId);
  const promise = internals(manager).awaitApproval(live, approvalRequest(callId));
  const entry = live.pending.get(callId);
  const parked = entry !== undefined && entry !== before;

  void promise.then((decision) => {
    state.outcome = decision;
    /* A request the manager answered outright never reaches a resolver, so the
       wrapper below cannot see it. Record it here instead, as self-generated —
       nothing outside had a chance to decide it. */
    if (!parked) allResolverCalls.push({ callId, decision, inbound: false });
  });

  if (parked && entry) {
    const original = entry.resolve;
    entry.resolve = (decision) => {
      resolverCalls.push(decision);
      allResolverCalls.push({ callId, decision, inbound: inboundDepth > 0 });
      original(decision);
    };
  }

  return { state, resolverCalls, parked };
}

/** Let already-resolved promises run their `then` callbacks. */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('SessionManager approvals', () => {
  test('parks a request and settles it exactly once on the first decision', async () => {
    const { manager } = makeManager();
    const live = installSession(manager, SESSION_ID);

    const approval = requestApproval(manager, live, 'call_7');
    expect(approval.parked).toBe(true);
    expect(manager.pendingApprovalCount).toBe(1);

    await drainMicrotasks();
    expect(approval.state.outcome).toBe('pending');

    expect(manager.resolveApproval(SESSION_ID, 'call_7', 'allow')).toEqual({
      outcome: 'applied',
      decision: 'allow',
    });

    await drainMicrotasks();
    expect(approval.state.outcome).toBe('allow');
    expect(approval.resolverCalls).toEqual(['allow']);
    /* Taken out of `pending` in the same synchronous step it was applied. That
       deletion *is* the idempotency guarantee; `decided` is only the receipt. */
    expect(live.pending.size).toBe(0);
    expect(manager.pendingApprovalCount).toBe(0);
  });

  test('reports a replayed decision as a duplicate and applies nothing', async () => {
    const { manager } = makeManager();
    const live = installSession(manager, SESSION_ID);
    const approval = requestApproval(manager, live, 'call_7');

    expect(manager.resolveApproval(SESSION_ID, 'call_7', 'allow')).toEqual({
      outcome: 'applied',
      decision: 'allow',
    });

    /* The identical frame again — the shape a MessagePort redelivery or a
       retrying renderer produces. */
    expect(manager.resolveApproval(SESSION_ID, 'call_7', 'allow')).toEqual({
      outcome: 'duplicate_ignored',
      decision: 'allow',
    });

    await drainMicrotasks();
    expect(approval.resolverCalls).toEqual(['allow']);
    expect(approval.state.outcome).toBe('allow');
  });

  test('reports a *contradicting* replay as a duplicate and keeps the first decision', async () => {
    /* The dangerous direction. A `deny` that was applied must not be reopened by
       a later `allow` carrying the same callId, and the reply must name the
       decision actually in force so the surface does not draw a second prompt. */
    const { manager } = makeManager();
    const live = installSession(manager, SESSION_ID);
    const approval = requestApproval(manager, live, 'call_7');

    expect(manager.resolveApproval(SESSION_ID, 'call_7', 'deny')).toEqual({
      outcome: 'applied',
      decision: 'deny',
    });
    expect(manager.resolveApproval(SESSION_ID, 'call_7', 'allow')).toEqual({
      outcome: 'duplicate_ignored',
      decision: 'deny',
    });
    expect(manager.resolveApproval(SESSION_ID, 'call_7', 'allow_always')).toEqual({
      outcome: 'duplicate_ignored',
      decision: 'deny',
    });

    await drainMicrotasks();
    expect(approval.resolverCalls).toEqual(['deny']);
    expect(approval.state.outcome).toBe('deny');
  });

  test('reports an unknown callId, and an unknown session, as unknown_call', () => {
    const { manager } = makeManager();
    const live = installSession(manager, SESSION_ID);
    requestApproval(manager, live, 'call_7');

    expect(manager.resolveApproval(SESSION_ID, 'call_nobody_asked_about', 'allow')).toEqual({
      outcome: 'unknown_call',
      decision: null,
    });
    expect(manager.resolveApproval('sess_does_not_exist', 'call_7', 'allow')).toEqual({
      outcome: 'unknown_call',
      decision: null,
    });
    /* A decision addressed to the wrong session must not reach the right call. */
    expect(live.pending.has('call_7')).toBe(true);
  });

  test('does not apply a decision across sessions that share a callId', async () => {
    const { manager } = makeManager();
    const first = installSession(manager, 'sess_1');
    const second = installSession(manager, 'sess_2');
    const a = requestApproval(manager, first, 'call_7');
    const b = requestApproval(manager, second, 'call_7');

    expect(manager.resolveApproval('sess_1', 'call_7', 'allow')).toEqual({
      outcome: 'applied',
      decision: 'allow',
    });

    await drainMicrotasks();
    expect(a.state.outcome).toBe('allow');
    expect(b.state.outcome).toBe('pending');
    expect(b.resolverCalls).toEqual([]);
  });

  test('denies a request that arrives after abort, without parking it', async () => {
    const { manager } = makeManager();
    const live = installSession(manager, SESSION_ID);

    manager.abort(SESSION_ID);
    expect(live.aborted).toBe(true);
    expect(live.session.abortCount).toBe(1);

    const approval = requestApproval(manager, live, 'call_8');

    await drainMicrotasks();
    expect(approval.parked).toBe(false);
    expect(approval.state.outcome).toBe('deny');
    /* Nothing parked means nothing to leak and nothing for a late `allow` to
       find: the decision is already recorded. */
    expect(live.pending.size).toBe(0);
    expect(manager.resolveApproval(SESSION_ID, 'call_8', 'allow')).toEqual({
      outcome: 'duplicate_ignored',
      decision: 'deny',
    });
  });

  test('denies everything already waiting when a turn is aborted', async () => {
    const { manager } = makeManager();
    const live = installSession(manager, SESSION_ID);
    const a = requestApproval(manager, live, 'call_1');
    const b = requestApproval(manager, live, 'call_2');

    manager.abort(SESSION_ID);

    await drainMicrotasks();
    expect([a.state.outcome, b.state.outcome]).toEqual(['deny', 'deny']);
    expect(a.resolverCalls).toEqual(['deny']);
    expect(b.resolverCalls).toEqual(['deny']);
    /* Denied *before* `session.abort()`: a turn parked on an approval observes
       no AbortController, so aborting around it would suspend the loop forever. */
    expect(live.session.abortCount).toBe(1);
    expect(manager.pendingApprovalCount).toBe(0);
  });

  test('denies a second live request for a callId already waiting, and keeps the first', async () => {
    const { manager } = makeManager();
    const live = installSession(manager, SESSION_ID);

    const first = requestApproval(manager, live, 'call_7');
    const second = requestApproval(manager, live, 'call_7');

    await drainMicrotasks();
    /* The newcomer is denied rather than allowed to overwrite the resolver:
       overwriting strands the first promise, and the first promise is the one a
       user may be looking at. */
    expect(second.parked).toBe(false);
    expect(second.state.outcome).toBe('deny');
    expect(first.state.outcome).toBe('pending');

    expect(manager.resolveApproval(SESSION_ID, 'call_7', 'allow')).toEqual({
      outcome: 'applied',
      decision: 'allow',
    });
    await drainMicrotasks();
    expect(first.state.outcome).toBe('allow');
    expect(first.resolverCalls).toEqual(['allow']);
  });

  test('denies a request that arrives on a closed session', async () => {
    const { manager } = makeManager();
    const live = installSession(manager, SESSION_ID);
    live.closed = true;

    const approval = requestApproval(manager, live, 'call_9');

    await drainMicrotasks();
    expect(approval.parked).toBe(false);
    expect(approval.state.outcome).toBe('deny');
  });

  test('closeSession denies what it was holding and drops the session', async () => {
    const { manager, sent } = makeManager();
    const live = installSession(manager, SESSION_ID);
    const approval = requestApproval(manager, live, 'call_7');

    manager.closeSession(SESSION_ID, 'Closed by the app.');

    await drainMicrotasks();
    expect(approval.state.outcome).toBe('deny');
    expect(manager.liveSessionCount).toBe(0);
    expect(sent.at(-1)).toEqual({
      type: 'session_closed',
      sessionId: SESSION_ID,
      reason: 'Closed by the app.',
    });
  });

  test('shutdown denies every approval still waiting, in every session', async () => {
    const { manager } = makeManager();
    const first = installSession(manager, 'sess_1');
    const second = installSession(manager, 'sess_2');
    const approvals = [
      requestApproval(manager, first, 'call_1'),
      requestApproval(manager, first, 'call_2'),
      requestApproval(manager, second, 'call_3'),
    ];
    expect(manager.pendingApprovalCount).toBe(3);

    const result = await manager.shutdown(0);

    expect(result).toEqual({ cancelledSessions: 2, deniedApprovals: 3, forced: false });
    await drainMicrotasks();
    for (const approval of approvals) {
      expect(approval.state.outcome).toBe('deny');
      expect(approval.resolverCalls).toEqual(['deny']);
    }
    expect(manager.liveSessionCount).toBe(0);
    expect(manager.pendingApprovalCount).toBe(0);
  });

  test('a request that arrives while shutting down is denied, not parked', async () => {
    const { manager } = makeManager();
    const live = installSession(manager, SESSION_ID);

    await manager.shutdown(0);
    const approval = requestApproval(manager, live, 'call_late');

    await drainMicrotasks();
    expect(approval.parked).toBe(false);
    expect(approval.state.outcome).toBe('deny');
  });

  test('auto-denies an unanswered approval once the timeout elapses', async () => {
    const { manager } = makeManager({ approvalTimeoutMs: 5 });
    const live = installSession(manager, SESSION_ID);
    const approval = requestApproval(manager, live, 'call_7');

    expect(approval.parked).toBe(true);
    await vi.waitFor(() => {
      expect(approval.state.outcome).toBe('deny');
    });
    expect(approval.resolverCalls).toEqual(['deny']);
    /* And a decision that arrives after the timeout cannot reopen it. */
    expect(manager.resolveApproval(SESSION_ID, 'call_7', 'allow')).toEqual({
      outcome: 'duplicate_ignored',
      decision: 'deny',
    });
  });

  test('the decision receipt is bounded, and losing one cannot make a replay apply', async () => {
    const { manager } = makeManager({ maxDecisionHistory: 2 });
    const live = installSession(manager, SESSION_ID);

    for (const callId of ['call_1', 'call_2', 'call_3']) {
      requestApproval(manager, live, callId);
      manager.resolveApproval(SESSION_ID, callId, 'deny');
    }
    await drainMicrotasks();

    expect(live.decided.size).toBe(2);
    /* The oldest receipt has fallen out, so a replay of it is reported as
       `unknown_call` rather than `duplicate_ignored`. What must *not* change is
       that it still applies nothing — the resolver is long gone from `pending`. */
    expect(manager.resolveApproval(SESSION_ID, 'call_1', 'allow')).toEqual({
      outcome: 'unknown_call',
      decision: null,
    });
    expect(live.pending.size).toBe(0);
  });

  test('no approval anywhere in this block was ever resolved to allow on its own', () => {
    /* Runs last in the block, over everything the tests above accumulated. Each
       test asserts its own path; this asserts the invariant across all of them:
       every non-deny decision a resolver ever saw arrived from outside, through
       `resolveApproval`. Abort, close, shutdown, timeout and the duplicate-callId
       path produce `deny` and nothing else. */
    const spontaneous = allResolverCalls.filter(
      (call) => !call.inbound && call.decision !== 'deny',
    );
    expect(spontaneous).toEqual([]);

    /* The set is only meaningful if it is populated — an accumulator reset
       between tests, or a wrapper that never fired, would make the filter above
       pass for the wrong reason. */
    expect(allResolverCalls.filter((call) => call.inbound).length).toBeGreaterThan(0);
    expect(allResolverCalls.filter((call) => !call.inbound).length).toBeGreaterThan(0);
    expect(allResolverCalls.some((call) => call.decision === 'allow')).toBe(true);
  });
});

/* ========================================================================== */
/* Event bounding                                                              */
/* ========================================================================== */

type EventMessage = Extract<HostMessageDraft, { type: 'event' }>;

/**
 * The event type as the *schema* infers it, which is deliberately not
 * `AgentEvent`.
 *
 * Zod's `.optional()` infers `agentId?: string | undefined`, while agent-core
 * declares `agentId?: string`. Under `exactOptionalPropertyTypes` those are
 * different types, and the schema's is not assignable to agent-core's — so
 * annotating this `AgentEvent[]` is a compile error. That gap is real and is
 * documented in `src/shared/agent-protocol.ts`; pinning it here rather than
 * casting past it keeps the difference visible.
 */
type ParsedAgentEvent = EventMessage['event'];

function eventsFrom(sent: HostMessageDraft[]): ParsedAgentEvent[] {
  return sent
    .filter((message): message is EventMessage => message.type === 'event')
    .map((message) => message.event);
}

function expectType<T extends ParsedAgentEvent['type']>(
  event: ParsedAgentEvent | undefined,
  type: T,
): Extract<ParsedAgentEvent, { type: T }> {
  if (event === undefined || event.type !== type) {
    throw new Error(`expected a ${type} event, got ${event === undefined ? 'nothing' : event.type}`);
  }
  return event as Extract<ParsedAgentEvent, { type: T }>;
}

describe('SessionManager event bounding', () => {
  const HUGE = 'x'.repeat(20_000);

  test('clamps every string inside a tool_started input to the tool limit', () => {
    const { manager, sent } = makeManager();
    const live = installSession(manager, SESSION_ID);

    internals(manager).emitEvent(live, {
      type: 'tool_started',
      callId: 'call_7',
      name: 'write_file',
      input: { path: 'src/main/security.ts', contents: HUGE, nested: { more: HUGE } },
      risk: 'edit',
    });

    const event = expectType(eventsFrom(sent)[0], 'tool_started');
    /* agent-core truncates `tool_finished.output` but not `tool_started.input`,
       which for a `write_file` call is the entire file being written — and it
       crosses a process boundary as a structured clone on every turn. */
    expect(event.input).toEqual({
      path: 'src/main/security.ts',
      contents: `${'x'.repeat(TOOL_INPUT_LIMIT)}${TRUNCATION_MARKER}`,
      nested: { more: `${'x'.repeat(TOOL_INPUT_LIMIT)}${TRUNCATION_MARKER}` },
    });
  });

  test('gives approval_requested the far larger allowance', () => {
    const { manager, sent } = makeManager();
    const live = installSession(manager, SESSION_ID);

    internals(manager).emitEvent(live, {
      type: 'approval_requested',
      request: { ...approvalRequest('call_7'), input: { contents: HUGE }, summary: HUGE },
    });

    const event = expectType(eventsFrom(sent)[0], 'approval_requested');
    /* This is the payload a human is being asked to authorise: a truncated
       preview of a destructive action is worse than a large message. 20 000
       characters would have been clamped under the tool limit and are not
       clamped here — that difference is the whole assertion. */
    expect(event.request.input).toEqual({ contents: HUGE });
    expect(HUGE.length).toBeGreaterThan(TOOL_INPUT_LIMIT);
    /* The summary is a one-line label, so it keeps the smaller bound. */
    expect(event.request.summary).toBe(`${'x'.repeat(TOOL_INPUT_LIMIT)}${TRUNCATION_MARKER}`);
  });

  test('clamps an approval input that overruns even the larger allowance', () => {
    const { manager, sent } = makeManager();
    const live = installSession(manager, SESSION_ID);
    const enormous = 'y'.repeat(APPROVAL_INPUT_LIMIT + 5_000);

    internals(manager).emitEvent(live, {
      type: 'approval_requested',
      request: { ...approvalRequest('call_7'), input: { contents: enormous } },
    });

    const event = expectType(eventsFrom(sent)[0], 'approval_requested');
    expect(event.request.input).toEqual({
      contents: `${'y'.repeat(APPROVAL_INPUT_LIMIT)}${TRUNCATION_MARKER}`,
    });
  });

  test('rebuilds a tool input out of clonable values only', () => {
    /* `input` is `unknown`, and `postMessage` throws on anything the structured
       clone algorithm cannot copy — which would take down a host holding live
       sessions over one bad event. */
    const { manager, sent } = makeManager();
    const live = installSession(manager, SESSION_ID);

    internals(manager).emitEvent(live, {
      type: 'tool_started',
      callId: 'call_7',
      name: 'shell',
      input: { fn: () => undefined, big: 10n, nan: Number.NaN, ok: true, nothing: null },
      risk: 'command',
    });

    const event = expectType(eventsFrom(sent)[0], 'tool_started');
    expect(event.input).toEqual({
      fn: '[function]',
      big: '10',
      nan: 'NaN',
      ok: true,
      nothing: null,
    });
    expect(() => structuredClone(event.input)).not.toThrow();
  });

  test('coalesces consecutive deltas into one flushed event', async () => {
    const { manager, sent } = makeManager({ deltaFlushMs: 5 });
    const live = installSession(manager, SESSION_ID);

    for (const text of ['Look', 'ing ', 'at ', 'the ', 'file']) {
      internals(manager).emitEvent(live, { type: 'assistant_delta', text });
    }

    /* A turn produces thousands of these, each one otherwise costing a
       structured clone and an IPC hop. Nothing has crossed the port yet. */
    expect(sent).toEqual([]);

    await vi.waitFor(() => {
      expect(sent.length).toBe(1);
    });
    expect(sent[0]).toEqual({
      type: 'event',
      sessionId: SESSION_ID,
      event: { type: 'assistant_delta', text: 'Looking at the file' },
    });
  });

  test('flushes the buffered deltas before the next non-delta event', () => {
    const { manager, sent } = makeManager();
    const live = installSession(manager, SESSION_ID);

    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'Hello ' });
    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'world' });
    expect(sent).toEqual([]);

    internals(manager).emitEvent(live, {
      type: 'tool_started',
      callId: 'call_7',
      name: 'read_file',
      input: { path: 'a.ts' },
      risk: 'safe',
    });

    /* Ordering, not just merging: coalescing that let text arrive *after* the
       tool event it preceded would reorder the transcript the user reads. */
    expect(sent).toEqual([
      {
        type: 'event',
        sessionId: SESSION_ID,
        event: { type: 'assistant_delta', text: 'Hello world' },
      },
      {
        type: 'event',
        sessionId: SESSION_ID,
        event: {
          type: 'tool_started',
          callId: 'call_7',
          name: 'read_file',
          input: { path: 'a.ts' },
          risk: 'safe',
        },
      },
    ]);
  });

  test('flushes before every kind of non-delta event, not just tool events', () => {
    const { manager, sent } = makeManager();
    const live = installSession(manager, SESSION_ID);

    const followers: AgentEvent[] = [
      { type: 'turn_started', turnIndex: 0 },
      { type: 'assistant_message', text: 'done' },
      { type: 'approval_requested', request: approvalRequest('call_7') },
      { type: 'turn_finished', turnIndex: 0, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'error', message: 'Provider returned 529' },
    ];

    for (const follower of followers) {
      sent.length = 0;
      internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'partial' });
      internals(manager).emitEvent(live, follower);

      expect(eventsFrom(sent)[0]).toEqual({ type: 'assistant_delta', text: 'partial' });
      expect(expectType(eventsFrom(sent)[1], follower.type).type).toBe(follower.type);
    }
  });

  test('forces an early flush once the coalesced buffer is large enough', () => {
    const { manager, sent } = makeManager({ deltaFlushChars: 8 });
    const live = installSession(manager, SESSION_ID);

    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'abcd' });
    expect(sent).toEqual([]);
    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'efgh' });

    expect(eventsFrom(sent)).toEqual([{ type: 'assistant_delta', text: 'abcdefgh' }]);
  });

  test('deltaFlushMs of 0 disables coalescing entirely', () => {
    const { manager, sent } = makeManager({ deltaFlushMs: 0 });
    const live = installSession(manager, SESSION_ID);

    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'a' });
    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'b' });

    expect(eventsFrom(sent)).toEqual([
      { type: 'assistant_delta', text: 'a' },
      { type: 'assistant_delta', text: 'b' },
    ]);
  });

  test('stops streaming deltas past the per-turn ceiling and says so once', () => {
    const { manager, sent } = makeManager({ maxTurnStreamChars: 10, deltaFlushMs: 0 });
    const live = installSession(manager, SESSION_ID);

    for (let i = 0; i < 5; i += 1) {
      internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'abcde' });
    }

    expect(eventsFrom(sent)).toEqual([
      { type: 'assistant_delta', text: 'abcde' },
      { type: 'assistant_delta', text: 'abcde' },
    ]);
    expect(manager.droppedEventCount).toBe(3);
    /* Reported as host diagnostics, not as a synthetic `error` event: the turn
       is not in error, and inventing one would put a lie in the event log. */
    expect(sent.filter((message) => message.type === 'log').length).toBe(1);
  });

  test('a new turn restores the per-turn stream allowance', () => {
    const { manager, sent } = makeManager({ maxTurnStreamChars: 5, deltaFlushMs: 0 });
    const live = installSession(manager, SESSION_ID);

    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'abcde' });
    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'dropped' });
    internals(manager).emitEvent(live, { type: 'turn_started', turnIndex: 1 });
    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'fghij' });

    expect(eventsFrom(sent)).toEqual([
      { type: 'assistant_delta', text: 'abcde' },
      { type: 'turn_started', turnIndex: 1 },
      { type: 'assistant_delta', text: 'fghij' },
    ]);
  });

  test('clamps the other unbounded event fields', () => {
    const { manager, sent } = makeManager();
    const live = installSession(manager, SESSION_ID);

    internals(manager).emitEvent(live, { type: 'error', message: 'e'.repeat(LIMITS.errorChars + 1) });
    internals(manager).emitEvent(live, {
      type: 'tool_finished',
      callId: 'call_7',
      name: 'read_file',
      output: HUGE,
      isError: false,
      durationMs: 12,
    });

    const [error, finished] = eventsFrom(sent);
    expect(expectType(error, 'error').message).toBe(
      `${'e'.repeat(LIMITS.errorChars)}${TRUNCATION_MARKER}`,
    );
    expect(expectType(finished, 'tool_finished').output).toBe(
      `${'x'.repeat(TOOL_INPUT_LIMIT)}${TRUNCATION_MARKER}`,
    );
  });

  test('emits nothing at all for a closed session', () => {
    const { manager, sent } = makeManager();
    const live = installSession(manager, SESSION_ID);
    live.closed = true;

    internals(manager).emitEvent(live, { type: 'assistant_message', text: 'hi' });
    internals(manager).emitEvent(live, { type: 'assistant_delta', text: 'hi' });

    expect(sent).toEqual([]);
  });
});

/* ========================================================================== */
/* index.ts — the utilityProcess entry point                                   */
/* ========================================================================== */

interface FakePort {
  postMessage(message: unknown): void;
  on(channel: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
}

interface LoadedHost {
  /** Raw frames the host wrote to the port, in order. */
  posted: unknown[];
  /** Deliver one frame as if it had arrived on the port. */
  deliver(frame: unknown): void;
  /** Codes passed to the stubbed `process.exit`. */
  exitCodes: number[];
}

/** A view of `process` that admits the Electron-only `parentPort`. */
const hostProcess = process as unknown as { parentPort?: FakePort };

/**
 * The listeners `index.ts` installs at module scope. Saved and restored around
 * every load so that repeated imports do not stack handlers on this process —
 * an `uncaughtException` handler from a torn-down module instance would call a
 * `shutdown()` that has no port left.
 */
const PROCESS_EVENTS = [
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'disconnect',
  'uncaughtException',
  'unhandledRejection',
] as const;

type AnyListener = (...args: unknown[]) => void;

/** The handlers `index.ts` installed for `event`, as opposed to the runner's. */
function listenersAddedBy(
  event: (typeof PROCESS_EVENTS)[number],
  saved: Map<string, AnyListener[]>,
): AnyListener[] {
  const before = new Set(saved.get(event) ?? []);
  return (process.rawListeners(event) as AnyListener[]).filter(
    (listener) => !before.has(listener),
  );
}

async function loadHost(): Promise<LoadedHost> {
  const posted: unknown[] = [];
  const exitCodes: number[] = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];

  hostProcess.parentPort = {
    postMessage(message) {
      posted.push(message);
    },
    on(_channel, listener) {
      listeners.push(listener);
    },
    start() {
      /* Electron's port needs starting; the fake has nothing to start. */
    },
  };

  vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    exitCodes.push(typeof code === 'number' ? code : 0);
    return undefined as never;
  }) as typeof process.exit);

  /* A fresh module instance per test: the entry point owns process-global state
     — the outbound counter, the replay guard, the once-only shutdown latch — and
     a shared instance would make each test depend on the ones before it. */
  vi.resetModules();
  await import('../../src/agent-host/index');

  return {
    posted,
    exitCodes,
    deliver(frame) {
      for (const listener of listeners) listener({ data: frame });
    },
  };
}

/** Parse every outbound frame against the host's own schema. */
function outbound(posted: unknown[]): HostMessage[] {
  return posted.map((raw) => {
    const result = parseHostMessage(raw);
    if (!result.ok) {
      throw new Error(`the host emitted a frame that fails its own contract: ${result.error}`);
    }
    return result.value;
  });
}

const COOKIE_CANARY = 'CANARY_COOKIE_9f8e7d6c5b4a';

function configureFrame(seq: number): Extract<HostCommand, { type: 'configure' }> {
  return {
    type: 'configure',
    seq,
    requestId: 'req_configure',
    backend: {
      baseUrl: 'https://juno.example',
      cookie: `juno_session=${COOKIE_CANARY}`,
      authorization: `Bearer ${COOKIE_CANARY}`,
      models: [
        {
          provider: 'backend/anthropic',
          kind: 'anthropic',
          model: 'claude-opus-5',
          label: 'Opus 5',
          available: true,
        },
      ],
    },
  };
}

describe('the utilityProcess entry point', () => {
  let savedListeners: Map<string, AnyListener[]>;

  beforeEach(() => {
    savedListeners = new Map(
      PROCESS_EVENTS.map((event) => [event, process.rawListeners(event) as AnyListener[]]),
    );
    /* The host writes to stderr on the paths this block exercises. Silenced so a
       passing run is readable, restored afterwards. */
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const event of PROCESS_EVENTS) {
      process.removeAllListeners(event);
      for (const listener of savedListeners.get(event) ?? []) process.on(event, listener);
    }
    delete hostProcess.parentPort;
    vi.restoreAllMocks();
  });

  test('announces itself before anything else', async () => {
    const host = await loadHost();

    /* `ready` carries the protocol version main uses to decide whether it can
       drive this host at all, so it cannot follow anything. */
    expect(outbound(host.posted)[0]).toEqual({
      type: 'ready',
      seq: 1,
      protocolVersion: HOST_PROTOCOL_VERSION,
      pid: process.pid,
    });
  });

  test('installs exactly one handler for every termination path', async () => {
    await loadHost();

    /* "Nothing exits without tearing down": a signal, a lost port and an
       uncaught exception all have to reach `shutdown()`, and a path with no
       handler is a host that dies holding live sessions and detached children. */
    for (const event of PROCESS_EVENTS) {
      expect(listenersAddedBy(event, savedListeners)).toHaveLength(1);
    }
  });

  test('answers a heartbeat probe with its counters', async () => {
    const host = await loadHost();
    host.deliver({ type: 'heartbeat', seq: 1 });

    const messages = outbound(host.posted);
    expect(messages.length).toBe(2);
    const beat = messages[1];
    if (beat?.type !== 'heartbeat') throw new Error(`expected a heartbeat, got ${String(beat?.type)}`);

    /* `respondingToSeq` is what distinguishes a reply from the unsolicited beat;
       without it main cannot tell a live host from a wedged one that is still
       ticking. */
    expect(beat.respondingToSeq).toBe(1);
    expect(beat.seq).toBe(2);
    expect(beat.liveSessions).toBe(0);
    expect(beat.runningSessions).toBe(0);
    expect(beat.pendingApprovals).toBe(0);
    expect(beat.droppedEvents).toBe(0);
    expect(beat.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  test.each([
    ['a frame that is not an object', 'shutdown'],
    ['a frame with no type', { seq: 1, requestId: 'r' }],
    ['a command the host does not implement', { type: 'exec', seq: 1, command: 'sh' }],
    ['an approval with no callId', { type: 'approval', seq: 1, requestId: 'r', sessionId: 's', decision: 'allow' }],
    ['a frame with seq 0', { type: 'heartbeat', seq: 0 }],
    ['null', null],
  ])('answers %s with protocol_error{invalid_request}', async (_label, frame) => {
    const host = await loadHost();
    host.deliver(frame);

    const messages = outbound(host.posted);
    const error = messages[1];
    if (error?.type !== 'protocol_error') {
      throw new Error(`expected a protocol_error, got ${String(error?.type)}`);
    }
    /* `invalid_request`, not `command_error`: no `requestId` on a frame that
       failed validation is trustworthy enough to correlate against. */
    expect(error.code).toBe('invalid_request');
    expect(error.message.length).toBeGreaterThan(0);
  });

  test('answers a replayed seq with protocol_error{stale_seq} and does not act on it', async () => {
    const host = await loadHost();

    host.deliver({ type: 'heartbeat', seq: 4 });
    host.deliver({ type: 'heartbeat', seq: 4 });
    host.deliver({ type: 'heartbeat', seq: 3 });

    const messages = outbound(host.posted);
    /* ready, the one heartbeat that was accepted, then two rejections. The
       count is the assertion: a replayed frame must produce no work. */
    expect(messages.map((message) => message.type)).toEqual([
      'ready',
      'heartbeat',
      'protocol_error',
      'protocol_error',
    ]);
    for (const message of messages.slice(2)) {
      if (message.type !== 'protocol_error') throw new Error('expected a protocol_error');
      expect(message.code).toBe('stale_seq');
    }
  });

  test('a malformed frame does not advance the replay watermark', async () => {
    const host = await loadHost();

    host.deliver({ type: 'heartbeat', seq: 7 });
    host.deliver({ type: 'nonsense', seq: 8 });
    /* Parsing runs before the guard, so the bad frame never reached it: seq 8
       must still be usable by a legitimate frame. */
    host.deliver({ type: 'heartbeat', seq: 8 });

    expect(outbound(host.posted).map((message) => message.type)).toEqual([
      'ready',
      'heartbeat',
      'protocol_error',
      'heartbeat',
    ]);
  });

  test('stamps a strictly increasing seq on every outbound frame', async () => {
    const host = await loadHost();

    host.deliver({ type: 'heartbeat', seq: 1 });
    host.deliver(configureFrame(2));
    host.deliver({ type: 'garbage' });
    host.deliver({ type: 'heartbeat', seq: 3 });
    host.deliver({ type: 'heartbeat', seq: 3 });
    host.deliver({ type: 'abort', seq: 4, requestId: 'r', sessionId: 'sess_nope' });

    const seqs = outbound(host.posted).map((message) => message.seq);
    expect(seqs.length).toBeGreaterThan(5);
    /* Not merely sorted — strictly increasing. Two frames sharing a seq would
       be indistinguishable from a redelivery on the receiving side. */
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(1);
  });

  test('reports an unknown session as a command_error the caller can attribute', async () => {
    const host = await loadHost();
    host.deliver({ type: 'abort', seq: 1, requestId: 'req_abort', sessionId: 'sess_nope' });

    const error = outbound(host.posted)[1];
    if (error?.type !== 'command_error') {
      throw new Error(`expected a command_error, got ${String(error?.type)}`);
    }
    expect(error.code).toBe('unknown_session');
    expect(error.requestId).toBe('req_abort');
    expect(error.sessionId).toBe('sess_nope');
  });

  test('never lets the backend cookie back out over the port', async () => {
    const host = await loadHost();

    host.deliver(configureFrame(1));
    /* The same credentials again inside a frame that fails validation, so the
       error path is covered as well as the success path — Zod quotes received
       values, and `describeFailure` is the only thing standing between that and
       a log line. `baseUrl: ''` is what makes it fail. */
    const rejected = configureFrame(2);
    host.deliver({ ...rejected, backend: { ...rejected.backend, baseUrl: '' } });
    host.deliver({ type: 'heartbeat', seq: 3 });

    const messages = outbound(host.posted);
    expect(messages[1]).toEqual({ type: 'ack', seq: 2, requestId: 'req_configure' });
    /* One assertion over everything that crossed the port, rather than per
       frame: the claim is that the cookie appears nowhere, and a per-frame check
       would miss the frame nobody thought to look at. */
    expect(JSON.stringify(messages)).not.toContain(COOKIE_CANARY);
    expect(JSON.stringify(host.posted)).not.toContain(COOKIE_CANARY);
  });

  test('acknowledges a shutdown command and exits 0', async () => {
    const host = await loadHost();
    host.deliver({ type: 'shutdown', seq: 1, requestId: 'req_bye', graceMs: 0 });

    await vi.waitFor(() => {
      expect(host.exitCodes).toEqual([0]);
    });

    const last = outbound(host.posted).at(-1);
    if (last?.type !== 'shutdown_complete') {
      throw new Error(`expected shutdown_complete, got ${String(last?.type)}`);
    }
    /* The acknowledgement is the whole point of having a `shutdown` command
       rather than a signal: main waits for this instead of guessing how long the
       host needs before escalating to `kill()`. */
    expect(last.requestId).toBe('req_bye');
    expect(last).toEqual({
      type: 'shutdown_complete',
      seq: last.seq,
      requestId: 'req_bye',
      cancelledSessions: 0,
      deniedApprovals: 0,
      reapedProcessGroups: 0,
      forced: false,
    });
  });

  test('runs shutdown once however many times it is asked', async () => {
    const host = await loadHost();

    host.deliver({ type: 'shutdown', seq: 1, requestId: 'req_bye', graceMs: 0 });
    host.deliver({ type: 'shutdown', seq: 2, requestId: 'req_bye_again', graceMs: 0 });
    /* The signal path converges on the same `shutdown()`. Its handler is invoked
       directly rather than via `process.emit('SIGTERM')`: the suite shares this
       process, and emitting a real signal would also reach the runner's own
       handlers. */
    const signalHandlers = listenersAddedBy('SIGTERM', savedListeners);
    expect(signalHandlers.length).toBe(1);
    for (const handler of signalHandlers) handler('SIGTERM');

    await vi.waitFor(() => {
      expect(host.exitCodes).toEqual([0]);
    });

    const completions = outbound(host.posted).filter(
      (message) => message.type === 'shutdown_complete',
    );
    /* A second teardown would deny approvals a second time and report counts
       that had already been reported. */
    expect(completions.length).toBe(1);
    expect(host.exitCodes).toEqual([0]);
  });
});
