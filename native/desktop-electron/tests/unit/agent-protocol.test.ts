/**
 * The agent-core wire protocol validators.
 *
 * These are the boundary between this process and the agent host, which
 * `THREAT_MODEL.md` treats as untrusted. So the tests here are as interested in
 * what the schemas *reject* as in what they accept: a validator that accepts
 * everything is indistinguishable from no validator at all, and the failure mode
 * of the missing rejection is silent.
 *
 * `src/shared/agent-protocol.ts` already carries a compile-time drift gate
 * (`assertExactly`) against `runner/agent-core/src/types.ts`. That gate is the
 * right primary control and this file does not duplicate it — but a
 * compile-time gate is one `any` or one misconfigured `paths` entry away from
 * being inert, and during this workspace's first week it was exactly that (the
 * agent-core import resolved to `any`, so all eight assertions passed
 * vacuously). So the variant list is restated below as runtime data, where
 * nothing can erase it.
 */

import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { AgentEvent, ApprovalRequest, SubagentSnapshot } from '@juno/agent-core';
import {
  AgentEventSchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  PermissionModeSchema,
  RiskLevelSchema,
  SessionMetaSchema,
  SidecarCommandSchema,
  type SidecarMessageSchema,
  SubagentSnapshotSchema,
  parseSidecarMessage,
} from '@shared/agent-protocol';

/**
 * Imported from agent-core, not inferred from the schema.
 *
 * `z.infer<typeof AgentEventSchema>` would be circular for this purpose: a
 * sample table typed by the schema it is meant to test agrees with that schema
 * by construction. Typing it from the source of truth means a variant added
 * upstream and mirrored into the schema — but never sampled here — is a
 * compile error.
 */
type EventSamples = {
  [T in AgentEvent['type']]: Extract<AgentEvent, { type: T }>;
};

/**
 * The event variants declared by `runner/agent-core/src/types.ts`, transcribed
 * in source order. Kept as literal data so that an event added to agent-core and
 * mirrored into the schema — but never sampled here — fails this file.
 */
const DECLARED_EVENT_TYPES = [
  'session_started',
  'turn_started',
  'assistant_delta',
  'assistant_message',
  'tool_started',
  'tool_finished',
  'tool_denied',
  'approval_requested',
  'approval_resolved',
  'files_changed',
  'mode_changed',
  'turn_finished',
  'error',
  'subagent_update',
] as const;

/**
 * Typed by agent-core, not by `z.infer`.
 *
 * This is not cosmetic. `z.infer` of a `.optional()` field yields
 * `agentId?: string | undefined`, whereas agent-core declares `agentId?: string`
 * — and under `exactOptionalPropertyTypes` those are different types. Typing the
 * samples from the source of truth is what makes the difference visible here
 * rather than silently absorbed.
 */
const APPROVAL_REQUEST: ApprovalRequest = {
  callId: 'call_7',
  toolName: 'shell',
  input: { command: 'rm -rf build' },
  risk: 'command',
  summary: 'Run `rm -rf build` in /Users/x/juno',
  agentLabel: 'builder · Implement auth API',
};

const SUBAGENT: SubagentSnapshot = {
  id: 'sub_1',
  title: 'Implement auth API',
  role: 'builder',
  model: 'claude-opus-5',
  isolation: 'worktree',
  writes: true,
  status: 'running',
  currentActivity: 'Editing src/auth/token.ts',
  usage: { inputTokens: 1200, outputTokens: 340 },
  filesChanged: ['src/auth/token.ts'],
  worktreeBranch: 'juno/sub_1',
  startedAt: '2026-08-12T09:00:00.000Z',
};

/** One well-formed sample per variant. The mapped type forbids a wrong shape. */
const EVENT_SAMPLES: EventSamples = {
  session_started: {
    type: 'session_started',
    sessionId: 'sess_1',
    cwd: '/Users/x/juno',
    provider: 'anthropic',
    model: 'claude-opus-5',
    mode: 'ask',
  },
  turn_started: { type: 'turn_started', turnIndex: 0 },
  assistant_delta: { type: 'assistant_delta', text: 'Look' },
  assistant_message: { type: 'assistant_message', text: 'Looking at the file now.' },
  tool_started: {
    type: 'tool_started',
    callId: 'call_7',
    name: 'read_file',
    input: { path: 'src/main/security.ts' },
    risk: 'safe',
  },
  tool_finished: {
    type: 'tool_finished',
    callId: 'call_7',
    name: 'read_file',
    output: '…268 lines…',
    isError: false,
    durationMs: 12,
    agentId: 'sub_1',
  },
  tool_denied: {
    type: 'tool_denied',
    callId: 'call_8',
    name: 'shell',
    reason: 'Workspace is not trusted',
  },
  approval_requested: { type: 'approval_requested', request: APPROVAL_REQUEST },
  approval_resolved: { type: 'approval_resolved', callId: 'call_7', decision: 'allow_always' },
  files_changed: {
    type: 'files_changed',
    turnIndex: 3,
    paths: ['src/main/security.ts', 'src/shared/ipc.ts'],
  },
  mode_changed: { type: 'mode_changed', mode: 'auto-edit' },
  turn_finished: {
    type: 'turn_finished',
    turnIndex: 3,
    stopReason: 'end_turn',
    usage: { inputTokens: 8000, outputTokens: 900 },
    subagentUsage: { inputTokens: 1200, outputTokens: 340 },
  },
  error: { type: 'error', message: 'Provider returned 529' },
  subagent_update: { type: 'subagent_update', agent: SUBAGENT },
};

/** The literal `type` of each arm of the discriminated union. */
function unionDiscriminators(): string[] {
  return AgentEventSchema.options.map((option) => String(option.shape.type.value));
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                    */
/* -------------------------------------------------------------------------- */

describe('the event union', () => {
  test('covers every variant agent-core declares, and no others', () => {
    expect([...unionDiscriminators()].sort()).toEqual([...DECLARED_EVENT_TYPES].sort());
  });

  test('has a sample for every variant', () => {
    expect(Object.keys(EVENT_SAMPLES).sort()).toEqual([...DECLARED_EVENT_TYPES].sort());
  });

  test.each(DECLARED_EVENT_TYPES)('round-trips a %s event unchanged', (type) => {
    const sample = EVENT_SAMPLES[type];
    const result = AgentEventSchema.safeParse(sample);

    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
    /* Deep equality, not `toMatchObject`: a schema that quietly dropped or
       coerced a field would still satisfy a partial match. */
    expect(result.success && result.data).toEqual(sample);
  });

  test.each(DECLARED_EVENT_TYPES)('survives a real JSON hop as a %s event', (type) => {
    const overWire: unknown = JSON.parse(JSON.stringify(EVENT_SAMPLES[type]));
    expect(AgentEventSchema.safeParse(overWire).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Rejection                                                                   */
/* -------------------------------------------------------------------------- */

describe('a malformed event', () => {
  test('is rejected when the discriminator is a type nobody declared', () => {
    expect(AgentEventSchema.safeParse({ type: 'telepathy', text: 'hi' }).success).toBe(false);
    /* Near-misses matter more than nonsense: a typo'd or renamed event must not
       be silently accepted by some looser arm of the union. */
    expect(AgentEventSchema.safeParse({ type: 'assistant_deltas', text: 'hi' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'ASSISTANT_DELTA', text: 'hi' }).success).toBe(false);
  });

  test('is rejected when the discriminator is missing entirely', () => {
    expect(AgentEventSchema.safeParse({ text: 'hi' }).success).toBe(false);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"type":"error","message":"x"}'],
    ['a number', 7],
    ['an array', [{ type: 'error', message: 'x' }]],
  ])('is rejected when the frame is %s rather than an object', (_label, value) => {
    expect(AgentEventSchema.safeParse(value).success).toBe(false);
  });

  test('is rejected when a required field is missing', () => {
    expect(AgentEventSchema.safeParse({ type: 'turn_started' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'assistant_delta' }).success).toBe(false);
    expect(
      AgentEventSchema.safeParse({ type: 'files_changed', turnIndex: 1 }).success,
    ).toBe(false);
    /* `input: unknown` is a required key, not an optional one — Zod 4 treats a
       bare `z.unknown()` inside an object as non-optional. An agent host that
       omitted the tool input would be approving a tool call whose arguments
       nobody can see, so this rejection is load-bearing. */
    expect(
      AgentEventSchema.safeParse({
        type: 'tool_started',
        callId: 'call_7',
        name: 'shell',
        risk: 'command',
      }).success,
    ).toBe(false);
  });

  test('is rejected when a field has the wrong type', () => {
    expect(AgentEventSchema.safeParse({ type: 'turn_started', turnIndex: '3' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'assistant_delta', text: 42 }).success).toBe(false);
    expect(
      AgentEventSchema.safeParse({ type: 'files_changed', turnIndex: 1, paths: 'a.ts' }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        type: 'turn_finished',
        turnIndex: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: '8000', outputTokens: 900 },
      }).success,
    ).toBe(false);
  });

  test('is rejected when an enum carries a value outside the contract', () => {
    expect(
      AgentEventSchema.safeParse({ ...EVENT_SAMPLES.mode_changed, mode: 'yolo' }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({ ...EVENT_SAMPLES.tool_started, risk: 'nuclear' }).success,
    ).toBe(false);
    /* A risk level the app does not understand must never be treated as safe:
       the whole approval gate keys off this field. */
    expect(
      AgentEventSchema.safeParse({
        type: 'approval_requested',
        request: { ...APPROVAL_REQUEST, risk: 'harmless' },
      }).success,
    ).toBe(false);
  });

  test('is rejected when a nested payload is malformed', () => {
    expect(
      AgentEventSchema.safeParse({ type: 'approval_requested', request: { callId: 'c' } }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        type: 'subagent_update',
        agent: { ...SUBAGENT, usage: { inputTokens: 1 } },
      }).success,
    ).toBe(false);
  });

  test('drops keys the contract does not declare rather than passing them through', () => {
    const result = AgentEventSchema.safeParse({
      type: 'assistant_delta',
      text: 'hi',
      __proto__pollution: 'x',
      extra: 'not in the contract',
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ type: 'assistant_delta', text: 'hi' });
  });

  test('rejects a leaf enum used outside its own domain', () => {
    expect(PermissionModeSchema.safeParse('plan').success).toBe(true);
    expect(PermissionModeSchema.safeParse('safe').success).toBe(false);
    expect(RiskLevelSchema.safeParse('command').success).toBe(true);
    expect(RiskLevelSchema.safeParse('full').success).toBe(false);
    expect(ApprovalDecisionSchema.safeParse('allow_always').success).toBe(true);
    expect(ApprovalDecisionSchema.safeParse('allow-always').success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Optional-property semantics                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `tsconfig.base.json` turns on `exactOptionalPropertyTypes` and says why: the
 * protocol uses *absence* of `agentId` to mean "the root agent", so
 * `{agentId: undefined}` and an absent `agentId` are different statements.
 *
 * The compiler enforces that. Zod does not — `.optional()` in Zod 4 accepts an
 * explicitly-undefined key. These tests pin the actual runtime behaviour so the
 * gap is a documented, tested fact rather than a surprise in a debugging
 * session, and pin the property that main actually depends on: key presence
 * survives validation intact in both directions.
 */
describe('agentId presence, which is what distinguishes the root agent from a subagent', () => {
  const base = { type: 'tool_denied', callId: 'call_9', name: 'shell', reason: 'denied' } as const;

  /**
   * The schema's own output type, not agent-core's `AgentEvent`.
   *
   * They are not interchangeable, and the difference is the subject of this
   * block: `z.infer` of `.optional()` produces `agentId?: string | undefined`,
   * agent-core declares `agentId?: string`, and under
   * `exactOptionalPropertyTypes` a value of the first type is not assignable to
   * the second. Writing `AgentEvent` here is a compile error — worth knowing,
   * because `assertExactly` in `agent-protocol.ts` reports these two types as
   * identical. The invariant-identity trick it uses does not distinguish
   * `?: T` from `?: T | undefined`, so the drift gate does not in fact enforce
   * the exact-optional distinction that `tsconfig.base.json` says it is there
   * for. The runtime assertions below are what actually pin the behaviour.
   */
  type ParsedEvent = z.infer<typeof AgentEventSchema>;

  /** Parse, or fail the test with the schema's own explanation. */
  function parsed(raw: unknown): ParsedEvent {
    const result = AgentEventSchema.safeParse(raw);
    if (!result.success) throw new Error(z.prettifyError(result.error));
    return result.data;
  }

  /**
   * Presence and value, read structurally. `agentId` is declared on some arms of
   * the union and not others, so it cannot be reached through the union type —
   * which is precisely the situation main is in when it attributes an event.
   */
  function agentId(event: ParsedEvent): { present: boolean; value: unknown } {
    const record: Record<string, unknown> = { ...event };
    return { present: Object.hasOwn(record, 'agentId'), value: record['agentId'] };
  }

  test('an absent agentId parses and stays absent', () => {
    expect(agentId(parsed({ ...base }))).toEqual({ present: false, value: undefined });
  });

  test('an explicitly-undefined agentId is accepted at runtime, and keeps its key', () => {
    /* Deliberately weaker than the type system: `exactOptionalPropertyTypes`
       makes this object un-writable in application code, so the only way it can
       reach a schema is off the wire — where JSON cannot produce it either (see
       the next test). Recorded rather than asserted-away: if a future Zod major
       starts rejecting this, that is a behaviour change worth noticing here and
       not in production. */
    expect(agentId(parsed({ ...base, agentId: undefined }))).toEqual({
      present: true,
      value: undefined,
    });
  });

  test('JSON erases the difference, so `in` alone is not a safe root-agent test over the wire', () => {
    const overWire: unknown = JSON.parse(JSON.stringify({ ...base, agentId: undefined }));

    expect(Object.hasOwn(overWire as object, 'agentId')).toBe(false);
    expect(agentId(parsed(overWire))).toEqual({ present: false, value: undefined });
  });

  test('a null agentId is rejected — optional does not mean nullable', () => {
    expect(AgentEventSchema.safeParse({ ...base, agentId: null }).success).toBe(false);
  });

  test('an empty-string agentId is accepted, so it must never be used as a sentinel', () => {
    /* Not an endorsement: the contract says `string`, so `''` is a valid
       agentId. Anything reading `event.agentId ||` instead of `??`/`in` would
       misattribute such an event to the root agent. Asserted so that a future
       tightening to `.min(1)` is a deliberate, visible contract change. */
    expect(agentId(parsed({ ...base, agentId: '' }))).toEqual({ present: true, value: '' });
  });

  test('optional fields elsewhere behave the same way', () => {
    const withoutSubagentUsage = AgentEventSchema.safeParse({
      type: 'turn_finished',
      turnIndex: 1,
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(withoutSubagentUsage.success).toBe(true);
    expect(
      withoutSubagentUsage.success && Object.hasOwn(withoutSubagentUsage.data, 'subagentUsage'),
    ).toBe(false);

    expect(ApprovalRequestSchema.safeParse({ ...APPROVAL_REQUEST, agentId: null }).success).toBe(
      false,
    );
    expect(
      SubagentSnapshotSchema.safeParse({ ...SUBAGENT, filesChanged: 'src/a.ts' }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Sidecar framing                                                             */
/* -------------------------------------------------------------------------- */

describe('parseSidecarMessage', () => {
  test('accepts every declared sidecar message', () => {
    const messages: z.infer<typeof SidecarMessageSchema>[] = [
      { type: 'event', event: EVENT_SAMPLES.assistant_message },
      { type: 'diff', patch: '--- a\n+++ b\n' },
      { type: 'undo_result', restored: ['src/main/security.ts'] },
      {
        type: 'sessions',
        sessions: [
          {
            id: 'sess_1',
            title: 'Harden the preload bridge',
            cwd: '/Users/x/juno',
            provider: 'anthropic',
            model: 'claude-opus-5',
            mode: 'ask',
            createdAt: '2026-08-12T09:00:00.000Z',
            updatedAt: '2026-08-12T09:30:00.000Z',
            turnCount: 4,
          },
        ],
      },
      { type: 'protocol_error', message: 'unrecognised command' },
    ];

    for (const message of messages) {
      const result = parseSidecarMessage(message);
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      expect(result.ok && result.message).toEqual(message);
    }
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a raw string', 'event'],
    ['a number', 0],
    ['an array', []],
    ['an empty object', {}],
    ['an unknown frame type', { type: 'shutdown' }],
    ['an event frame with no event', { type: 'event' }],
    ['an event frame wrapping a bogus event', { type: 'event', event: { type: 'nope' } }],
    ['a diff frame with a non-string patch', { type: 'diff', patch: 12 }],
    ['an undo_result with a non-array', { type: 'undo_result', restored: 'a.ts' }],
    ['a sessions frame with a malformed session', { type: 'sessions', sessions: [{ id: 's' }] }],
  ])('returns ok:false rather than throwing for %s', (_label, raw) => {
    /* The contract that matters: one bad frame on a long-lived stream must not
       tear down the session. Anything that throws here would propagate into the
       socket's data handler. */
    expect(() => parseSidecarMessage(raw)).not.toThrow();

    const result = parseSidecarMessage(raw);
    expect(result.ok).toBe(false);
    expect(result.ok === false && typeof result.error).toBe('string');
    expect(result.ok === false && result.error.length).toBeGreaterThan(0);
  });

  test('the error is readable enough to act on', () => {
    const result = parseSidecarMessage({ type: 'diff', patch: 12 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    /* `z.prettifyError` output names the offending path and what was expected.
       An error that said only "invalid input" would send whoever is on call
       reading the sidecar source instead of the log line. */
    expect(result.error).toMatch(/patch/);
    expect(result.error).toMatch(/expected string/i);
    expect(result.error).not.toMatch(/^\[object Object\]$/);
  });

  test('the error does not echo the offending payload, which may hold prompt text', () => {
    /* The caller logs this string. Agent traffic carries user prompts and file
       contents, so the message must describe the shape, not reproduce it. */
    const result = parseSidecarMessage({
      type: 'assistant_message',
      text: 'ssh-key AAAAB3NzaC1yc2ESECRETMATERIAL',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toMatch(/SECRETMATERIAL/);
  });
});

describe('SidecarCommandSchema', () => {
  test('accepts every declared command', () => {
    const commands: z.infer<typeof SidecarCommandSchema>[] = [
      { type: 'start', cwd: '/Users/x/juno' },
      { type: 'start', cwd: '/Users/x/juno', model: 'claude-opus-5', mode: 'plan' },
      { type: 'resume', sessionId: 'sess_1' },
      { type: 'prompt', text: 'harden the preload bridge' },
      { type: 'approval', callId: 'call_7', decision: 'deny' },
      { type: 'set_mode', mode: 'full' },
      { type: 'undo' },
      { type: 'diff' },
      { type: 'diff', sinceTurn: 2 },
      { type: 'list_sessions' },
      { type: 'abort' },
    ];

    for (const command of commands) {
      const result = SidecarCommandSchema.safeParse(command);
      expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
    }
  });

  test('rejects a command the sidecar does not implement', () => {
    expect(SidecarCommandSchema.safeParse({ type: 'exec', command: 'sh' }).success).toBe(false);
    expect(SidecarCommandSchema.safeParse({ type: 'start' }).success).toBe(false);
    expect(SidecarCommandSchema.safeParse({ type: 'set_mode', mode: 'root' }).success).toBe(false);
    expect(SidecarCommandSchema.safeParse({ type: 'diff', sinceTurn: '2' }).success).toBe(false);
  });
});

describe('SessionMetaSchema', () => {
  test('rejects a session whose mode is not a permission mode', () => {
    expect(
      SessionMetaSchema.safeParse({
        id: 's',
        title: 't',
        cwd: '/tmp',
        provider: 'anthropic',
        model: 'm',
        mode: 'readonly',
        createdAt: 'now',
        updatedAt: 'now',
        turnCount: 0,
      }).success,
    ).toBe(false);
  });
});
