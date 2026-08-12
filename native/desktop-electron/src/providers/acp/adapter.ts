/**
 * ACP -> `AgentEvent`.
 *
 * Juno already has one canonical event vocabulary: `AgentEvent` in
 * `runner/agent-core/src/types.ts`, spoken by the local agent loop, the cloud
 * runner, the session relay and the Swift clients. Adding a second vocabulary
 * for ACP providers would mean every consumer grows a branch, and the two
 * branches drift. So ACP is translated here, once, and everything downstream
 * stays unaware that a third-party CLI was involved at all.
 *
 * The translation is not one-to-one, and the honest handling of that is the
 * substance of this module:
 *
 *   - ACP carries several concepts `AgentEvent` has no slot for — reasoning
 *     chunks, plans, slash-command catalogues, context-window meters. Those are
 *     NOT dropped on the floor. They go out on a typed side channel
 *     (`AcpSideEvent`) so a UI can render them, while the canonical stream stays
 *     exactly the shape every other Juno surface already handles.
 *   - `AgentEvent` has several concepts ACP cannot express — subagents, agent
 *     teams, undo. Those are simply never emitted for an ACP provider, and the
 *     capability manifest says so up front rather than letting the UI discover
 *     it by rendering an empty panel.
 *
 * Every lossy edge is enumerated in docs/PROVIDERS.md. If you add a mapping
 * here, add it there.
 */

import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  PermissionMode,
  RiskLevel,
  Usage,
} from '@juno/agent-core';
import type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  PromptResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from './schema.js';

/* -------------------------------------------------------------------------- */
/* Side channel                                                                */
/* -------------------------------------------------------------------------- */

/**
 * ACP concepts with no `AgentEvent` equivalent.
 *
 * The alternative designs were to widen `AgentEvent` (which would force the
 * cloud runner and both Swift clients to handle events they can never receive)
 * or to discard them (which loses the reasoning stream and the slash-command
 * catalogue, both of which users can see in other clients). A parallel typed
 * channel keeps the canonical union stable and the data intact.
 */
export type AcpSideEvent =
  /** `agent_thought_chunk` — the agent's reasoning stream. */
  | { readonly type: 'reasoning_delta'; readonly text: string }
  /** `plan` — a full replacement plan. */
  | { readonly type: 'plan'; readonly entries: readonly PlanEntryView[] }
  /** `plan_update` / `plan_removed` — passed through unmodelled; shapes vary. */
  | { readonly type: 'plan_changed'; readonly raw: unknown }
  /** `available_commands_update` — drives the slash-command menu. */
  | { readonly type: 'commands'; readonly commands: readonly AvailableCommand[] }
  /** `config_option_update` — model pickers, thinking toggles, etc. */
  | { readonly type: 'config_options'; readonly options: readonly SessionConfigOption[] }
  /** `session_info_update` — the agent's own title for the session. */
  | { readonly type: 'session_info'; readonly title: string | null; readonly updatedAt: string | null }
  /**
   * `usage_update` — CONTEXT WINDOW occupancy (`used` of `size`), not token
   * billing. Deliberately not folded into `turn_finished.usage`, which means
   * something else entirely.
   */
  | {
      readonly type: 'context_usage';
      readonly used: number;
      readonly size: number;
      readonly cost: { readonly amount: number; readonly currency: string } | null;
    }
  /** `user_message_chunk` — replayed history during `session/load`. */
  | { readonly type: 'replayed_user_message'; readonly text: string }
  /** The agent's own permission choices, richer than Juno's three decisions. */
  | {
      readonly type: 'permission_options';
      readonly callId: string;
      readonly options: readonly PermissionOption[];
    }
  /** A tool whose output is a live terminal Juno did not host. */
  | { readonly type: 'terminal_reference'; readonly callId: string; readonly terminalId: string }
  /** An update Juno recognised but chose not to translate. */
  | { readonly type: 'unmapped'; readonly sessionUpdate: string; readonly raw: unknown };

export interface PlanEntryView {
  readonly content: string;
  readonly priority: 'high' | 'medium' | 'low';
  readonly status: 'pending' | 'in_progress' | 'completed';
}

/** What one inbound ACP update becomes. Either list may be empty. */
export interface Translation {
  readonly events: readonly AgentEvent[];
  readonly side: readonly AcpSideEvent[];
}

const EMPTY: Translation = { events: [], side: [] };

/* -------------------------------------------------------------------------- */
/* Scalar mappings                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `ToolKind` -> `RiskLevel`.
 *
 * Note what this deliberately does NOT do: it does not re-run agent-core's
 * `classifySensitiveCommand` over the tool's command text. For an ACP provider
 * the agent owns its own permission policy and asks via
 * `session/request_permission` when it wants confirmation; Juno is not the gate.
 * This field is therefore a *display* hint — what badge to put on the row — and
 * duplicating agent-core's pattern list here would create two copies that drift
 * while adding no enforcement.
 */
export function riskForToolKind(kind: ToolKind | null | undefined): RiskLevel {
  switch (kind) {
    case 'edit':
    case 'move':
      return 'edit';
    case 'delete':
      return 'sensitive';
    case 'execute':
      return 'command';
    case 'read':
    case 'search':
    case 'fetch':
    case 'think':
    case 'switch_mode':
    case 'other':
    case null:
    case undefined:
      return 'safe';
    default:
      return 'safe';
  }
}

/**
 * ACP mode ids are agent-defined free strings; Juno's `PermissionMode` is a
 * closed set of four. The mapping is therefore a heuristic over the ids agents
 * actually ship, and an unrecognised id falls back to `ask` — the conservative
 * end, because guessing `full` from an unknown string would silently widen what
 * an agent may do without confirmation.
 */
export function permissionModeForAcpMode(modeId: string): PermissionMode {
  const id = modeId.toLowerCase().replace(/[\s_-]/g, '');
  if (id.includes('plan') || id.includes('architect') || id.includes('readonly')) return 'plan';
  if (id.includes('bypass') || id.includes('yolo') || id.includes('full') || id.includes('danger')) {
    return 'full';
  }
  if (id.includes('acceptedits') || id.includes('autoedit') || id.includes('edit')) return 'auto-edit';
  return 'ask';
}

/** Flatten a content block to the plain text Juno's transcript stores. */
function contentToText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return `[image: ${block.mimeType}]`;
    case 'audio':
      return `[audio: ${block.mimeType}]`;
    case 'resource_link':
      return `[${block.name}](${block.uri})`;
    case 'resource': {
      // Loose schemas carry an index signature, so `'text' in resource` does
      // not narrow. Check the runtime type instead of trusting the union.
      const text = block.resource['text'];
      return typeof text === 'string' ? text : `[binary: ${String(block.resource['uri'] ?? '')}]`;
    }
    default:
      return '';
  }
}

/** Render tool output. `AgentEvent.tool_finished.output` is a single string. */
function toolContentToText(entry: ToolCallContent): string {
  switch (entry.type) {
    case 'content':
      return contentToText(entry.content);
    case 'diff':
      return renderDiffSummary(entry.path, entry.oldText ?? null, entry.newText);
    case 'terminal':
      return `[terminal ${entry.terminalId}]`;
    default:
      return '';
  }
}

function renderDiffSummary(path: string, oldText: string | null, newText: string): string {
  const before = oldText === null ? 0 : oldText.split('\n').length;
  const after = newText.split('\n').length;
  if (oldText === null) return `${path}: created (${after} lines)`;
  return `${path}: ${before} -> ${after} lines`;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

interface ToolState {
  readonly name: string;
  readonly startedAt: number;
  risk: RiskLevel;
  input: unknown;
  output: string[];
  paths: Set<string>;
  finished: boolean;
}

export interface AcpAdapterOptions {
  /** Goes into `session_started.provider`, e.g. `acp/claude-agent`. */
  readonly providerId: string;
  readonly cwd: string;
  /**
   * `AgentEvent.session_started.model` is required, and ACP does not report a
   * model anywhere in the handshake. When the session's config options expose
   * one, `noteConfigOptions` fills it in; until then this placeholder is what
   * the UI shows. Saying "agent-managed" is truthful; inventing a model id is
   * not.
   */
  readonly modelHint?: string;
  /** Starting permission mode, before any `current_mode_update`. */
  readonly mode?: PermissionMode;
}

/**
 * Stateful translator for one ACP session.
 *
 * Holds only what the translation genuinely needs: open tool calls (to compute
 * durations and synthesise a `tool_started` for agents that skip it), the
 * in-flight assistant message (to emit one `assistant_message` per message
 * rather than per chunk), and the turn's changed paths.
 */
export class AcpEventAdapter {
  #turnIndex = -1;
  #tools = new Map<string, ToolState>();
  #assistantText = '';
  #currentMessageId: string | null = null;
  #turnPaths = new Set<string>();
  #mode: PermissionMode;
  #model: string;

  constructor(private readonly options: AcpAdapterOptions) {
    this.#mode = options.mode ?? 'ask';
    this.#model = options.modelHint ?? 'agent-managed';
  }

  get turnIndex(): number {
    return this.#turnIndex;
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  /** Emitted once, after `session/new` or `session/load` returns. */
  sessionStarted(sessionId: string): AgentEvent {
    return {
      type: 'session_started',
      sessionId,
      cwd: this.options.cwd,
      provider: this.options.providerId,
      model: this.#model,
      mode: this.#mode,
    };
  }

  /**
   * Recover a model name from the session's config options, if the agent
   * exposes one. Best-effort by design: the key is not standardised, so this
   * looks for the obvious id and gives up quietly rather than guessing.
   */
  noteConfigOptions(options: readonly SessionConfigOption[]): void {
    for (const option of options) {
      if (option.id.toLowerCase() !== 'model') continue;
      const value = option.currentValue ?? option.value;
      if (typeof value === 'string' && value.length > 0) this.#model = value;
      return;
    }
  }

  /** Call when `session/prompt` is sent. */
  beginTurn(): AgentEvent {
    this.#turnIndex += 1;
    this.#assistantText = '';
    this.#currentMessageId = null;
    this.#turnPaths.clear();
    return { type: 'turn_started', turnIndex: this.#turnIndex };
  }

  /* ---------------------------------------------------------------------- */
  /* session/update                                                          */
  /* ---------------------------------------------------------------------- */

  translate(update: SessionUpdate): Translation {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.#onAssistantChunk(update.content, update.messageId ?? null);

      case 'agent_thought_chunk': {
        const text = contentToText(update.content);
        return text.length === 0 ? EMPTY : { events: [], side: [{ type: 'reasoning_delta', text }] };
      }

      case 'user_message_chunk': {
        const text = contentToText(update.content);
        return { events: [], side: [{ type: 'replayed_user_message', text }] };
      }

      case 'tool_call':
        return this.#onToolCall(update);

      case 'tool_call_update':
        return this.#onToolCallUpdate(update);

      case 'plan':
        return {
          events: [],
          side: [
            {
              type: 'plan',
              entries: update.entries.map((entry) => ({
                content: entry.content,
                priority: entry.priority,
                status: entry.status,
              })),
            },
          ],
        };

      case 'plan_update':
        return { events: [], side: [{ type: 'plan_changed', raw: update.plan }] };

      case 'plan_removed':
        return { events: [], side: [{ type: 'plan_changed', raw: { removed: update.planId } }] };

      case 'available_commands_update':
        return { events: [], side: [{ type: 'commands', commands: update.availableCommands }] };

      case 'config_option_update':
        this.noteConfigOptions(update.configOptions);
        return { events: [], side: [{ type: 'config_options', options: update.configOptions }] };

      case 'session_info_update':
        return {
          events: [],
          side: [
            {
              type: 'session_info',
              title: update.title ?? null,
              updatedAt: update.updatedAt ?? null,
            },
          ],
        };

      case 'usage_update':
        return {
          events: [],
          side: [
            {
              type: 'context_usage',
              used: update.used,
              size: update.size,
              cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : null,
            },
          ],
        };

      case 'current_mode_update': {
        const mode = permissionModeForAcpMode(update.currentModeId);
        if (mode === this.#mode) return EMPTY;
        this.#mode = mode;
        return { events: [{ type: 'mode_changed', mode }], side: [] };
      }

      default: {
        const exhaustive: never = update;
        void exhaustive;
        return EMPTY;
      }
    }
  }

  /**
   * Assistant text.
   *
   * Deltas go out as they arrive; the accumulated message is flushed as one
   * `assistant_message` when the `messageId` changes or the turn ends. Agents
   * that never set `messageId` therefore produce exactly one message per turn,
   * which matches how the transcript renders anyway.
   */
  #onAssistantChunk(content: ContentBlock, messageId: string | null): Translation {
    const events: AgentEvent[] = [];
    if (messageId !== null && this.#currentMessageId !== null && messageId !== this.#currentMessageId) {
      const flushed = this.#flushAssistantMessage();
      if (flushed) events.push(flushed);
    }
    if (messageId !== null) this.#currentMessageId = messageId;

    const text = contentToText(content);
    if (text.length === 0) return events.length > 0 ? { events, side: [] } : EMPTY;
    this.#assistantText += text;
    events.push({ type: 'assistant_delta', text });
    return { events, side: [] };
  }

  #flushAssistantMessage(): AgentEvent | null {
    const text = this.#assistantText;
    this.#assistantText = '';
    this.#currentMessageId = null;
    return text.length > 0 ? { type: 'assistant_message', text } : null;
  }

  #onToolCall(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>): Translation {
    const callId = update.toolCallId;
    const name = update.name ?? update.title;
    const risk = riskForToolKind(update.kind);
    const state: ToolState = {
      name,
      startedAt: Date.now(),
      risk,
      input: update.rawInput ?? {},
      output: (update.content ?? []).map(toolContentToText).filter((line) => line.length > 0),
      paths: collectPaths(update.locations, update.content),
      finished: false,
    };
    this.#tools.set(callId, state);
    for (const path of state.paths) this.#turnPaths.add(path);

    const events: AgentEvent[] = [
      { type: 'tool_started', callId, name, input: state.input, risk },
    ];
    const side = terminalRefs(callId, update.content);

    // An agent may announce a call that is already finished.
    if (update.status === 'completed' || update.status === 'failed') {
      events.push(this.#finishTool(callId, update.status === 'failed'));
    }
    return { events, side };
  }

  #onToolCallUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
  ): Translation {
    const callId = update.toolCallId;
    const events: AgentEvent[] = [];
    let state = this.#tools.get(callId);

    if (!state) {
      // Some agents emit only updates. Synthesising the start keeps the
      // transcript coherent instead of showing a result with no call.
      const name = update.name ?? update.title ?? 'tool';
      state = {
        name,
        startedAt: Date.now(),
        risk: riskForToolKind(update.kind),
        input: update.rawInput ?? {},
        output: [],
        paths: new Set<string>(),
        finished: false,
      };
      this.#tools.set(callId, state);
      events.push({ type: 'tool_started', callId, name, input: state.input, risk: state.risk });
    }

    if (update.kind) state.risk = riskForToolKind(update.kind);
    if (update.rawInput !== undefined) state.input = update.rawInput;
    for (const line of (update.content ?? []).map(toolContentToText)) {
      if (line.length > 0) state.output.push(line);
    }
    for (const path of collectPaths(update.locations, update.content)) {
      state.paths.add(path);
      this.#turnPaths.add(path);
    }

    if (update.status === 'completed' || update.status === 'failed') {
      events.push(this.#finishTool(callId, update.status === 'failed'));
    }
    return { events, side: terminalRefs(callId, update.content) };
  }

  #finishTool(callId: string, isError: boolean): AgentEvent {
    const state = this.#tools.get(callId);
    if (!state) {
      return {
        type: 'tool_finished',
        callId,
        name: 'tool',
        output: '',
        isError,
        durationMs: 0,
      };
    }
    state.finished = true;
    return {
      type: 'tool_finished',
      callId,
      name: state.name,
      output: state.output.join('\n'),
      isError,
      durationMs: Date.now() - state.startedAt,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Permissions                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Turn an inbound `session/request_permission` into an `approval_requested`.
   *
   * The raw ACP options ride the side channel too. Agents offer choices Juno's
   * three-valued `ApprovalDecision` cannot name ("allow for this file",
   * "allow every edit under src/"), and a UI that wants to show them should not
   * have to re-fetch the request.
   */
  permissionRequested(request: RequestPermissionRequest): Translation {
    const callId = request.toolCall.toolCallId;
    const known = this.#tools.get(callId);
    const name = known?.name ?? request.toolCall.name ?? request.toolCall.title ?? 'tool';
    const risk = request.toolCall.kind ? riskForToolKind(request.toolCall.kind) : (known?.risk ?? 'command');

    const approval: ApprovalRequest = {
      callId,
      toolName: name,
      input: request.toolCall.rawInput ?? known?.input ?? {},
      risk,
      summary: request.toolCall.title ?? name,
    };
    return {
      events: [{ type: 'approval_requested', request: approval }],
      side: [{ type: 'permission_options', callId, options: request.options }],
    };
  }

  /**
   * Turn Juno's decision back into an ACP outcome.
   *
   * LOSSY, in both directions. `allow_always` maps to an `allow_always` option
   * when the agent offers one and degrades to `allow_once` when it does not —
   * which means the user's "always" only lasts the turn. That degradation is
   * surfaced in the returned `degraded` flag so the UI can avoid promising
   * something the agent will not honour. When the agent offers no option of the
   * requested polarity at all, the outcome is `cancelled`: inventing an
   * `optionId` the agent did not offer would be rejected anyway.
   */
  permissionResolved(
    request: RequestPermissionRequest,
    decision: ApprovalDecision,
  ): { outcome: RequestPermissionOutcome; events: readonly AgentEvent[]; degraded: boolean } {
    const callId = request.toolCall.toolCallId;
    const pick = selectPermissionOption(request.options, decision);
    const events: AgentEvent[] = [{ type: 'approval_resolved', callId, decision }];

    if (!pick) {
      return { outcome: { outcome: 'cancelled' }, events, degraded: true };
    }
    if (decision === 'deny') {
      const name = this.#tools.get(callId)?.name ?? request.toolCall.title ?? 'tool';
      events.push({ type: 'tool_denied', callId, name, reason: 'denied by the user' });
    }
    return {
      outcome: { outcome: 'selected', optionId: pick.option.optionId },
      events,
      degraded: pick.degraded,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Turn completion                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Close the turn.
   *
   * `stopReason` passes ACP's own string through unchanged — `AgentEvent`
   * declares it as a free string, so `end_turn`, `refusal` and
   * `max_turn_requests` survive intact rather than being flattened onto Juno's
   * vocabulary.
   *
   * `usage` comes only from `PromptResponse.usage`. It is NOT synthesised from
   * `usage_update`, which measures context-window occupancy rather than tokens
   * billed; an agent that reports no usage reports zeros, and the capability
   * manifest already says `usage` is unproven for that agent.
   */
  finishTurn(response: PromptResponse): readonly AgentEvent[] {
    const events: AgentEvent[] = [];

    const message = this.#flushAssistantMessage();
    if (message) events.push(message);

    // Any tool still open when the turn ends did not report a terminal status.
    for (const [callId, state] of this.#tools) {
      if (!state.finished) events.push(this.#finishTool(callId, response.stopReason !== 'end_turn'));
    }
    this.#tools.clear();

    if (this.#turnPaths.size > 0) {
      events.push({
        type: 'files_changed',
        turnIndex: this.#turnIndex,
        paths: [...this.#turnPaths].sort(),
      });
      this.#turnPaths.clear();
    }

    const usage: Usage = response.usage
      ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
      : { inputTokens: 0, outputTokens: 0 };

    events.push({
      type: 'turn_finished',
      turnIndex: this.#turnIndex,
      stopReason: response.stopReason,
      usage,
    });
    return events;
  }

  /** Transport or protocol failure. Always terminal for the turn. */
  failure(message: string): AgentEvent {
    return { type: 'error', message };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function collectPaths(
  locations: readonly { readonly path: string }[] | null | undefined,
  content: readonly ToolCallContent[] | null | undefined,
): Set<string> {
  const paths = new Set<string>();
  for (const location of locations ?? []) paths.add(location.path);
  for (const entry of content ?? []) {
    if (entry.type === 'diff') paths.add(entry.path);
  }
  return paths;
}

function terminalRefs(
  callId: string,
  content: readonly ToolCallContent[] | null | undefined,
): AcpSideEvent[] {
  const refs: AcpSideEvent[] = [];
  for (const entry of content ?? []) {
    if (entry.type === 'terminal') {
      refs.push({ type: 'terminal_reference', callId, terminalId: entry.terminalId });
    }
  }
  return refs;
}

/**
 * Choose the ACP option that best expresses a Juno decision.
 *
 * Exact kind first, then the nearest option of the same polarity. `degraded`
 * marks the fallback so the caller knows the user got something weaker than
 * they asked for.
 */
export function selectPermissionOption(
  options: readonly PermissionOption[],
  decision: ApprovalDecision,
): { option: PermissionOption; degraded: boolean } | null {
  const exact =
    decision === 'allow'
      ? 'allow_once'
      : decision === 'allow_always'
        ? 'allow_always'
        : 'reject_once';
  const direct = options.find((option) => option.kind === exact);
  if (direct) return { option: direct, degraded: false };

  const allowing = decision !== 'deny';
  const fallback = options.find((option) =>
    allowing
      ? option.kind === 'allow_once' || option.kind === 'allow_always'
      : option.kind === 'reject_once' || option.kind === 'reject_always',
  );
  return fallback ? { option: fallback, degraded: true } : null;
}
