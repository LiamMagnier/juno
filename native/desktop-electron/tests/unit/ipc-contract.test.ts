/**
 * The IPC capability contract.
 *
 * `src/shared/ipc.ts` says what this file has to prove: the channel names in
 * `channels.ts` and the schemas in `ipc.ts` are two hand-maintained lists that
 * must stay identical, and a `satisfies` clause enforces that at compile time.
 * A compile-time gate is the right primary control, but it is one `as any` or
 * one misconfigured `paths` entry away from being inert — which is not
 * hypothetical here; the sibling drift gate in `agent-protocol.ts` spent this
 * workspace's first week passing vacuously for exactly that reason. So the same
 * invariant is asserted here at runtime, where nothing can erase it.
 *
 * The second half of the file is the part a name-matching test cannot cover: a
 * schema can be present, correctly named, and still validate nothing. Every
 * channel therefore has to parse a realistic payload and reject a wrong one.
 */

import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  EVENT_CHANNELS,
  EVENT_CHANNEL_NAMES,
  INVOKE_CHANNELS,
  INVOKE_CHANNEL_NAMES,
  type EventChannel,
  type InvokeChannel,
} from '@shared/ipc';

const invokeNames: readonly string[] = INVOKE_CHANNEL_NAMES;
const eventNames: readonly string[] = EVENT_CHANNEL_NAMES;

/* Widened to the base schema type so a channel name held in a variable can be
   used to look one up. `ipc.ts` already constrains both tables to `z.ZodType`. */
const requestSchema = (name: InvokeChannel): z.ZodType => INVOKE_CHANNELS[name].request;
const responseSchema = (name: InvokeChannel): z.ZodType => INVOKE_CHANNELS[name].response;
const eventSchema = (name: EventChannel): z.ZodType => EVENT_CHANNELS[name];

const INVOKE_CHANNEL_LIST = [...INVOKE_CHANNEL_NAMES];
const EVENT_CHANNEL_LIST = [...EVENT_CHANNEL_NAMES];

/* -------------------------------------------------------------------------- */
/* Name/schema correspondence                                                  */
/* -------------------------------------------------------------------------- */

describe('INVOKE_CHANNEL_NAMES and INVOKE_CHANNELS', () => {
  test('every declared name has a schema entry', () => {
    const orphanNames = invokeNames.filter((name) => !Object.hasOwn(INVOKE_CHANNELS, name));

    expect(
      orphanNames,
      'declared in channels.ts with no request/response schema in ipc.ts — the preload bridge would expose an unvalidated channel',
    ).toEqual([]);
  });

  test('every schema entry has a declared name', () => {
    const orphanSchemas = Object.keys(INVOKE_CHANNELS).filter((key) => !invokeNames.includes(key));

    expect(
      orphanSchemas,
      'a schema in ipc.ts for a channel channels.ts never declares — unreachable from the renderer, so it is dead code or a missing name',
    ).toEqual([]);
  });

  test('the two lists are the same size, so neither hides a duplicate', () => {
    expect(new Set(invokeNames).size).toBe(invokeNames.length);
    expect(invokeNames.length).toBe(Object.keys(INVOKE_CHANNELS).length);
  });

  test('every entry declares both a request and a response schema', () => {
    for (const name of invokeNames) {
      const entry = INVOKE_CHANNELS[name as InvokeChannel];
      expect(entry.request, `${name} has no request schema`).toBeInstanceOf(z.ZodType);
      expect(entry.response, `${name} has no response schema`).toBeInstanceOf(z.ZodType);
    }
  });
});

describe('EVENT_CHANNEL_NAMES and EVENT_CHANNELS', () => {
  test('every declared name has a schema entry', () => {
    const orphanNames = eventNames.filter((name) => !Object.hasOwn(EVENT_CHANNELS, name));
    expect(orphanNames, 'declared in channels.ts with no payload schema in ipc.ts').toEqual([]);
  });

  test('every schema entry has a declared name', () => {
    const orphanSchemas = Object.keys(EVENT_CHANNELS).filter((key) => !eventNames.includes(key));
    expect(orphanSchemas, 'a payload schema for an undeclared event channel').toEqual([]);
  });

  test('the two lists are the same size, so neither hides a duplicate', () => {
    expect(new Set(eventNames).size).toBe(eventNames.length);
    expect(eventNames.length).toBe(Object.keys(EVENT_CHANNELS).length);
  });

  test('every entry is a schema', () => {
    for (const name of eventNames) {
      expect(EVENT_CHANNELS[name as EventChannel], `${name} is not a schema`).toBeInstanceOf(
        z.ZodType,
      );
    }
  });
});

describe('the channel namespace as a whole', () => {
  test('no name is both an invoke channel and an event channel', () => {
    /* Preload dispatches on the name. A name in both tables would make
       `invoke('code:event')` and `on('code:event')` two different contracts
       reachable through one string. */
    const collisions = invokeNames.filter((name) => eventNames.includes(name));
    expect(collisions).toEqual([]);
  });

  test('every name follows the namespace:verb convention', () => {
    for (const name of [...invokeNames, ...eventNames]) {
      expect(name, `${name} is not namespace:verb in kebab-case`).toMatch(
        /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/,
      );
    }
  });

  test('the surface stays small enough to review in one sitting', () => {
    /* Not a style rule. Every entry here is a capability handed to a process
       that `THREAT_MODEL.md` treats as compromisable; the number is meant to be
       uncomfortable to increase.

       It was 30. Merging the Chat, Work and Terminal contracts took it to 65 in
       one move — three products' worth of surface arriving at once. The ceiling
       is raised to the new total rather than to a round number above it, so the
       next channel is still a deliberate edit to this line. */
    expect(invokeNames.length + eventNames.length).toBeLessThanOrEqual(65);
  });
});

/* -------------------------------------------------------------------------- */
/* Payload samples                                                             */
/* -------------------------------------------------------------------------- */

interface InvokeSample {
  /** A payload main must accept. */
  readonly validRequest: unknown;
  /** A payload main must reject — a real mistake, not `Symbol()`. */
  readonly invalidRequest: unknown;
  readonly validResponse: unknown;
  readonly invalidResponse: unknown;
}

const APP_INFO = {
  version: '0.1.0',
  electronVersion: '43.4.0',
  chromeVersion: '140.0.0.0',
  nodeVersion: '22.20.0',
  platform: 'darwin',
  arch: 'arm64',
  isPackaged: true,
  contractVersion: '1.0.1',
};

const APPEARANCE = {
  shouldUseDarkColors: true,
  reduceMotion: false,
  reduceTransparency: false,
  increaseContrast: false,
  accentColor: '#4F46E5',
};

const WORKSPACE = {
  id: 'ws_1',
  path: '/Users/x/juno',
  name: 'juno',
  trusted: false,
  isGitRepository: true,
  branch: 'main',
  lastOpenedAt: '2026-08-12T09:00:00.000Z',
};

const DIAGNOSTICS = {
  appVersion: '0.1.0',
  contractVersion: '1.0.1',
  backendReachable: true,
  backendOrigin: 'https://chat.liams.dev',
  authStatus: 'signed-in',
  syncCursor: null,
  outboxDepth: 0,
  agentHostStatus: 'running',
  agentHostRestarts: 0,
  databaseHealthy: true,
};

/* Chat ---------------------------------------------------------------------- */

const CONVERSATION = {
  id: 'conv_1',
  title: 'Hardening the preload bridge',
  titleSource: 'ai',
  model: 'anthropic:claude-opus-5',
  pinned: false,
  archivedAt: null,
  lastMessageAt: '2026-08-12T09:14:00.000Z',
  createdAt: '2026-08-12T09:00:00.000Z',
  preview: 'The bridge is generated from the table, so…',
  messageCount: 12,
};

const MESSAGE = {
  id: 'msg_1',
  /* Uppercase because that is what the API returns. */
  role: 'ASSISTANT',
  content: 'Preload holds names, not schemas — that is why it builds to 1.4 kB.',
  reasoning: null,
  reasoningParts: null,
  reasoningEffort: 'high',
  model: 'anthropic:claude-opus-5',
  createdAt: '2026-08-12T09:14:00.000Z',
  attachments: [],
  sources: [],
  usage: { promptTokens: 812, completionTokens: 96, costUsd: 0.021 },
  finishReason: 'stop',
  errorMessage: null,
};

const ATTACHMENT = {
  id: 'att_1',
  kind: 'IMAGE',
  fileName: 'diagram.png',
  mimeType: 'image/png',
  size: 20_480,
  /* A `data:` URI rather than a CDN URL — `img-src` is as locked down as
     `connect-src`, so this is what main can actually hand the renderer. */
  url: 'data:image/png;base64,iVBORw0KGgo=',
  width: 1024,
  height: 640,
};

const MODEL_DESCRIPTOR = {
  id: 'anthropic:claude-opus-5',
  name: 'Claude Opus 5',
  provider: 'anthropic',
  vision: true,
  reasoningTiers: ['low', 'medium', 'high', 'max'],
  canDisableReasoning: false,
  contextWindow: 200_000,
  lockedReason: null,
  deprecationNote: null,
};

/* Work ---------------------------------------------------------------------- */

const WORK_BUDGET = { maxCostMicroUsd: 500_000, maxTokens: 200_000, maxRuntimeMs: 900_000 };

const WORK_USAGE = {
  costMicroUsd: 41_200,
  tokens: 18_412,
  runtimeMs: 92_000,
  inputTokens: 16_000,
  outputTokens: 2_412,
};

const WORK_GRANT = {
  id: 'wgrant_1',
  kind: 'local_folder',
  /* Grant-relative. Never an absolute path — this reaches a phone. */
  label: 'juno',
  accessMode: 'read_write_no_delete',
  createdAt: '2026-08-12T09:00:00.000Z',
};

const WORK_CONNECTOR = {
  id: 'wconn_1',
  name: 'Mail',
  provider: 'google',
  healthy: true,
  unhealthyReason: null,
  scopes: ['mail.readonly', 'mail.send'],
};

const WORK_SKILL = {
  slug: 'review-contract',
  name: 'Review a contract',
  summary: 'Reads a contract against the negotiation playbook.',
  version: '1.2.0',
  capabilities: ['cloud_files', 'deliverables'],
};

const WORK_HOST = {
  id: 'whost_1',
  name: 'Studio Mac',
  state: 'idle',
  lastSeenAt: '2026-08-12T09:13:00.000Z',
  capabilities: ['local_files', 'local_shell'],
  /* A Mac may narrow the policy further; it may never widen it. */
  maxPermissionPolicy: 'balanced',
};

const WORK_SESSION = {
  id: 'wsess_1',
  title: 'Audit the IPC surface',
  goal: 'List every channel added since 1.0.1 and say what each one grants.',
  status: 'waiting_approval',
  target: 'automatic',
  permissionPolicy: 'balanced',
  model: 'anthropic:claude-opus-5',
  sensitivity: 'internal',
  createdAt: '2026-08-12T09:00:00.000Z',
  updatedAt: '2026-08-12T09:14:00.000Z',
  attempts: 2,
  pinned: false,
  archived: false,
  latestRunId: 'wrun_1',
  grants: [WORK_GRANT],
  connectors: [WORK_CONNECTOR],
  skill: WORK_SKILL,
  conversationId: null,
};

const WORK_RUN = {
  id: 'wrun_1',
  sessionId: 'wsess_1',
  attempt: 2,
  status: 'waiting_approval',
  /* The *resolved* target: `automatic` never survives dispatch. */
  target: 'local',
  hostId: 'whost_1',
  model: 'anthropic:claude-opus-5',
  permissionPolicy: 'balanced',
  startedAt: '2026-08-12T09:10:00.000Z',
  endedAt: null,
  terminalReason: null,
  terminalDetail: null,
  usage: WORK_USAGE,
  budget: WORK_BUDGET,
  lastSeq: 41,
};

const WORK_APPROVAL = {
  id: 'wappr_1',
  callId: 'call_7',
  action: 'work.connector.send_message',
  tool: 'mail.send',
  risk: 'sensitive',
  summary: 'Send the audit summary to the security list.',
  detail: { to: 'security@example.com', subject: 'IPC audit' },
  digestInput: 'mail.send\nsecurity@example.com\nIPC audit',
  actionDigest: 'sha256:6f1c2d3e4a5b4c6d8e7f0a1b2c3d4e5f',
  policyDigest: 'sha256:9ab3c1d2e3f405162738495a6b7c8d9e',
  expiresAt: '2026-08-12T09:20:00.000Z',
  decision: 'pending',
  decidedAt: null,
};

const WORK_QUESTION = {
  id: 'wq_1',
  question: 'Which list should the summary go to?',
  /* Why the run cannot proceed without it. The user is owed this. */
  why: 'Two addresses are configured, and sending to the wrong one cannot be taken back.',
  options: ['security@example.com', 'eng@example.com'],
};

const WORK_TASK_SUMMARY = {
  id: 'wsess_1',
  title: 'Audit the IPC surface',
  goal: 'List every channel added since 1.0.1 and say what each one grants.',
  status: 'waiting_approval',
  updatedAt: '2026-08-12T09:14:00.000Z',
  attempts: 2,
  pinned: false,
  archived: false,
  needsAttention: true,
  openRequestSummary: 'Send the audit summary to the security list.',
};

/* `seq`/`at` come from the intersection the log is declared as, so a sample that
   omits them proves nothing about the envelope the reducer resumes from. */
const WORK_SNAPSHOT = {
  session: WORK_SESSION,
  run: WORK_RUN,
  events: [
    {
      kind: 'run_started',
      runId: 'wrun_1',
      goal: 'List every channel added since 1.0.1 and say what each one grants.',
      model: 'anthropic:claude-opus-5',
      seq: 1,
      at: '2026-08-12T09:10:00.000Z',
    },
    {
      kind: 'approval_requested',
      request: WORK_APPROVAL,
      seq: 41,
      at: '2026-08-12T09:14:00.000Z',
    },
  ],
  replaced: false,
  approvals: [WORK_APPROVAL],
  questions: [WORK_QUESTION],
  fetchedAt: '2026-08-12T09:14:02.000Z',
};

const WORK_POLL_STATE = {
  sessionId: 'wsess_1',
  phase: 'ok',
  intervalMs: 4_000,
  lastSucceededAt: '2026-08-12T09:14:02.000Z',
  lastAttemptedAt: '2026-08-12T09:14:02.000Z',
  nextAttemptAt: '2026-08-12T09:14:06.000Z',
  consecutiveFailures: 0,
  online: true,
  error: null,
  cursorSeq: 41,
};

const WORK_CAPABILITIES_SNAPSHOT = {
  connectors: [WORK_CONNECTOR],
  skills: [WORK_SKILL],
  hosts: [WORK_HOST],
  cloudCapabilities: ['web_research', 'connectors', 'deliverables'],
  defaultBudget: WORK_BUDGET,
  models: [{ id: 'anthropic:claude-opus-5', label: 'Claude Opus 5', available: true }],
  fetchedAt: '2026-08-12T09:14:02.000Z',
};

const WORK_AUDIT_ENTRY = {
  id: 'waudit_1',
  at: '2026-08-12T09:14:01.000Z',
  kind: 'approval_replay_refused',
  severity: 'refusal',
  actor: 'macos',
  runId: 'wrun_1',
  /* Scalars only: audit detail is restricted at the writer and again in the schema. */
  detail: { approvalId: 'wappr_1', attempts: 2, standing: false },
};

/* Terminal ------------------------------------------------------------------- */

/** `term_` + a lowercase v4 UUID. Anything else fails at the router. */
const TERMINAL_ID = 'term_9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

const TERMINAL = {
  id: TERMINAL_ID,
  workspaceId: 'ws_1',
  title: 'zsh',
  cwd: '/Users/x/juno',
  shell: '/bin/zsh',
  pid: 4242,
  cols: 120,
  rows: 40,
  status: 'running',
  exitCode: null,
  signal: null,
  createdAt: '2026-08-12T09:00:00.000Z',
  historyChars: 2_048,
};

/** A channel that takes no argument: `undefined` in, anything else rejected. */
const NO_REQUEST = { validRequest: undefined, invalidRequest: {} } as const;
/** `{ ok: true }`, where `true` is a literal — a handler cannot report failure as success. */
const OK_RESPONSE = { validResponse: { ok: true }, invalidResponse: { ok: false } } as const;

/**
 * One sample set per channel. Typed as a total `Record<InvokeChannel, …>`, so a
 * channel added to `channels.ts` without a sample here is a type error, and the
 * runtime totality test below catches it even while the tsconfig is broken.
 */
const INVOKE_SAMPLES: Record<InvokeChannel, InvokeSample> = {
  'app:info': {
    ...NO_REQUEST,
    validResponse: APP_INFO,
    /* `contractVersion` missing: the field the app uses to refuse to talk to a
       backend it was not compiled against. */
    invalidResponse: { ...APP_INFO, contractVersion: undefined },
  },
  'app:appearance': {
    ...NO_REQUEST,
    validResponse: { ...APPEARANCE, accentColor: null },
    invalidResponse: { ...APPEARANCE, accentColor: 0x4f46e5 },
  },
  'app:set-appearance': {
    validRequest: { appearance: 'dark' },
    invalidRequest: { appearance: 'sepia' },
    ...OK_RESPONSE,
  },
  'window:minimize': { ...NO_REQUEST, ...OK_RESPONSE },
  'window:toggle-maximize': { ...NO_REQUEST, ...OK_RESPONSE },
  'window:toggle-fullscreen': { ...NO_REQUEST, ...OK_RESPONSE },
  'auth:state': {
    ...NO_REQUEST,
    validResponse: {
      status: 'signed-in',
      accountId: 'acc_1',
      email: 'robin@example.com',
      displayName: null,
      deviceId: 'dev_1',
    },
    /* A `signed-in` state with no identity attached. The union must not let a
       half-populated success through. */
    invalidResponse: { status: 'signed-in' },
  },
  'auth:begin-sign-in': { ...NO_REQUEST, ...OK_RESPONSE },
  'auth:sign-out': { ...NO_REQUEST, ...OK_RESPONSE },
  'workspace:list': {
    ...NO_REQUEST,
    validResponse: [WORKSPACE],
    invalidResponse: [{ id: 'ws_1', path: '/Users/x/juno' }],
  },
  'workspace:choose': {
    ...NO_REQUEST,
    /* Null is the cancel case and must stay valid. */
    validResponse: null,
    invalidResponse: { id: 'ws_1' },
  },
  'workspace:set-trust': {
    validRequest: { workspaceId: 'ws_1', trusted: true },
    /* A string "yes" must not coerce to trust. */
    invalidRequest: { workspaceId: 'ws_1', trusted: 'yes' },
    validResponse: { ...WORKSPACE, trusted: true },
    invalidResponse: { ...WORKSPACE, trusted: 'yes' },
  },
  'code:start-session': {
    validRequest: { workspaceId: 'ws_1', model: 'claude-opus-5', mode: 'plan' },
    /* A permission mode outside the contract would be a mode nothing enforces. */
    invalidRequest: { workspaceId: 'ws_1', mode: 'full-auto' },
    validResponse: { sessionId: 'sess_1' },
    invalidResponse: { sessionId: 1 },
  },
  'code:prompt': {
    validRequest: { sessionId: 'sess_1', text: 'harden the preload bridge' },
    invalidRequest: { sessionId: 'sess_1' },
    ...OK_RESPONSE,
  },
  'code:resolve-approval': {
    validRequest: { sessionId: 'sess_1', callId: 'call_7', decision: 'allow_always' },
    /* The renderer must not be able to invent a decision the approval gate has
       no branch for. */
    invalidRequest: { sessionId: 'sess_1', callId: 'call_7', decision: 'maybe' },
    ...OK_RESPONSE,
  },
  'code:set-mode': {
    validRequest: { sessionId: 'sess_1', mode: 'auto-edit' },
    invalidRequest: { sessionId: 'sess_1', mode: 'root' },
    ...OK_RESPONSE,
  },
  'code:abort': {
    validRequest: { sessionId: 'sess_1' },
    invalidRequest: {},
    ...OK_RESPONSE,
  },
  'diagnostics:snapshot': {
    ...NO_REQUEST,
    validResponse: DIAGNOSTICS,
    invalidResponse: { ...DIAGNOSTICS, agentHostStatus: 'confused' },
  },

  /* Chat -------------------------------------------------------------------- */

  'chat:list-conversations': {
    validRequest: { query: 'preload', includeArchived: true, limit: 50 },
    /* Past the 200-row cap the route was written against. */
    invalidRequest: { query: 'preload', limit: 500 },
    validResponse: { conversations: [CONVERSATION] },
    /* `titleSource` is a closed set: the renderer decides whether the title may
       be overwritten by an AI retitle from exactly this field. */
    invalidResponse: { conversations: [{ ...CONVERSATION, titleSource: 'generated' }] },
  },
  'chat:get-conversation': {
    validRequest: { conversationId: 'conv_1' },
    invalidRequest: { conversationId: null },
    validResponse: { conversation: CONVERSATION, messages: [MESSAGE], generating: true },
    /* Lowercase roles are the web's own trap: the API returns `ASSISTANT`, and a
       transcript that silently accepts `assistant` renders nothing. */
    invalidResponse: {
      conversation: CONVERSATION,
      messages: [{ ...MESSAGE, role: 'assistant' }],
    },
  },
  'chat:create-conversation': {
    /* Both fields default, so the empty object is the *valid* case here. */
    validRequest: {},
    invalidRequest: { model: 42 },
    validResponse: { conversation: CONVERSATION },
    invalidResponse: { conversation: { ...CONVERSATION, messageCount: 'twelve' } },
  },
  'chat:update-conversation': {
    validRequest: { conversationId: 'conv_1', pinned: true, archived: false },
    /* Titles are capped at 200; a pasted document must not become one. */
    invalidRequest: { conversationId: 'conv_1', title: 'x'.repeat(201) },
    validResponse: { conversation: { ...CONVERSATION, pinned: true } },
    /* `archivedAt` is an ISO timestamp or null — never a boolean flag. */
    invalidResponse: { conversation: { ...CONVERSATION, archivedAt: true } },
  },
  'chat:delete-conversation': {
    validRequest: { conversationId: 'conv_1' },
    invalidRequest: { conversationId: ['conv_1', 'conv_2'] },
    ...OK_RESPONSE,
  },
  'chat:send': {
    validRequest: {
      conversationId: null,
      clientMessageId: 'cm_1',
      text: 'Summarise the threat model.',
      attachmentIds: ['att_1'],
      model: 'anthropic:claude-opus-5',
      reasoningEffort: 'high',
    },
    /* Eleven attachments: the cap main applies in `chat:pick-attachments` has to
       hold on the send path too, or it is not a cap. */
    invalidRequest: {
      conversationId: null,
      clientMessageId: 'cm_1',
      text: 'Summarise the threat model.',
      attachmentIds: Array.from({ length: 11 }, (_, index) => `att_${index}`),
      model: 'anthropic:claude-opus-5',
      reasoningEffort: null,
    },
    validResponse: { conversationId: 'conv_1', assistantMessageId: 'msg_2' },
    /* Without the assistant id the renderer cannot match the stream to a row. */
    invalidResponse: { conversationId: 'conv_1' },
  },
  'chat:stop': {
    validRequest: { conversationId: 'conv_1' },
    invalidRequest: { conversationId: 42 },
    ...OK_RESPONSE,
  },
  'chat:retry': {
    validRequest: {
      conversationId: 'conv_1',
      messageId: 'msg_2',
      model: 'anthropic:claude-sonnet-5',
      reasoningEffort: null,
    },
    /* Six depths, and `extreme` is not one of them. */
    invalidRequest: { conversationId: 'conv_1', messageId: 'msg_2', reasoningEffort: 'extreme' },
    validResponse: { assistantMessageId: 'msg_3' },
    invalidResponse: { assistantMessageId: null },
  },
  'chat:edit-message': {
    validRequest: { conversationId: 'conv_1', messageId: 'msg_1', text: 'Rephrased.' },
    /* Null is not empty text: the server snapshots the prior wording and needs
       something to replace it with. */
    invalidRequest: { conversationId: 'conv_1', messageId: 'msg_1', text: null },
    validResponse: { assistantMessageId: 'msg_4' },
    invalidResponse: { assistantMessageId: 4 },
  },
  'chat:fork': {
    validRequest: { conversationId: 'conv_1', messageId: 'msg_2' },
    /* A fork with no branch point is a copy, which is a different operation. */
    invalidRequest: { conversationId: 'conv_1' },
    validResponse: { conversation: { ...CONVERSATION, id: 'conv_2' } },
    /* Epoch milliseconds where the contract says ISO string. */
    invalidResponse: { conversation: { ...CONVERSATION, lastMessageAt: 1_755_000_000_000 } },
  },
  'chat:models': {
    ...NO_REQUEST,
    validResponse: { models: [MODEL_DESCRIPTOR], defaultModel: 'anthropic:claude-opus-5' },
    /* The picker builds its effort ladder from `reasoningTiers`; a tier outside
       the vocabulary is a control that sends a value nothing accepts. */
    invalidResponse: {
      models: [{ ...MODEL_DESCRIPTOR, reasoningTiers: ['low', 'ludicrous'] }],
      defaultModel: 'anthropic:claude-opus-5',
    },
  },
  'chat:pick-attachments': {
    validRequest: { conversationId: 'conv_1', accept: 'image' },
    /* `accept` selects the dialog's filter in main; `video` is not a filter it has. */
    invalidRequest: { conversationId: 'conv_1', accept: 'video' },
    validResponse: { attachments: [ATTACHMENT] },
    invalidResponse: { attachments: [{ ...ATTACHMENT, kind: 'PDF' }] },
  },
  'chat:receive-dropped-files': {
    validRequest: {
      conversationId: 'conv_1',
      files: [
        { fileName: 'diagram.png', mimeType: 'image/png', size: 20_480, data: 'iVBORw0KGgo=' },
      ],
    },
    /* A 600-character name is over the 512 cap — the one field on this channel
       that a hostile filesystem gets to choose. */
    invalidRequest: {
      conversationId: 'conv_1',
      files: [
        { fileName: 'a'.repeat(600), mimeType: 'image/png', size: 20_480, data: 'iVBORw0KGgo=' },
      ],
    },
    validResponse: {
      attachments: [ATTACHMENT],
      rejected: [{ fileName: 'archive.zip', reason: 'Type not allowed' }],
    },
    /* A refusal with no reason is the thing this field exists to prevent. */
    invalidResponse: { attachments: [], rejected: [{ fileName: 'archive.zip' }] },
  },
  'chat:open-external': {
    validRequest: { url: 'https://juno.example/docs/ipc' },
    /* Over the 2048 cap. Length is checked before the scheme allowlist in main. */
    invalidRequest: { url: `https://juno.example/?q=${'a'.repeat(2_048)}` },
    ...OK_RESPONSE,
  },

  /* Work -------------------------------------------------------------------- */

  'work:list-tasks': {
    validRequest: { filter: 'needs-attention', limit: 25 },
    /* Zero rows is not a smaller page, it is a call with no answer. */
    invalidRequest: { filter: 'all', limit: 0 },
    validResponse: { tasks: [WORK_TASK_SUMMARY], fetchedAt: '2026-08-12T09:14:02.000Z' },
    /* `stopping` is Chat's vocabulary, not Work's. */
    invalidResponse: {
      tasks: [{ ...WORK_TASK_SUMMARY, status: 'stopping' }],
      fetchedAt: '2026-08-12T09:14:02.000Z',
    },
  },
  'work:task-snapshot': {
    validRequest: { sessionId: 'wsess_1', sinceSeq: 12 },
    /* The cursor is a number. A string that looks like one must not coerce. */
    invalidRequest: { sessionId: 'wsess_1', sinceSeq: '12' },
    validResponse: WORK_SNAPSHOT,
    /* `automatic` is a request, not a result: it never survives dispatch, and a
       run that still claims it is a run nobody can say where it executed. */
    invalidResponse: { ...WORK_SNAPSHOT, run: { ...WORK_RUN, target: 'automatic' } },
  },
  'work:watch-task': {
    /* Null is the detach case and must stay valid. */
    validRequest: { sessionId: null },
    /* Detaching is said, never implied by omission — the poller is a resource
       with a lifetime and exactly one session at a time. */
    invalidRequest: {},
    validResponse: WORK_POLL_STATE,
    /* `stale` is a host state; the poller's own phases are a different five. */
    invalidResponse: { ...WORK_POLL_STATE, phase: 'stale' },
  },
  'work:poll-now': {
    validRequest: { sessionId: 'wsess_1' },
    /* Unlike `watch-task`, there is no "poll nothing". */
    invalidRequest: { sessionId: null },
    validResponse: { ...WORK_POLL_STATE, phase: 'polling' },
    invalidResponse: { ...WORK_POLL_STATE, online: 'yes' },
  },
  'work:create-task': {
    validRequest: {
      goal: 'Audit the IPC surface and report what each channel grants.',
      title: 'Audit the IPC surface',
      target: 'automatic',
      permissionPolicy: 'balanced',
      model: null,
      connectorIds: ['wconn_1'],
      grantTokens: ['grant_tok_1'],
      skillSlug: null,
    },
    /* An empty goal. Goal is fixed at dispatch and there is no edit channel, so
       an empty one is a task that can never be given a purpose. */
    invalidRequest: {
      goal: '',
      target: 'cloud',
      permissionPolicy: 'balanced',
      model: null,
      connectorIds: [],
      grantTokens: [],
      skillSlug: null,
    },
    validResponse: { sessionId: 'wsess_1' },
    invalidResponse: { sessionId: null },
  },
  'work:dispatch-run': {
    validRequest: { sessionId: 'wsess_1', target: 'local', permissionPolicy: 'conservative' },
    /* Three policies, narrowest first. `yolo` is not a fourth. */
    invalidRequest: { sessionId: 'wsess_1', permissionPolicy: 'yolo' },
    validResponse: { runId: 'wrun_1', attempt: 2 },
    /* Without the attempt number the UI cannot tell a retry from the first run. */
    invalidResponse: { runId: 'wrun_1' },
  },
  'work:control-run': {
    validRequest: { runId: 'wrun_1', action: 'cancel' },
    /* `restart` is a dispatch, not a control action — the route has no branch. */
    invalidRequest: { runId: 'wrun_1', action: 'restart' },
    validResponse: { ok: true, status: 'cancelled' },
    invalidResponse: { ok: true, status: 'stopping' },
  },
  'work:answer': {
    /* `questionId: null` is the steering case, not an omission. */
    validRequest: { sessionId: 'wsess_1', questionId: null, text: 'Use the staging bucket.' },
    invalidRequest: { sessionId: 'wsess_1', questionId: null, text: '' },
    validResponse: { ok: false, reason: 'not_live' },
    /* A refusal wearing the success tag: `ok: true` selects the branch that
       carries `kind`, so a `reason` here would arrive as an accepted answer. */
    invalidResponse: { ok: true, reason: 'not_live' },
  },
  'work:resolve-approval': {
    validRequest: {
      approvalId: 'wappr_1',
      decision: 'allowed_always',
      actionDigest: WORK_APPROVAL.actionDigest,
    },
    /* `pending` is a state the row passes through, never something a person
       says — it is in the decision vocabulary but not in the answer one. */
    invalidRequest: {
      approvalId: 'wappr_1',
      decision: 'pending',
      actionDigest: WORK_APPROVAL.actionDigest,
    },
    validResponse: {
      ok: false,
      refusal: 'digest_mismatch',
      detail: 'The action changed after the card was drawn.',
    },
    /* Five named refusals, each with its own sentence and its own next move. An
       unnamed one would render as a generic error and a repeated button press. */
    invalidResponse: { ok: false, refusal: 'user_cancelled', detail: 'Cancelled.' },
  },
  'work:audit-trail': {
    validRequest: { sessionId: 'wsess_1', limit: 100 },
    invalidRequest: { sessionId: 'wsess_1', limit: 501 },
    validResponse: { entries: [WORK_AUDIT_ENTRY], fetchedAt: '2026-08-12T09:14:02.000Z' },
    /* Audit detail is scalars only. A nested bag is how attacker-authored text
       gets into the security log by the back door. */
    invalidResponse: {
      entries: [{ ...WORK_AUDIT_ENTRY, detail: { payload: { nested: true } } }],
      fetchedAt: '2026-08-12T09:14:02.000Z',
    },
  },
  'work:capabilities': {
    ...NO_REQUEST,
    validResponse: WORK_CAPABILITIES_SNAPSHOT,
    /* A Mac may narrow the policy; it may never widen it, and `unrestricted` is
       not a policy at all. */
    invalidResponse: {
      ...WORK_CAPABILITIES_SNAPSHOT,
      hosts: [{ ...WORK_HOST, maxPermissionPolicy: 'unrestricted' }],
    },
  },
  'work:choose-grant': {
    validRequest: { kind: 'local_folder', accessMode: 'read_write_no_delete' },
    /* `connector_scope` is a real grant kind but not one a native file dialog
       can produce, so this channel's enum is deliberately narrower. */
    invalidRequest: { kind: 'connector_scope', accessMode: 'read' },
    /* Null is the cancelled-picker case. */
    validResponse: null,
    /* No token: main holds the path and the renderer holds the token, so a
       candidate without one grants nothing and cannot be redeemed. */
    invalidResponse: { kind: 'local_folder', label: 'juno', accessMode: 'read' },
  },
  'work:open-artifact': {
    validRequest: { artifactId: 'wart_1', version: 3, reveal: true },
    invalidRequest: { artifactId: 'wart_1', version: '3', reveal: true },
    validResponse: { ok: true, filename: 'audit-report.md' },
    /* A failure on the success branch: `ok: true` requires the filename. */
    invalidResponse: { ok: true, reason: 'not found' },
  },
  'work:open-conversation': {
    validRequest: { conversationId: 'conv_1' },
    invalidRequest: { conversationId: 42 },
    ...OK_RESPONSE,
  },

  /* Terminal ---------------------------------------------------------------- */

  'terminal:create': {
    validRequest: { workspaceId: 'ws_1', cols: 120, rows: 40, cwd: 'packages/juno-code', title: 'build' },
    /* Zero columns is a crash, which is why `minCols` is 1 and not 0. */
    invalidRequest: { workspaceId: 'ws_1', cols: 0, rows: 40 },
    validResponse: { terminal: TERMINAL },
    /* The id without its prefix. The `term_` format is the capability: it is
       checked as a format at the router, not merely missed in a map. */
    invalidResponse: {
      terminal: { ...TERMINAL, id: '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f' },
    },
  },
  'terminal:write': {
    validRequest: { terminalId: TERMINAL_ID, data: 'npm test\r' },
    /* A fabricated id. 122 bits of unguessable id is what stops a compromised
       renderer addressing a terminal it was never handed. */
    invalidRequest: { terminalId: 'term_not-a-uuid', data: 'rm -rf /\r' },
    ...OK_RESPONSE,
  },
  'terminal:resize': {
    validRequest: { terminalId: TERMINAL_ID, cols: 100, rows: 30 },
    /* Past `maxRows`. A grid this size is an allocation, not a window. */
    invalidRequest: { terminalId: TERMINAL_ID, cols: 100, rows: 2_001 },
    ...OK_RESPONSE,
  },
  'terminal:kill': {
    validRequest: { terminalId: TERMINAL_ID, signal: 'SIGTERM' },
    /* Outside the allowlist. `SIGSTOP` would wedge the shell with no visible
       cause, which is exactly why the signal is not `z.string()`. */
    invalidRequest: { terminalId: TERMINAL_ID, signal: 'SIGSTOP' },
    ...OK_RESPONSE,
  },
  'terminal:restart': {
    validRequest: { terminalId: TERMINAL_ID },
    /* Uppercase hex. The regex pins the lowercase canonical form so that one id
       has exactly one spelling. */
    invalidRequest: { terminalId: 'term_9F1C2D3E-4A5B-4C6D-8E7F-0A1B2C3D4E5F' },
    validResponse: { terminal: TERMINAL },
    /* Negative history. `historyChars` is what the renderer sizes its replay
       against; below zero it is not a smaller buffer, it is a wrong answer. */
    invalidResponse: { terminal: { ...TERMINAL, historyChars: -1 } },
  },
  'terminal:list': {
    validRequest: { includeHistory: true },
    invalidRequest: { includeHistory: 'yes' },
    validResponse: [{ ...TERMINAL, history: '$ npm test\r\n' }],
    /* `zombie` is not one of the two states main tracks, and the third state a
       renderer invents is a tab it will never offer to restart. */
    invalidResponse: [{ ...TERMINAL, status: 'zombie' }],
  },
};

interface EventSample {
  readonly valid: unknown;
  readonly invalid: unknown;
}

const EVENT_SAMPLES: Record<EventChannel, EventSample> = {
  'auth:changed': {
    valid: { status: 'signed-out' },
    invalid: { status: 'logged-out' },
  },
  'app:appearance-changed': {
    valid: APPEARANCE,
    invalid: { ...APPEARANCE, increaseContrast: 'high' },
  },
  'code:event': {
    valid: { sessionId: 'sess_1', event: { type: 'assistant_delta', text: 'Look' } },
    /* The agent-event union is re-validated here, not merely referenced: a
       malformed event must not ride into the renderer inside a valid envelope. */
    invalid: { sessionId: 'sess_1', event: { type: 'assistant_delta', text: 42 } },
  },
  'code:host-status': {
    valid: { status: 'crashed', detail: 'exit code 1' },
    invalid: { status: 'on fire', detail: null },
  },
  'app:command': {
    valid: { command: 'code.newSession' },
    invalid: { command: 12 },
  },

  /* Chat -------------------------------------------------------------------- */

  'chat:stream': {
    /* The terminal success frame, which carries the authoritative server message
       that replaces everything accumulated locally — so the frame union is only
       as good as its validation of `MessageSchema`. */
    valid: {
      conversationId: 'conv_1',
      assistantMessageId: 'msg_2',
      frame: { type: 'done', message: MESSAGE, finishReason: 'stop' },
    },
    /* `ping` is deliberately absent from the union: it is a proxy heartbeat main
       swallows. A renderer that received one would be woken to do nothing. */
    invalid: {
      conversationId: 'conv_1',
      assistantMessageId: 'msg_2',
      frame: { type: 'ping' },
    },
  },
  'chat:conversation-changed': {
    valid: { kind: 'delete', conversationId: 'conv_1' },
    /* Delete's payload under the upsert tag. An upsert carries the whole row,
       and a sidebar that upserted an id would blank the conversation's title. */
    invalid: { kind: 'upsert', conversationId: 'conv_1' },
  },
  'chat:connection': {
    valid: { status: 'reconnecting', detail: 'Backend unreachable', retryInSeconds: 12 },
    /* Three states, and `reconnecting` is a first-class one rather than a
       flavour of offline. `degraded` is not a fourth. */
    invalid: { status: 'degraded', detail: null, retryInSeconds: null },
  },

  /* Work -------------------------------------------------------------------- */

  'work:snapshot': {
    valid: WORK_SNAPSHOT,
    /* A kind outside the closed 31-kind vocabulary. The reducer would drop it
       silently, and the drop is invisible — the failure mode the closed
       vocabulary exists to prevent. */
    invalid: {
      ...WORK_SNAPSHOT,
      events: [{ kind: 'thinking', text: 'hm', seq: 42, at: '2026-08-12T09:14:03.000Z' }],
    },
  },
  'work:tasks': {
    valid: { tasks: [WORK_TASK_SUMMARY], fetchedAt: '2026-08-12T09:14:02.000Z' },
    /* No `fetchedAt`. It is the field the list ages from, and a list with no age
       is a list that implies a liveness this product does not have. */
    invalid: { tasks: [WORK_TASK_SUMMARY] },
  },
  'work:poll-state': {
    valid: { ...WORK_POLL_STATE, phase: 'failed', consecutiveFailures: 3, error: 'ETIMEDOUT' },
    /* A human-readable interval. The UI counts down against this number. */
    invalid: { ...WORK_POLL_STATE, intervalMs: '4s' },
  },

  /* Terminal ---------------------------------------------------------------- */

  'terminal:output': {
    valid: { terminalId: TERMINAL_ID, seq: 12, chunk: '$ npm test\r\n', truncatedChars: 0 },
    /* A negative sequence number. `seq` is per-terminal and monotonic from zero;
       it is how the renderer tells a gap from a quiet terminal. */
    invalid: { terminalId: TERMINAL_ID, seq: -1, chunk: '', truncatedChars: 0 },
  },
  'terminal:exit': {
    valid: {
      terminalId: TERMINAL_ID,
      exitCode: 0,
      signal: null,
      /* False: the shell exited on its own, so the tab may still offer a restart. */
      released: false,
      at: '2026-08-12T09:15:00.000Z',
    },
    /* The POSIX signal *number*, not its name — the name is the renderer-facing
       vocabulary on `terminal:kill`, and confusing the two is the obvious slip. */
    invalid: {
      terminalId: TERMINAL_ID,
      exitCode: 0,
      signal: 'SIGHUP',
      released: true,
      at: '2026-08-12T09:15:00.000Z',
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Payload validation                                                          */
/* -------------------------------------------------------------------------- */

describe('every invoke channel schema actually validates', () => {
  test('a sample exists for every channel, and for no channel that does not exist', () => {
    expect(Object.keys(INVOKE_SAMPLES).sort()).toEqual([...invokeNames].sort());
  });

  test.each(INVOKE_CHANNEL_LIST)('%s accepts a valid request', (name) => {
    const result = requestSchema(name).safeParse(INVOKE_SAMPLES[name].validRequest);
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  test.each(INVOKE_CHANNEL_LIST)('%s rejects an invalid request', (name) => {
    expect(requestSchema(name).safeParse(INVOKE_SAMPLES[name].invalidRequest).success).toBe(false);
  });

  test.each(INVOKE_CHANNEL_LIST)('%s accepts a valid response', (name) => {
    const result = responseSchema(name).safeParse(INVOKE_SAMPLES[name].validResponse);
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  test.each(INVOKE_CHANNEL_LIST)('%s rejects an invalid response', (name) => {
    expect(responseSchema(name).safeParse(INVOKE_SAMPLES[name].invalidResponse).success).toBe(false);
  });

  test.each(INVOKE_CHANNEL_LIST)('%s rejects structurally absurd input on both sides', (name) => {
    /* Cheap, and it catches the one mistake the samples above cannot: a schema
       written as `z.any()` passes every hand-written case in this file. */
    const junk = [null, 'a string', 42, [1, 2, 3], () => undefined];
    const rejectedByRequest = junk.filter((value) => !requestSchema(name).safeParse(value).success);
    const rejectedByResponse = junk.filter(
      (value) => !responseSchema(name).safeParse(value).success,
    );

    expect(rejectedByRequest.length, `${name} request accepted junk`).toBeGreaterThan(0);
    expect(rejectedByResponse.length, `${name} response accepted junk`).toBeGreaterThan(0);
  });
});

describe('every event channel schema actually validates', () => {
  test('a sample exists for every channel, and for no channel that does not exist', () => {
    expect(Object.keys(EVENT_SAMPLES).sort()).toEqual([...eventNames].sort());
  });

  test.each(EVENT_CHANNEL_LIST)('%s accepts a valid payload', (name) => {
    const result = eventSchema(name).safeParse(EVENT_SAMPLES[name].valid);
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  test.each(EVENT_CHANNEL_LIST)('%s rejects an invalid payload', (name) => {
    expect(eventSchema(name).safeParse(EVENT_SAMPLES[name].invalid).success).toBe(false);
  });

  test.each(EVENT_CHANNEL_LIST)('%s rejects structurally absurd input', (name) => {
    const junk = [null, undefined, 'a string', 42, []];
    const rejected = junk.filter((value) => !eventSchema(name).safeParse(value).success);
    expect(rejected.length, `${name} accepted junk`).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Properties that hold across the whole table                                 */
/* -------------------------------------------------------------------------- */

describe('contract-wide properties', () => {
  test('a channel that takes no argument rejects one', () => {
    /* `z.void()` is easy to write as `z.unknown()` by accident, and the
       difference is whether the renderer can hand main an arbitrary object on a
       channel that was reviewed as taking nothing. */
    const noArgument = INVOKE_CHANNEL_LIST.filter(
      (name) => INVOKE_SAMPLES[name].validRequest === undefined,
    );

    expect(noArgument.length).toBeGreaterThan(0);
    for (const name of noArgument) {
      const request = requestSchema(name);
      expect(request.safeParse(undefined).success, `${name} should accept no argument`).toBe(true);
      expect(request.safeParse({ evil: true }).success, `${name} accepted an argument`).toBe(false);
      expect(request.safeParse(null).success, `${name} accepted null`).toBe(false);
    }
  });

  test('unknown keys are stripped, not forwarded', () => {
    /* Main passes the parsed value on. If unknown keys survived parsing, a
       renderer could smuggle fields past review into whatever consumes them. */
    const result = INVOKE_CHANNELS['code:prompt'].request.safeParse({
      sessionId: 'sess_1',
      text: 'hi',
      cwd: '/etc',
      __unexpected: true,
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ sessionId: 'sess_1', text: 'hi' });
  });

  test('no schema coerces types', () => {
    /* Zod does not coerce unless asked, but `z.coerce.*` is one keystroke away
       and would turn "false" into `true` on the trust channel. */
    expect(
      INVOKE_CHANNELS['workspace:set-trust'].request.safeParse({
        workspaceId: 'ws_1',
        trusted: 'false',
      }).success,
    ).toBe(false);
    expect(
      INVOKE_CHANNELS['code:start-session'].request.safeParse({ workspaceId: 1 }).success,
    ).toBe(false);
  });

  test('optional request fields may be omitted but not nulled', () => {
    const request = INVOKE_CHANNELS['code:start-session'].request;

    expect(request.safeParse({ workspaceId: 'ws_1' }).success).toBe(true);
    expect(request.safeParse({ workspaceId: 'ws_1', model: null }).success).toBe(false);
    expect(request.safeParse({ workspaceId: 'ws_1', mode: null }).success).toBe(false);
  });
});
