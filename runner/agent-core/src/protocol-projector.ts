/**
 * The engine's events, as the canonical agent session protocol.
 *
 * `AgentEvent` (types.ts) is this engine's own vocabulary: transient, keyed by
 * provider call ids, and missing what a reader needs — no turn ids, no typed
 * tool outcomes, no record of who answered an approval. The protocol
 * (contracts/agent/juno-agent-protocol-v1.json, generated into
 * protocol.generated.ts) is what every Juno surface folds. This is the one
 * mapping between them, so a host never builds protocol events by hand.
 *
 * Stateful, because the engine's stream is: a reply arrives as deltas and then
 * a whole message, a tool call is announced by its approval request or its
 * start (whichever comes first), and a turn's usage arrives with its end.
 *
 * Kept to event emission on purpose. Nothing here changes how the engine runs.
 */
import {
  AGENT_PROTOCOL,
  AGENT_SUBAGENT_STATUS_VALUES,
  type AgentApprovalResolver,
  type AgentEvent as ProtocolEvent,
  type AgentEventBody,
  type AgentPermissionMode,
  type AgentReasoningEffort,
  type AgentRepositoryRef,
  type AgentRisk,
  type AgentSessionTarget,
  type AgentStopReason,
  type AgentSubagentStatus,
  type AgentToolKind,
  type AgentTurnOrigin,
  type AgentUsage,
} from './protocol.generated.js';
import type { AgentEvent, ApprovalDecision, ApprovalRequest, PermissionMode, RiskLevel, Usage } from './types.js';

export interface ProtocolProjectorOptions {
  /** The session every event belongs to (a cloud run uses its task id). */
  sessionId: string;
  /**
   * Unique per producer attempt. Event ids are `<runId>:<n>`, so a retried run
   * of the same session can never collide with the attempt before it.
   */
  runId: string;
  target?: AgentSessionTarget;
  repository?: AgentRepositoryRef;
  workspaceName?: string;
  effort?: AgentReasoningEffort;
  title?: string;
  /**
   * False when the host announced the session itself (it had something to
   * say before the engine existed), so the engine's own start is not a second
   * `session.created`.
   */
  announceSession?: boolean;
  /**
   * Set when the host answers every approval itself, by its permission mode,
   * the moment the engine asks (the cloud runner). A request is then emitted
   * together with its answer, never ahead of it: emitted alone it folds as a
   * pending approval, and a reader shown one is offered a decision nobody is
   * waiting for — for as long as a batch boundary falls between the two.
   */
  approvalsAnsweredByMode?: boolean;
  /** The clock, for tests. */
  now?: () => Date;
}

/** A message of the reader's the next turn opens with. */
export interface ProtocolTurnMessage {
  text: string;
  delivery: 'prompt' | 'steer' | 'queue';
  /** The command that carried it, so its sender can mark it delivered. */
  commandId?: string;
}

/** How the host will answer an approval, recorded before it answers. */
export interface ProtocolApprovalAnswer {
  by: AgentApprovalResolver;
  /** With a refusal, why — it becomes the refused call's summary. */
  feedback?: string;
}

interface CallRecord {
  name: string;
  title: string;
  announced: boolean;
  agentId?: string;
}

export class AgentProtocolProjector {
  private seq = 0;
  private openTurnId: string | undefined;
  private textItemId: string | undefined;
  private thinkingItemId: string | undefined;
  private itemCounter = 0;
  private model: string | undefined;
  private lastError: string | undefined;
  private readonly calls = new Map<string, CallRecord>();
  private readonly answers = new Map<string, ProtocolApprovalAnswer>();
  /** Requests held until their answer, with `approvalsAnsweredByMode`. */
  private readonly heldRequests = new Map<string, ApprovalRequest>();
  /** Set by `openTurn`: the engine's next turn is the one the host opened. */
  private adoptNextTurn = false;
  private readonly now: () => Date;
  /** What starts the next turn. A host sets it before a turn a steer or a queued message caused. */
  nextTurnOrigin: AgentTurnOrigin = 'user';
  /** The messages the next turn opens with, announced right after it starts. */
  private nextTurnMessages: ProtocolTurnMessage[] = [];

  constructor(private readonly options: ProtocolProjectorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The turn events without a turnId of their own belong to, if one is open. */
  get currentTurnId(): string | undefined {
    return this.openTurnId;
  }

  /**
   * Wraps a body in an envelope. For events the host itself originates: the
   * clone, the setup step, the pull request. `turnId: null` leaves the turn
   * off the envelope — which, to a reader, means "the turn that is open, if
   * any" (the contract's envelope rule), so it keeps an event out of a turn
   * only while none is open.
   */
  emit(body: AgentEventBody, extra: { turnId?: string | null; agentId?: string } = {}): ProtocolEvent {
    this.seq += 1;
    const turnId = extra.turnId === null ? undefined : (extra.turnId ?? this.openTurnId);
    return {
      v: AGENT_PROTOCOL.v,
      id: `${this.options.runId}:${this.seq}`,
      sessionId: this.options.sessionId,
      seq: this.seq,
      at: this.now().toISOString(),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(extra.agentId !== undefined ? { agentId: extra.agentId } : {}),
      ...body,
    } as ProtocolEvent;
  }

  /** A fresh item id for something the host reports. */
  itemId(kind: string): string {
    this.itemCounter += 1;
    return `${this.options.runId}:${kind}:${this.itemCounter}`;
  }

  /**
   * A message of the reader's the next turn opens with — the prompt, or an
   * instruction folded into it. Announced as the turn's first items when the
   * engine starts it, so they land inside the turn they began.
   */
  queueTurnMessage(message: ProtocolTurnMessage): void {
    this.nextTurnMessages.push(message);
  }

  /**
   * Opens the first turn now, before the engine exists, with the reader's
   * words — for a host with work to report between being handed a prompt and
   * starting the engine (a clone, a setup step). The prompt then comes first
   * in the transcript, as it happened, and is there even when the run fails
   * before the engine ever starts; the engine's first turn continues this one
   * rather than opening a second.
   */
  openTurn(messages: ProtocolTurnMessage[], origin: AgentTurnOrigin = 'user'): ProtocolEvent[] {
    this.openTurnId = `${this.options.runId}:turn:opening`;
    this.adoptNextTurn = true;
    return [this.emit({ type: 'turn.started', origin }), ...messages.map((message) => this.userMessage(message))];
  }

  /**
   * Records how the host is about to answer an approval, so the resolution
   * says who answered and a refusal's reason is the one the host gave — not
   * the engine's "The user declined this action.", which is untrue of a run
   * nobody is watching.
   */
  noteApprovalAnswer(callId: string, answer: ProtocolApprovalAnswer): void {
    this.answers.set(callId, answer);
  }

  /** One engine event, as zero or more protocol events. */
  project(event: AgentEvent): ProtocolEvent[] {
    switch (event.type) {
      case 'session_started':
        this.model = event.model;
        if (this.options.announceSession === false) return [];
        return [
          this.emit(
            {
              type: 'session.created',
              target: this.options.target ?? 'cloud',
              ...(this.options.workspaceName ? { workspaceName: this.options.workspaceName } : {}),
              ...(this.options.repository ? { repository: this.options.repository } : {}),
              model: event.model,
              ...(this.options.effort ? { effort: this.options.effort } : {}),
              mode: protocolMode(event.mode),
              ...(this.options.title ? { title: this.options.title } : {}),
            },
            { turnId: null },
          ),
        ];
      case 'mode_changed':
        return [this.emit({ type: 'session.configured', mode: protocolMode(event.mode) })];
      case 'turn_started': {
        this.textItemId = undefined;
        this.thinkingItemId = undefined;
        const out: ProtocolEvent[] = [];
        if (this.adoptNextTurn && this.openTurnId !== undefined) {
          // The host opened this turn already (`openTurn`); it goes on.
          this.adoptNextTurn = false;
        } else {
          this.adoptNextTurn = false;
          this.openTurnId = `${this.options.runId}:turn:${event.turnIndex}`;
          out.push(this.emit({ type: 'turn.started', origin: this.nextTurnOrigin }));
        }
        this.nextTurnOrigin = 'user';
        for (const message of this.nextTurnMessages.splice(0)) out.push(this.userMessage(message));
        return out;
      }
      case 'assistant_delta':
        if (!event.text) return [];
        this.textItemId ??= this.itemId('text');
        return [this.emit({ type: 'item.assistant_text.delta', itemId: this.textItemId, text: event.text })];
      case 'assistant_message': {
        const itemId = this.textItemId ?? this.itemId('text');
        this.textItemId = undefined;
        return [this.emit({ type: 'item.assistant_text', itemId, text: event.text })];
      }
      case 'thinking_delta':
        if (!event.text) return [];
        this.thinkingItemId ??= this.itemId('thinking');
        return [this.emit({ type: 'item.thinking.delta', itemId: this.thinkingItemId, text: event.text })];
      case 'thinking_message': {
        const itemId = this.thinkingItemId ?? this.itemId('thinking');
        this.thinkingItemId = undefined;
        return [this.emit({ type: 'item.thinking', itemId, summary: event.text })];
      }
      case 'approval_requested': {
        const request = event.request;
        const out = this.announce(request.callId, request.toolName, request.input, request.risk, request.agentId);
        if (this.options.approvalsAnsweredByMode) {
          // Said with its answer, in `approval_resolved`.
          this.heldRequests.set(request.callId, request);
          return out;
        }
        out.push(this.approvalRequested(request));
        return out;
      }
      case 'approval_resolved': {
        const out: ProtocolEvent[] = [];
        const held = this.heldRequests.get(event.callId);
        if (held) {
          this.heldRequests.delete(event.callId);
          out.push(this.approvalRequested(held));
        }
        const answer = this.answers.get(event.callId);
        out.push(
          this.emit(
            {
              type: 'approval.resolved',
              approvalId: event.callId,
              decision: protocolDecision(event.decision),
              by: answer?.by ?? 'user',
              ...(answer?.feedback ? { feedback: answer.feedback } : {}),
            },
            { agentId: event.agentId },
          ),
        );
        return out;
      }
      case 'tool_started':
        return this.announce(event.callId, event.name, event.input, event.risk, event.agentId);
      case 'tool_finished': {
        const out = this.announce(event.callId, event.name, undefined, undefined, event.agentId);
        this.answers.delete(event.callId);
        out.push(
          this.emit(
            {
              type: 'item.tool_result',
              itemId: event.callId,
              status: event.isError ? 'error' : 'ok',
              ...(typeof event.exitCode === 'number' ? { exitCode: event.exitCode } : {}),
              durationMs: Math.max(0, Math.round(event.durationMs)),
              ...(event.output ? { output: event.output } : {}),
            },
            { agentId: event.agentId },
          ),
        );
        return out;
      }
      case 'tool_denied': {
        const out = this.announce(event.callId, event.name, undefined, undefined, event.agentId);
        const answer = this.answers.get(event.callId);
        this.answers.delete(event.callId);
        out.push(
          this.emit(
            {
              type: 'item.tool_result',
              itemId: event.callId,
              status: 'denied',
              summary: answer?.feedback ?? event.reason,
            },
            { agentId: event.agentId },
          ),
        );
        return out;
      }
      case 'files_changed':
        // The host reports what changed from its own diff, with hunks, after
        // the agent phase; a bare path list here would say it twice.
        return [];
      case 'context_compacted':
        // Older steps now reach the model as a summary (compaction.ts). The
        // engine counts what it folded, not the messages either side, so the
        // optional counts stay off rather than guessed.
        return [this.emit({ type: 'item.compaction', itemId: this.itemId('compaction'), source: event.summary })];
      case 'turn_finished': {
        const out: ProtocolEvent[] = [];
        if (event.usage.inputTokens > 0 || event.usage.outputTokens > 0) {
          out.push(
            this.emit({
              type: 'usage.updated',
              usage: protocolUsage(event.usage),
              ...(this.model ? { model: this.model } : {}),
              scope: 'turn',
            }),
          );
        }
        if (event.subagentUsage && (event.subagentUsage.inputTokens > 0 || event.subagentUsage.outputTokens > 0)) {
          out.push(this.emit({ type: 'usage.updated', usage: protocolUsage(event.subagentUsage), scope: 'subagent' }));
        }
        if (event.stopReason === 'error') {
          out.push(
            this.emit({
              type: 'turn.failed',
              error: { code: 'internal', message: this.lastError ?? 'The turn failed.', retryable: false },
            }),
          );
        } else if (event.stopReason === 'quota') {
          out.push(
            this.emit({
              type: 'turn.failed',
              error: { code: 'plan_limit', message: this.lastError ?? "You've reached your plan's usage limit.", retryable: false },
            }),
          );
        } else if (event.stopReason === 'aborted') {
          out.push(this.emit({ type: 'turn.interrupted', reason: 'Stopped before it finished.' }));
        } else {
          out.push(this.emit({ type: 'turn.completed', stopReason: protocolStopReason(event.stopReason) }));
        }
        this.openTurnId = undefined;
        this.adoptNextTurn = false;
        this.textItemId = undefined;
        this.thinkingItemId = undefined;
        this.lastError = undefined;
        // Held requests are NOT dropped here: a sub-agent can still be between
        // asking and being answered when the session's own turn ends.
        return out;
      }
      case 'error':
        this.lastError = event.message;
        return [this.emit({ type: 'session.error', error: { code: 'internal', message: event.message, retryable: false } })];
      case 'workflow_update':
      case 'best_of_n':
      case 'user_input':
      case 'queue_updated':
      case 'auto_review':
      case 'runtime_mode_changed':
      case 'guard':
        // Code v2 events: projected into TurnItems by harness/turn-items.ts;
        // the canonical agent protocol has no item for them yet.
        return [];
      case 'subagent_update': {
        const agent = event.agent;
        const status = (AGENT_SUBAGENT_STATUS_VALUES as readonly string[]).includes(agent.status)
          ? (agent.status as AgentSubagentStatus)
          : 'unknown';
        return [
          this.emit({
            type: 'item.subagent',
            itemId: agent.id,
            title: agent.title,
            status,
            ...(agent.role ? { role: agent.role } : {}),
            ...(agent.currentActivity ? { activity: agent.currentActivity } : {}),
            ...(agent.summary ? { summary: agent.summary } : {}),
            ...(agent.error ? { error: agent.error } : {}),
            usage: protocolUsage(agent.usage),
          }),
        ];
      }
    }
  }

  /** A message of the reader's, as an item of the open turn. */
  private userMessage(message: ProtocolTurnMessage): ProtocolEvent {
    return this.emit({
      type: 'item.user_message',
      itemId: this.itemId('user'),
      text: message.text,
      delivery: message.delivery,
      ...(message.commandId ? { commandId: message.commandId } : {}),
    });
  }

  private approvalRequested(request: ApprovalRequest): ProtocolEvent {
    return this.emit(
      {
        type: 'approval.requested',
        approvalId: request.callId,
        itemId: request.callId,
        action: request.toolName,
        summary: request.summary,
        risk: protocolRisk(request.risk),
      },
      { agentId: request.agentId },
    );
  }

  /** The tool call, announced once, by whichever event names it first. */
  private announce(callId: string, name: string, input: unknown, risk: RiskLevel | undefined, agentId: string | undefined): ProtocolEvent[] {
    const known = this.calls.get(callId);
    if (known?.announced) return [];
    const title = input !== undefined ? toolTitle(name, input) : (known?.title ?? name);
    this.calls.set(callId, { name, title, announced: true, agentId });
    return [
      this.emit(
        {
          type: 'item.tool_call',
          itemId: callId,
          toolName: name,
          toolKind: toolKind(name),
          title,
          ...(risk ? { risk: protocolRisk(risk) } : {}),
        },
        { agentId },
      ),
    ];
  }
}

// ── Vocabulary maps ─────────────────────────────────────────────────────────

export function protocolMode(mode: PermissionMode): AgentPermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'ask':
      return 'ask';
    case 'auto-edit':
      return 'auto_edit';
    case 'full':
      return 'full';
  }
}

/** agent-core's four tiers onto the protocol's five: `sensitive` is the destructive one. */
export function protocolRisk(risk: RiskLevel): AgentRisk {
  switch (risk) {
    case 'safe':
      return 'read';
    case 'edit':
      return 'write';
    case 'command':
      return 'execute';
    case 'sensitive':
      return 'destructive';
  }
}

function protocolDecision(decision: ApprovalDecision) {
  switch (decision) {
    case 'allow':
      return 'allow_once' as const;
    case 'allow_always':
      return 'allow_always' as const;
    case 'deny':
      return 'deny' as const;
  }
}

function protocolStopReason(reason: string): AgentStopReason {
  switch (reason) {
    case 'end_turn':
    case 'max_steps':
    case 'max_tokens':
    case 'refusal':
      return reason;
    case 'budget':
      return 'max_steps';
    default:
      return 'unknown';
  }
}

/**
 * Usage as the protocol counts it. The cache and reasoning fields are read
 * when the engine reports them; `Usage` names only input and output today, and
 * the engine lane adding prompt caching extends it.
 */
export function protocolUsage(usage: Usage): AgentUsage {
  const extra = usage as Usage & Partial<Record<string, unknown>>;
  const count = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = extra[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    }
    return undefined;
  };
  const cacheRead = count('cacheReadTokens', 'cacheReadInputTokens');
  const cacheWrite = count('cacheWriteTokens', 'cacheCreationInputTokens');
  const reasoning = count('reasoningTokens');
  // The engine's inputTokens counts every input token, cached or not (Usage
  // in types.ts); the protocol's counts only the uncached ones, and a reader
  // adds the cache counts back beside it. Passed through, a cached prefix
  // was counted twice.
  const input = Math.max(0, Math.round(usage.inputTokens));
  return {
    inputTokens: Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    outputTokens: Math.max(0, Math.round(usage.outputTokens)),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/** What kind of call a tool is, by the names this engine gives its tools. */
export function toolKind(name: string): AgentToolKind {
  switch (name) {
    case 'read_file':
      return 'read';
    case 'write_file':
    case 'edit_file':
      return 'edit';
    case 'bash':
      return 'execute';
    case 'glob':
    case 'grep':
      return 'search';
    case 'web_fetch':
    case 'web_search':
      return 'fetch';
    case 'delegate_tasks':
    case 'await_subagents':
    case 'inspect_subagent':
    case 'cancel_subagent':
    case 'spawn_agent':
    case 'send_message':
    case 'interrupt_agent':
    case 'list_agents':
    case 'workflow':
    case 'best_of_n':
    case 'update_plan':
      return 'think';
    default:
      return 'other';
  }
}

/** One line a person reads for a call: `$ npm test`, `Read src/app.ts`. */
export function toolTitle(name: string, input: unknown): string {
  const p = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  switch (name) {
    case 'bash':
      return `$ ${text(p.command).slice(0, 200)}`;
    case 'read_file':
      return `Read ${text(p.path)}`;
    case 'write_file':
      return `Write ${text(p.path)}`;
    case 'edit_file':
      return `Edit ${text(p.path)}`;
    case 'glob':
      return `Glob ${text(p.pattern)}`;
    case 'grep':
      return `Grep /${text(p.pattern)}/${p.glob ? ` in ${text(p.glob)}` : ''}`;
    case 'delegate_tasks': {
      const count = Array.isArray(p.tasks) ? p.tasks.length : 0;
      return count > 0 ? `Delegate ${count} task${count === 1 ? '' : 's'}` : 'Delegate tasks';
    }
    default:
      return name;
  }
}
