/**
 * Ownership of the live `AgentSession` set.
 *
 * agent-core gives us a session object per conversation and a callback pair to
 * drive it (`onEvent`, `requestApproval`). Everything this module adds is about
 * the fact that the other side of those callbacks is now a *process boundary*
 * rather than a function call: approvals have to survive a round trip and can
 * be replayed, event streams have to be bounded before they are copied between
 * heaps, and shutdown has to be able to reach into every session at once.
 *
 * The three invariants this file exists to hold:
 *
 *   1. A decision is applied to at most one tool call, exactly once. See
 *      `settleApproval` — the structural guarantee, not the bookkeeping one.
 *   2. An approval never resolves to `allow` on its own. Every path that ends a
 *      wait without a user decision — abort, close, shutdown, timeout, a
 *      duplicate `callId` — resolves `deny`.
 *   3. Every session is reachable from `sessions`, so shutdown is a loop rather
 *      than a hope.
 */

import {
  AgentSession,
  BACKEND_PROVIDER_PREFIX,
  BackendUsageReporter,
  SessionStore,
  createProvider,
  createProxyProvider,
  defaultProviderId,
  type AgentCallbacks,
  type AgentEvent,
  type AgentOptions,
  type ApprovalDecision,
  type ApprovalRequest,
  type BackendConfig,
  type PermissionMode,
  type ProviderAdapter,
  type SessionMeta,
  type SubagentConfig,
  type UsageReporter,
} from '@juno/agent-core';

import {
  LIMITS,
  clamp,
  describeError,
  type ApprovalOutcome,
  type BackendConfigInput,
  type HostErrorCode,
  type HostMessageDraft,
} from './host-protocol.js';

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** A failure with a protocol error code attached, so the entry point can answer. */
export class HostCommandError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode, message: string) {
    super(message);
    this.name = 'HostCommandError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

export interface SessionManagerOptions {
  /** Stamped with a `seq` and written to the port by the caller. */
  send(message: HostMessageDraft): void;
  /** Live sessions held in memory at once. Each one can hold child processes. */
  maxLiveSessions?: number;
  /** Assistant text streamed per turn before deltas are dropped. */
  maxTurnStreamChars?: number;
  /** Delta coalescing window, in ms. 0 disables coalescing. */
  deltaFlushMs?: number;
  /** Coalesced delta size that forces an early flush. */
  deltaFlushChars?: number;
  /** Longest string kept inside a `tool_started` input payload. */
  maxToolInputChars?: number;
  /** Longest string kept inside an `approval_requested` payload. */
  maxApprovalInputChars?: number;
  /** Longest `assistant_message` forwarded. The full text is on disk regardless. */
  maxAssistantMessageChars?: number;
  /** Decided call ids remembered per session, for duplicate reporting. */
  maxDecisionHistory?: number;
  /** Auto-deny an unanswered approval after this long. 0 waits indefinitely. */
  approvalTimeoutMs?: number;
  /** Delegation config handed to every session. `false` disables subagents. */
  subagents?: SubagentConfig | false;
}

const DEFAULTS = {
  maxLiveSessions: 8,
  maxTurnStreamChars: 4_000_000,
  deltaFlushMs: 33,
  deltaFlushChars: 8_192,
  maxToolInputChars: 8_192,
  maxApprovalInputChars: 65_536,
  maxAssistantMessageChars: 1_000_000,
  maxDecisionHistory: 512,
  approvalTimeoutMs: 0,
} as const;

/* -------------------------------------------------------------------------- */
/* Live session state                                                          */
/* -------------------------------------------------------------------------- */

interface PendingApproval {
  readonly callId: string;
  readonly resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout | null;
}

interface LiveSession {
  readonly id: string;
  readonly session: AgentSession;
  /** The in-flight turn, or null. One turn at a time, as in the sidecar. */
  running: Promise<void> | null;
  /** Set by `abort`, cleared by the next `prompt`. Gates the approval path. */
  aborted: boolean;
  closed: boolean;
  /** Waiting approvals, keyed by the tool call they belong to. */
  readonly pending: Map<string, PendingApproval>;
  /** Calls already decided, for accurate duplicate reporting. Bounded FIFO. */
  readonly decided: Map<string, ApprovalDecision>;
  /** Pending coalesced assistant text. */
  deltaBuffer: string;
  deltaTimer: NodeJS.Timeout | null;
  /** Assistant characters streamed in the current turn. */
  turnStreamChars: number;
  turnStreamTruncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Manager                                                                     */
/* -------------------------------------------------------------------------- */

export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly send: (message: HostMessageDraft) => void;
  private readonly limits: Required<Omit<SessionManagerOptions, 'send' | 'subagents'>>;
  private readonly subagents: SubagentConfig | false | undefined;

  private backend: BackendConfig | null = null;
  private shuttingDown = false;
  private droppedEvents = 0;

  constructor(options: SessionManagerOptions) {
    this.send = options.send;
    this.subagents = options.subagents;
    this.limits = {
      maxLiveSessions: options.maxLiveSessions ?? DEFAULTS.maxLiveSessions,
      maxTurnStreamChars: options.maxTurnStreamChars ?? DEFAULTS.maxTurnStreamChars,
      deltaFlushMs: options.deltaFlushMs ?? DEFAULTS.deltaFlushMs,
      deltaFlushChars: options.deltaFlushChars ?? DEFAULTS.deltaFlushChars,
      maxToolInputChars: options.maxToolInputChars ?? DEFAULTS.maxToolInputChars,
      maxApprovalInputChars: options.maxApprovalInputChars ?? DEFAULTS.maxApprovalInputChars,
      maxAssistantMessageChars:
        options.maxAssistantMessageChars ?? DEFAULTS.maxAssistantMessageChars,
      maxDecisionHistory: options.maxDecisionHistory ?? DEFAULTS.maxDecisionHistory,
      approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULTS.approvalTimeoutMs,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Introspection                                                           */
  /* ---------------------------------------------------------------------- */

  get liveSessionCount(): number {
    return this.sessions.size;
  }

  get runningSessionCount(): number {
    let count = 0;
    for (const live of this.sessions.values()) if (live.running) count += 1;
    return count;
  }

  get pendingApprovalCount(): number {
    let count = 0;
    for (const live of this.sessions.values()) count += live.pending.size;
    return count;
  }

  get droppedEventCount(): number {
    return this.droppedEvents;
  }

  /* ---------------------------------------------------------------------- */
  /* Configuration                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Install (or clear) the backend-proxy credentials.
   *
   * Rebuilt field by field rather than passed through. agent-core's
   * `BackendConfig` declares `authorization?: string`; Zod infers
   * `authorization?: string | undefined`, and under `exactOptionalPropertyTypes`
   * those are different types. Spreading the optional key only when it is
   * present is the honest fix — the alternative is a cast that would also
   * silence a genuine drift later.
   */
  configureBackend(config: BackendConfigInput | null): void {
    if (config === null) {
      this.backend = null;
      return;
    }
    this.backend = {
      baseUrl: config.baseUrl,
      cookie: config.cookie,
      ...(config.authorization !== undefined ? { authorization: config.authorization } : {}),
      models: config.models.map((model) => ({
        provider: model.provider,
        kind: model.kind,
        model: model.model,
        label: model.label,
        available: model.available,
        ...(model.providerName !== undefined ? { providerName: model.providerName } : {}),
        ...(model.reason !== undefined ? { reason: model.reason } : {}),
        ...(model.vision !== undefined ? { vision: model.vision } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      })),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Begin a new session.
   *
   * `AgentSession.create` emits `session_started` from inside its constructor
   * path, before it has returned the object whose id that event belongs to. So
   * events are parked until the session is registered and then replayed in
   * order — the alternative, reading the id out of the event, only works for
   * the one event type that happens to carry it.
   */
  start(request: {
    cwd: string;
    provider?: string | undefined;
    model?: string | undefined;
    mode?: PermissionMode | undefined;
  }): SessionMeta {
    this.assertAcceptingWork();
    this.assertCapacity();

    const provider = this.resolveProvider(request.provider);
    const usageReporter = this.usageReporterFor(request.provider);
    const parked: AgentEvent[] = [];
    let live: LiveSession | null = null;
    const callbacks = this.buildCallbacks(
      () => live,
      (event) => parked.push(event),
    );

    const session = AgentSession.create(
      this.agentOptions({
        provider,
        cwd: request.cwd,
        callbacks,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.mode !== undefined ? { mode: request.mode } : {}),
        ...(usageReporter !== undefined ? { usageReporter } : {}),
      }),
    );

    live = this.register(session);
    for (const event of parked) this.emitEvent(live, event);
    return { ...session.store.meta };
  }

  /**
   * Reattach to a stored session.
   *
   * Idempotent on an already-live session: resuming one that is in memory
   * returns the existing object rather than constructing a second
   * `AgentSession` over the same directory, which would give two objects an
   * independent view of the same `messages.json` and let the loser's
   * `saveMessages` overwrite the winner's transcript.
   */
  resume(request: { sessionId: string; mode?: PermissionMode | undefined }): SessionMeta {
    this.assertAcceptingWork();

    const existing = this.sessions.get(request.sessionId);
    if (existing) {
      if (request.mode !== undefined) existing.session.setMode(request.mode);
      return { ...existing.session.store.meta };
    }

    this.assertCapacity();

    let meta: SessionMeta;
    try {
      meta = SessionStore.open(request.sessionId).meta;
    } catch (err) {
      throw new HostCommandError(
        'unknown_session',
        `No stored session ${request.sessionId}: ${describeError(err)}`,
      );
    }

    /* Resume with the provider the session was created with, not the current
       default: a transcript whose tool calls were produced by one model's
       schema is not portable to another mid-conversation. */
    const provider = this.resolveProvider(meta.provider);
    const usageReporter = this.usageReporterFor(meta.provider);
    const parked: AgentEvent[] = [];
    let live: LiveSession | null = null;
    const callbacks = this.buildCallbacks(
      () => live,
      (event) => parked.push(event),
    );

    const session = AgentSession.resume(
      request.sessionId,
      this.agentOptions({
        provider,
        /* Ignored by agent-core on resume — the stored cwd wins — but the field
           is required by `AgentOptions`, so pass the truth rather than ''. */
        cwd: meta.cwd,
        callbacks,
        ...(request.mode !== undefined ? { mode: request.mode } : {}),
        ...(usageReporter !== undefined ? { usageReporter } : {}),
      }),
    );

    live = this.register(session);
    for (const event of parked) this.emitEvent(live, event);
    return { ...session.store.meta };
  }

  private agentOptions(base: {
    provider: ProviderAdapter;
    cwd: string;
    callbacks: AgentCallbacks;
    model?: string;
    mode?: PermissionMode;
    usageReporter?: UsageReporter;
  }): AgentOptions {
    return {
      ...base,
      ...(this.subagents !== undefined ? { subagents: this.subagents } : {}),
    };
  }

  private register(session: AgentSession): LiveSession {
    const live: LiveSession = {
      id: session.sessionId,
      session,
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
    this.sessions.set(live.id, live);
    return live;
  }

  private assertAcceptingWork(): void {
    if (this.shuttingDown) {
      throw new HostCommandError('shutting_down', 'The agent host is shutting down.');
    }
  }

  private assertCapacity(): void {
    if (this.sessions.size >= this.limits.maxLiveSessions) {
      throw new HostCommandError(
        'session_limit',
        `At most ${this.limits.maxLiveSessions} sessions may be live at once; close one first.`,
      );
    }
  }

  private require(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live || live.closed) {
      throw new HostCommandError('unknown_session', `Session ${sessionId} is not live.`);
    }
    return live;
  }

  /* ---------------------------------------------------------------------- */
  /* Providers                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolve an adapter for a provider id.
   *
   * BYOK keys are read by agent-core from the environment or
   * `~/.juno/credentials.json`; the host never receives a raw API key over the
   * port. `createProviderFromSpec` — which would let main inject a key it holds
   * in the Keychain — exists in agent-core but is not on its public export
   * surface, so it is not reachable through the `@juno/agent-core` alias. See
   * the README's "Compromises" section.
   */
  private resolveProvider(id: string | undefined): ProviderAdapter {
    try {
      if (id !== undefined && id.startsWith(BACKEND_PROVIDER_PREFIX)) {
        if (!this.backend) {
          throw new HostCommandError(
            'backend_not_configured',
            'Send `configure` with backend credentials before using a backend/ provider.',
          );
        }
        return createProxyProvider(this.backend, id);
      }
      if (id !== undefined) return createProvider(id);
      const auto = defaultProviderId();
      if (auto === undefined) {
        throw new HostCommandError('no_provider', 'No provider has a configured API key.');
      }
      return createProvider(auto);
    } catch (err) {
      if (err instanceof HostCommandError) throw err;
      throw new HostCommandError('no_provider', describeError(err));
    }
  }

  /** Usage counts against the account plan only for backend-proxied providers. */
  private usageReporterFor(providerId: string | undefined): UsageReporter | undefined {
    if (!this.backend || providerId === undefined) return undefined;
    if (!providerId.startsWith(BACKEND_PROVIDER_PREFIX)) return undefined;
    return new BackendUsageReporter({
      baseUrl: this.backend.baseUrl,
      cookie: this.backend.cookie,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Turns                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Start a turn. Resolves when the turn is *accepted*, not when it finishes —
   * progress is the event stream, and a caller that waited for completion could
   * not deliver the approval the turn is blocked on.
   */
  prompt(sessionId: string, text: string): void {
    this.assertAcceptingWork();
    const live = this.require(sessionId);
    if (live.running) {
      throw new HostCommandError('session_busy', 'A turn is already running in this session.');
    }

    live.aborted = false;
    live.turnStreamChars = 0;
    live.turnStreamTruncated = false;

    const run = live.session
      .prompt(text)
      .catch((err: unknown) => {
        /* agent-core catches loop failures itself and emits an `error` event,
           so reaching here means the turn broke outside the loop — a refused
           usage reservation, a provider constructed but unusable. Report it on
           both channels: as an event so it lands in the transcript, and as a
           command error so main can attribute it. */
        const message = describeError(err);
        this.emitEvent(live, { type: 'error', message });
        this.send({
          type: 'command_error',
          sessionId,
          code: 'internal',
          message,
        });
      })
      .finally(() => {
        if (live.running === run) live.running = null;
        this.flushDeltas(live);
        /* A turn cannot end with an approval still waiting: agent-core awaits
           each one inline. If one survives, the loop threw around it and the
           promise would leak — deny it so nothing is left holding a resolver. */
        if (live.pending.size > 0) this.denyPending(live, 'The turn ended.');
      });

    live.running = run;
  }

  /**
   * Cancel the in-flight turn.
   *
   * Pending approvals are denied *before* `session.abort()`. agent-core's abort
   * signals an `AbortController` that the provider stream and the subagent
   * manager observe — but a turn parked on `await requestApproval(...)` is not
   * observing anything, and aborting around it leaves the loop suspended
   * forever on a promise nobody will settle. The sidecar has this shape too and
   * only escapes it because closing the socket denies everything on the way
   * out; here, Stop must do it directly.
   */
  abort(sessionId: string): void {
    const live = this.require(sessionId);
    live.aborted = true;
    this.denyPending(live, 'The turn was stopped.');
    live.session.abort();
  }

  setMode(sessionId: string, mode: PermissionMode): void {
    this.require(sessionId).session.setMode(mode);
  }

  undo(sessionId: string): string[] {
    try {
      return this.require(sessionId).session.undoLastTurn();
    } catch (err) {
      if (err instanceof HostCommandError) throw err;
      throw new HostCommandError('internal', describeError(err));
    }
  }

  diff(sessionId: string, sinceTurn: number | undefined): { patch: string; truncated: boolean } {
    let patch: string;
    try {
      patch = this.require(sessionId).session.diffSinceTurn(sinceTurn ?? 0);
    } catch (err) {
      if (err instanceof HostCommandError) throw err;
      throw new HostCommandError('internal', describeError(err));
    }
    if (patch.length <= LIMITS.patchChars) return { patch, truncated: false };
    return { patch: clamp(patch, LIMITS.patchChars), truncated: true };
  }

  /** Stored sessions, live or not. Reads `meta.json` off disk, as the sidecar does. */
  listSessions(): SessionMeta[] {
    try {
      return SessionStore.list();
    } catch (err) {
      throw new HostCommandError('internal', describeError(err));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Approvals                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * The waiting half of the round trip, handed to agent-core as
   * `AgentCallbacks.requestApproval`.
   *
   * Every early return here resolves `deny`. That is the whole design rule: the
   * host has exactly one way to produce `allow`, and it is a validated inbound
   * `approval` frame naming this exact `callId`.
   */
  private awaitApproval(live: LiveSession, request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.shuttingDown || live.closed || live.aborted) {
      this.rememberDecision(live, request.callId, 'deny');
      return Promise.resolve<ApprovalDecision>('deny');
    }

    /* A second live request for a call id that is already waiting means either
       a provider reused a tool-call id or something replayed a tool call. Deny
       the newcomer rather than overwrite the resolver: overwriting strands the
       first promise, and the first promise is the one a user may be looking at. */
    if (live.pending.has(request.callId)) {
      this.log('warn', `duplicate pending approval for call ${request.callId}; denied`);
      return Promise.resolve<ApprovalDecision>('deny');
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const entry: PendingApproval = { callId: request.callId, resolve, timer: null };
      if (this.limits.approvalTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.settleApproval(live, request.callId, 'deny');
          this.log('warn', `approval for call ${request.callId} timed out; denied`);
        }, this.limits.approvalTimeoutMs);
        /* A pending approval must never be the reason the process stays up. */
        entry.timer.unref();
      }
      live.pending.set(request.callId, entry);
    });
  }

  /**
   * Apply an inbound decision.
   *
   * The idempotency guarantee is structural, not bookkeeping: a decision can
   * only be applied by taking a resolver *out* of `pending`, and the entry is
   * deleted in the same synchronous step it is taken. A replay finds nothing to
   * take and can therefore do nothing, whether or not `decided` still remembers
   * it. `decided` exists so the reply can distinguish "already answered" from
   * "never heard of it" — it is the receipt, not the lock.
   */
  resolveApproval(
    sessionId: string,
    callId: string,
    decision: ApprovalDecision,
  ): { outcome: ApprovalOutcome; decision: ApprovalDecision | null } {
    const live = this.sessions.get(sessionId);
    if (!live) return { outcome: 'unknown_call', decision: null };
    return this.settleApproval(live, callId, decision);
  }

  private settleApproval(
    live: LiveSession,
    callId: string,
    decision: ApprovalDecision,
  ): { outcome: ApprovalOutcome; decision: ApprovalDecision | null } {
    const entry = live.pending.get(callId);
    if (!entry) {
      const previous = live.decided.get(callId);
      if (previous !== undefined) return { outcome: 'duplicate_ignored', decision: previous };
      return { outcome: 'unknown_call', decision: null };
    }

    live.pending.delete(callId);
    if (entry.timer) clearTimeout(entry.timer);
    this.rememberDecision(live, callId, decision);
    entry.resolve(decision);
    return { outcome: 'applied', decision };
  }

  /** Deny every waiting approval in a session. Used by abort, close and shutdown. */
  private denyPending(live: LiveSession, reason: string): number {
    const waiting = [...live.pending.keys()];
    for (const callId of waiting) this.settleApproval(live, callId, 'deny');
    if (waiting.length > 0) {
      this.log('info', `denied ${waiting.length} pending approval(s): ${reason}`);
    }
    return waiting.length;
  }

  /** Bounded FIFO. Old entries fall out; losing one cannot make a replay apply. */
  private rememberDecision(live: LiveSession, callId: string, decision: ApprovalDecision): void {
    live.decided.set(callId, decision);
    while (live.decided.size > this.limits.maxDecisionHistory) {
      const oldest = live.decided.keys().next();
      if (oldest.done === true) break;
      live.decided.delete(oldest.value);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                  */
  /* ---------------------------------------------------------------------- */

  private buildCallbacks(
    resolveLive: () => LiveSession | null,
    park: (event: AgentEvent) => void,
  ): AgentCallbacks {
    return {
      onEvent: (event) => {
        const live = resolveLive();
        if (live) this.emitEvent(live, event);
        else park(event);
      },
      requestApproval: (request) => {
        const live = resolveLive();
        /* No session object yet means we are inside `AgentSession.create`,
           where no tool can have run. Unreachable in practice, and `deny` is
           the only answer that stays safe if it ever becomes reachable. */
        if (!live) return Promise.resolve<ApprovalDecision>('deny');
        return this.awaitApproval(live, request);
      },
    };
  }

  /**
   * Forward one agent-core event, bounded.
   *
   * `assistant_delta` is coalesced rather than forwarded per token. A turn
   * produces thousands of them, each one otherwise costing a structured clone
   * and an IPC hop; merged deltas are still `assistant_delta` events with
   * concatenated text, so a renderer that appends sees no difference. Every
   * other event flushes the buffer first, which is what keeps the merge from
   * reordering text against the tool events that interleave with it.
   */
  private emitEvent(live: LiveSession, event: AgentEvent): void {
    if (live.closed) return;

    if (event.type === 'assistant_delta') {
      this.bufferDelta(live, event.text);
      return;
    }

    this.flushDeltas(live);

    if (event.type === 'turn_started') {
      live.turnStreamChars = 0;
      live.turnStreamTruncated = false;
    }

    this.send({ type: 'event', sessionId: live.id, event: this.boundEvent(event) });
  }

  private bufferDelta(live: LiveSession, text: string): void {
    if (live.turnStreamChars >= this.limits.maxTurnStreamChars) {
      this.droppedEvents += 1;
      if (!live.turnStreamTruncated) {
        live.turnStreamTruncated = true;
        /* Reported as host diagnostics rather than as a synthetic transcript
           event: the turn is not in error, and inventing an `error` event would
           put a lie in the persisted event log. */
        this.log(
          'warn',
          `session ${live.id}: streamed assistant text passed ${this.limits.maxTurnStreamChars} chars; further deltas dropped for this turn`,
        );
      }
      return;
    }

    live.turnStreamChars += text.length;
    live.deltaBuffer += text;

    if (this.limits.deltaFlushMs <= 0 || live.deltaBuffer.length >= this.limits.deltaFlushChars) {
      this.flushDeltas(live);
      return;
    }
    if (live.deltaTimer === null) {
      live.deltaTimer = setTimeout(() => this.flushDeltas(live), this.limits.deltaFlushMs);
      live.deltaTimer.unref();
    }
  }

  private flushDeltas(live: LiveSession): void {
    if (live.deltaTimer !== null) {
      clearTimeout(live.deltaTimer);
      live.deltaTimer = null;
    }
    if (live.deltaBuffer.length === 0) return;
    const text = live.deltaBuffer;
    live.deltaBuffer = '';
    if (live.closed) return;
    this.send({ type: 'event', sessionId: live.id, event: { type: 'assistant_delta', text } });
  }

  /**
   * Clamp the unbounded fields of an event before it is copied to another heap.
   *
   * agent-core truncates `tool_finished.output` at 2000 chars already, but not
   * `tool_started.input` — which for a `write_file` call is the entire file
   * being written — and not `assistant_message`. Both cross this boundary on
   * every turn.
   *
   * `approval_requested` gets a far larger allowance than `tool_started`,
   * because it is the payload a human is being asked to authorise and a
   * truncated preview of a destructive action is worse than a large message.
   * The marker is explicit so a surface can say the preview is partial.
   */
  private boundEvent(event: AgentEvent): AgentEvent {
    switch (event.type) {
      case 'tool_started':
        return { ...event, input: boundValue(event.input, this.limits.maxToolInputChars) };
      case 'approval_requested':
        return {
          ...event,
          request: {
            ...event.request,
            input: boundValue(event.request.input, this.limits.maxApprovalInputChars),
            summary: clamp(event.request.summary, this.limits.maxToolInputChars),
          },
        };
      case 'assistant_message':
        return { ...event, text: clamp(event.text, this.limits.maxAssistantMessageChars) };
      case 'tool_finished':
        return { ...event, output: clamp(event.output, this.limits.maxToolInputChars) };
      case 'error':
        return { ...event, message: clamp(event.message, LIMITS.errorChars) };
      default:
        return event;
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.send({ type: 'log', level, message: clamp(message, LIMITS.errorChars) });
  }

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                                */
  /* ---------------------------------------------------------------------- */

  /** Drop one session from memory. Its transcript and checkpoints stay on disk. */
  closeSession(sessionId: string, reason: string): void {
    const live = this.sessions.get(sessionId);
    if (!live) throw new HostCommandError('unknown_session', `Session ${sessionId} is not live.`);
    this.teardown(live, reason);
    this.sessions.delete(sessionId);
    this.send({ type: 'session_closed', sessionId, reason: clamp(reason, LIMITS.errorChars) });
  }

  private teardown(live: LiveSession, reason: string): number {
    live.closed = true;
    const denied = this.denyPending(live, reason);
    if (live.deltaTimer !== null) {
      clearTimeout(live.deltaTimer);
      live.deltaTimer = null;
    }
    live.deltaBuffer = '';
    try {
      live.session.abort();
    } catch (err) {
      this.log('warn', `abort failed for session ${live.id}: ${describeError(err)}`);
    }
    return denied;
  }

  /**
   * Cancel everything and wait, bounded, for the turns to unwind.
   *
   * Three phases, in this order for a reason:
   *
   *   1. Refuse new work, deny every waiting approval, abort every session.
   *      Denying first is what lets a turn parked on an approval actually reach
   *      its abort check instead of sitting on a promise while the clock runs.
   *   2. Wait up to `graceMs` for the in-flight turns to settle, so their
   *      transcripts are written by agent-core's own `onMessagesChanged`.
   *   3. Mark any child agent still running as interrupted, so its stored state
   *      says "the process quit while this agent ran" rather than "running" —
   *      agent-core provides `markAllInterrupted` for exactly this moment.
   */
  async shutdown(graceMs: number): Promise<{
    cancelledSessions: number;
    deniedApprovals: number;
    forced: boolean;
  }> {
    this.shuttingDown = true;

    const live = [...this.sessions.values()];
    let deniedApprovals = 0;
    const running: Promise<void>[] = [];
    for (const entry of live) {
      if (entry.running) running.push(entry.running);
      deniedApprovals += this.teardown(entry, 'The agent host is shutting down.');
    }

    let forced = false;
    if (running.length > 0) {
      forced = !(await settleWithin(running, graceMs));
    }

    for (const entry of live) {
      try {
        entry.session.subagents?.markAllInterrupted();
      } catch (err) {
        this.log('warn', `subagent teardown failed: ${describeError(err)}`);
      }
    }

    this.sessions.clear();
    return { cancelledSessions: live.length, deniedApprovals, forced };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Resolves true if everything settled in time, false if the deadline won. */
async function settleWithin(promises: Promise<unknown>[], graceMs: number): Promise<boolean> {
  if (graceMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
    timer.unref();
  });
  try {
    return await Promise.race([Promise.allSettled(promises).then(() => true), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Copy a tool-input value, clamping strings and refusing to recurse forever.
 *
 * Doubles as a structured-clone guard. `input` is `unknown` as far as the type
 * system is concerned; rebuilding it out of plain objects, arrays, strings,
 * finite numbers and booleans means the value handed to `postMessage` cannot
 * contain anything the structured-clone algorithm will throw on.
 */
const MAX_INPUT_DEPTH = 8;
const MAX_INPUT_ENTRIES = 256;

function boundValue(value: unknown, maxChars: number, depth = 0): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return clamp(value, maxChars);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
      return undefined;
    case 'object':
      break;
    default:
      /* function, symbol: not clonable and never legitimate tool input. */
      return `[${typeof value}]`;
  }
  if (depth >= MAX_INPUT_DEPTH) return '[depth limit]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_INPUT_ENTRIES).map((item) => boundValue(item, maxChars, depth + 1));
    if (value.length > MAX_INPUT_ENTRIES) items.push(`…[${value.length - MAX_INPUT_ENTRIES} more]`);
    return items;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(source)) {
    if (count >= MAX_INPUT_ENTRIES) {
      out['…'] = `[${Object.keys(source).length - MAX_INPUT_ENTRIES} more keys]`;
      break;
    }
    out[key] = boundValue(source[key], maxChars, depth + 1);
    count += 1;
  }
  return out;
}
