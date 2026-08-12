/**
 * The main ⇄ agent-host message contract.
 *
 * The agent host is a separate OS process (an Electron `utilityProcess`), so
 * everything crossing this boundary is untrusted input in both directions and
 * every frame is parsed with Zod before it is acted on. Types are erased at
 * runtime; these schemas are not.
 *
 * The command vocabulary is adapted from the WebSocket sidecar documented on
 * `startSidecarServer` (`runner/agent-core/src/server.ts`) — start / resume /
 * prompt / approval / set_mode / undo / diff / list_sessions / abort — because
 * that is the vocabulary the Swift clients, the session relay and the cloud
 * runner already speak, and there is no value in inventing a second one. Three
 * things are added that the socket protocol could not express:
 *
 *   `seq`        A monotonically increasing counter, per direction. A
 *                MessagePort delivers in order, so this is not a reordering
 *                fix; it is a *replay* guard. A frame whose `seq` is not
 *                greater than the last accepted one is dropped, which is the
 *                cheap half of the approval-idempotency guarantee (the load
 *                bearing half is in `session-manager.ts`).
 *
 *   `requestId`  Correlates a command with its reply. The socket protocol had
 *                no correlation at all: a `diff` reply was matched to a `diff`
 *                request by being the next `diff`-shaped frame to arrive, which
 *                is only true while exactly one request is ever in flight.
 *
 *   `sessionId`  Carried on every frame that concerns a session. The sidecar
 *                held *one* session per connection and therefore needed no
 *                addressing; the host multiplexes, so a frame without a session
 *                id is a frame that could be applied to the wrong session.
 *
 * `start` is the one command with no `sessionId`: the id is minted by
 * `SessionStore.create` inside agent-core and is not knowable until the session
 * exists. It carries a `requestId`, and the host answers with `session_started`
 * carrying the new id.
 */

import { z } from 'zod';
import {
  AgentEventSchema,
  ApprovalDecisionSchema,
  PermissionModeSchema,
  SessionMetaSchema,
} from '../shared/agent-protocol.js';

/**
 * Bumped when a frame changes shape incompatibly. The host announces it in
 * `ready`; main refuses to drive a host whose version it does not recognise
 * rather than guessing, because a half-understood approval frame is the one
 * kind of protocol drift with a destructive failure mode.
 */
export const HOST_PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every unbounded field gets a ceiling. These are not guesses about what is
 * reasonable; they are the point past which a frame is evidence of a bug or an
 * attack rather than a large-but-legitimate payload, and where the honest
 * response is to reject the frame instead of allocating for it.
 */
export const LIMITS = {
  /** Roughly a megabyte of pasted context; beyond this the provider refuses anyway. */
  promptChars: 1_000_000,
  path: 4_096,
  identifier: 256,
  /** A unified diff big enough for a large turn, truncated with a flag past it. */
  patchChars: 2_000_000,
  /** Backend model catalogue; the website ships a few dozen. */
  catalogEntries: 512,
  /** Redacted protocol-error text, so a malformed frame cannot log a novel. */
  errorChars: 2_000,
} as const;

const Seq = z.number().int().positive();
const Identifier = z.string().min(1).max(LIMITS.identifier);
const SessionId = Identifier;
const RequestId = Identifier;
const CallId = Identifier;

/* -------------------------------------------------------------------------- */
/* Backend proxy configuration                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors agent-core's `BackendConfig` / `BackendCatalogModel`.
 *
 * This frame carries a session cookie or bearer token. It is the reason
 * `redactSecrets` exists and the reason nothing in the host ever logs a parsed
 * command payload — only its `type`.
 *
 * The fields are re-declared rather than imported because agent-core's types
 * are compile-time only and this is a runtime boundary. `session-manager.ts`
 * rebuilds the value field-by-field when handing it to `createProxyProvider`,
 * which keeps `exactOptionalPropertyTypes` honest instead of asserting a
 * structural identity that Zod's `| undefined` inference cannot satisfy.
 */
export const BackendCatalogModelSchema = z.object({
  provider: Identifier,
  providerName: z.string().max(200).optional(),
  kind: z.enum(['anthropic', 'openai']),
  model: z.string().min(1).max(200),
  label: z.string().max(200),
  available: z.boolean(),
  reason: z.string().max(500).optional(),
  vision: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
});

export const BackendConfigSchema = z.object({
  baseUrl: z.string().min(1).max(LIMITS.path),
  cookie: z.string().max(8_192),
  authorization: z.string().max(8_192).optional(),
  models: z.array(BackendCatalogModelSchema).max(LIMITS.catalogEntries),
});

export type BackendConfigInput = z.infer<typeof BackendConfigSchema>;

/* -------------------------------------------------------------------------- */
/* Main -> host                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Why several commands that "cannot fail" still carry a `requestId`: they can
 * fail. `set_mode` on a closed session, `abort` on a session id the renderer
 * remembered across a host restart, `prompt` while a turn is already running —
 * each needs somewhere to put the error, and an error with no correlation id is
 * an error the caller cannot attribute.
 */
export const HostCommandSchema = z.discriminatedUnion('type', [
  /** Supply (or clear, with `backend: null`) the backend-proxy credentials. */
  z.object({
    type: z.literal('configure'),
    seq: Seq,
    requestId: RequestId,
    backend: BackendConfigSchema.nullable(),
  }),

  z.object({
    type: z.literal('start'),
    seq: Seq,
    requestId: RequestId,
    cwd: z.string().min(1).max(LIMITS.path),
    provider: Identifier.optional(),
    model: z.string().min(1).max(200).optional(),
    mode: PermissionModeSchema.optional(),
  }),

  z.object({
    type: z.literal('resume'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
    mode: PermissionModeSchema.optional(),
  }),

  z.object({
    type: z.literal('prompt'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
    text: z.string().max(LIMITS.promptChars),
  }),

  /**
   * Answers an `approval_requested` event.
   *
   * `callId` is mandatory and is the *only* thing the decision is keyed on. A
   * decision addressed to a session rather than to a specific tool call could
   * be applied to whichever call happened to be waiting, which across a
   * reconnect is how "allow" on a file write becomes "allow" on `rm -rf`.
   */
  z.object({
    type: z.literal('approval'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
    callId: CallId,
    decision: ApprovalDecisionSchema,
  }),

  z.object({
    type: z.literal('set_mode'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
    mode: PermissionModeSchema,
  }),

  z.object({
    type: z.literal('undo'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
  }),

  z.object({
    type: z.literal('diff'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
    sinceTurn: z.number().int().nonnegative().optional(),
  }),

  z.object({
    type: z.literal('list_sessions'),
    seq: Seq,
    requestId: RequestId,
  }),

  z.object({
    type: z.literal('abort'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
  }),

  /** Drop a session from memory. Storage on disk is untouched. */
  z.object({
    type: z.literal('close_session'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
  }),

  /** Liveness probe. Answered with a `heartbeat` carrying host counters. */
  z.object({
    type: z.literal('heartbeat'),
    seq: Seq,
  }),

  /**
   * Graceful shutdown. Equivalent to SIGTERM, but it gets an acknowledgement,
   * so main can wait for `shutdown_complete` instead of guessing how long the
   * host needs before escalating to `kill()`.
   */
  z.object({
    type: z.literal('shutdown'),
    seq: Seq,
    requestId: RequestId,
    graceMs: z.number().int().nonnegative().max(120_000).optional(),
  }),
]);

export type HostCommand = z.infer<typeof HostCommandSchema>;
export type HostCommandOf<T extends HostCommand['type']> = Extract<HostCommand, { type: T }>;

/* -------------------------------------------------------------------------- */
/* Host -> main                                                                */
/* -------------------------------------------------------------------------- */

/** Machine-readable failure reasons, so main can react without string matching. */
export const HostErrorCodeSchema = z.enum([
  'invalid_request',
  'unknown_session',
  'session_busy',
  'session_limit',
  'no_provider',
  'backend_not_configured',
  'shutting_down',
  'stale_seq',
  'unsupported_protocol',
  'internal',
]);
export type HostErrorCode = z.infer<typeof HostErrorCodeSchema>;

/**
 * What happened to an inbound approval.
 *
 * `duplicate_ignored` is reported rather than silently swallowed because the
 * difference between "your decision was applied" and "a decision for that call
 * was already applied and yours changed nothing" is the difference main needs
 * in order to not draw a second confirmation in the UI.
 */
export const ApprovalOutcomeSchema = z.enum(['applied', 'duplicate_ignored', 'unknown_call']);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcomeSchema>;

export const HostMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    seq: Seq,
    protocolVersion: z.number().int().positive(),
    pid: z.number().int().positive(),
  }),

  z.object({
    type: z.literal('session_started'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
    meta: SessionMetaSchema,
  }),

  /**
   * One agent-core event.
   *
   * Approval requests travel here, inside the ordinary event stream, rather
   * than on a channel of their own. agent-core emits `approval_requested`
   * between `tool_started`-adjacent events, and the surface has to render the
   * prompt in that position; a side channel would let the prompt overtake the
   * events that explain what it is asking about.
   */
  z.object({
    type: z.literal('event'),
    seq: Seq,
    sessionId: SessionId,
    event: AgentEventSchema,
  }),

  z.object({
    type: z.literal('approval_settled'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
    callId: CallId,
    outcome: ApprovalOutcomeSchema,
    /** The decision in force for this call — the first one, on a duplicate. */
    decision: ApprovalDecisionSchema.nullable(),
  }),

  /** Generic success for commands with nothing to return. */
  z.object({
    type: z.literal('ack'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId.optional(),
  }),

  z.object({
    type: z.literal('diff_result'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
    patch: z.string(),
    truncated: z.boolean(),
  }),

  z.object({
    type: z.literal('undo_result'),
    seq: Seq,
    requestId: RequestId,
    sessionId: SessionId,
    restored: z.array(z.string()),
  }),

  z.object({
    type: z.literal('sessions'),
    seq: Seq,
    requestId: RequestId,
    sessions: z.array(SessionMetaSchema),
  }),

  z.object({
    type: z.literal('session_closed'),
    seq: Seq,
    sessionId: SessionId,
    reason: z.string().max(LIMITS.errorChars),
  }),

  /** A command was understood but could not be carried out. */
  z.object({
    type: z.literal('command_error'),
    seq: Seq,
    requestId: RequestId.optional(),
    sessionId: SessionId.optional(),
    code: HostErrorCodeSchema,
    message: z.string().max(LIMITS.errorChars),
  }),

  /** A frame was not understood at all, so there may be no `requestId` to blame. */
  z.object({
    type: z.literal('protocol_error'),
    seq: Seq,
    code: HostErrorCodeSchema,
    message: z.string().max(LIMITS.errorChars),
  }),

  z.object({
    type: z.literal('heartbeat'),
    seq: Seq,
    /** Set when this is a reply to a probe rather than the periodic beat. */
    respondingToSeq: Seq.optional(),
    uptimeMs: z.number().int().nonnegative(),
    liveSessions: z.number().int().nonnegative(),
    runningSessions: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
    /** Events dropped by the per-session output bound since the host started. */
    droppedEvents: z.number().int().nonnegative(),
  }),

  z.object({
    type: z.literal('shutdown_complete'),
    seq: Seq,
    requestId: RequestId.optional(),
    cancelledSessions: z.number().int().nonnegative(),
    /** Approvals auto-denied because the host was going away. Never auto-allowed. */
    deniedApprovals: z.number().int().nonnegative(),
    /** Process groups killed by the best-effort reaper. See the README. */
    reapedProcessGroups: z.number().int().nonnegative(),
    /** True when in-flight turns were still running when the grace period ended. */
    forced: z.boolean(),
  }),

  /** Host diagnostics. Always redacted; never carries a command payload. */
  z.object({
    type: z.literal('log'),
    seq: Seq,
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string().max(LIMITS.errorChars),
  }),
]);

export type HostMessage = z.infer<typeof HostMessageSchema>;

/** `Omit` that distributes over a union instead of collapsing it to its base. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A host message before the transport stamps it.
 *
 * `seq` is deliberately not something a caller can supply: one counter, owned
 * by the one function that writes to the port, is the only arrangement in which
 * "monotonically increasing" is a property of the code rather than a rule
 * contributors have to remember.
 */
export type HostMessageDraft = DistributiveOmit<HostMessage, 'seq'>;

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse an inbound command.
 *
 * Returns a result rather than throwing: one malformed frame must not tear down
 * live sessions, and the caller needs to answer with a `protocol_error` on the
 * same port it arrived on.
 *
 * The Zod message is redacted and truncated before it leaves this function.
 * Validation messages quote received values for enum and literal mismatches,
 * and one of the fields being validated is a session cookie.
 */
export function parseHostCommand(raw: unknown): ParseResult<HostCommand> {
  const result = HostCommandSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: describeFailure(result.error) };
}

/** Parse an inbound host message. Used by main, and by the host's own tests. */
export function parseHostMessage(raw: unknown): ParseResult<HostMessage> {
  const result = HostMessageSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: describeFailure(result.error) };
}

function describeFailure(error: z.ZodError): string {
  return clamp(redactSecrets(z.prettifyError(error)), LIMITS.errorChars);
}

export function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Drops frames whose `seq` does not advance.
 *
 * Sound because the counter and the process share a lifetime: main mints a
 * fresh counter for each host it forks, and a host only ever sees one counter.
 * So a non-advancing `seq` is never a legitimate restart — it is a duplicate,
 * and duplicates are exactly what must not reach the approval path.
 */
export class InboundSequenceGuard {
  private last = 0;

  /** True when the frame is new and should be processed. */
  accept(seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq <= this.last) return false;
    this.last = seq;
    return true;
  }

  get lastAccepted(): number {
    return this.last;
  }
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Strip credential-shaped substrings from text that is about to be logged.
 *
 * agent-core has no redaction helper. It has *avoidance* — `bash.ts` builds a
 * `MINIMAL_ENV` rather than handing `process.env` to agent-authored commands,
 * `session.ts` replaces screenshot bytes with a marker before persisting, and
 * `agent.ts` truncates tool output at 2000 chars in events — but there is no
 * `redact()` to reuse, and grepping the package for one finds only those
 * comments. This is the honest local substitute, applied on the way out of the
 * host, not a claim that agent-core sanitises anything for us.
 *
 * Deliberately conservative. It matches credential *shapes* (known key
 * prefixes, `Authorization`/`Cookie` header values, `KEY=value` for names that
 * contain KEY/TOKEN/SECRET/PASSWORD) rather than anything long and random,
 * because a redactor that mangles ordinary text gets turned off.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bcct_[A-Za-z0-9._-]{8,}/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(authorization|cookie|set-cookie|proxy-authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*[^\s,;]+/g,
];

const REDACTED = '[redacted]';

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => {
      const separator = match.search(/[:=]|\s(?=[^\s]*$)/);
      /* Keep the field name so the log still says *what* was redacted. */
      return separator > 0 ? `${match.slice(0, separator + 1)}${REDACTED}` : REDACTED;
    });
  }
  return out;
}

/**
 * Render an unknown thrown value as a redacted, bounded, single line.
 *
 * Stacks are dropped rather than forwarded: they name absolute paths in the
 * user's home directory, and everything the surface can act on is in the
 * message. The host's own stderr keeps the stack for a developer build.
 */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return clamp(redactSecrets(raw.replace(/\s+/g, ' ').trim()), LIMITS.errorChars);
}
