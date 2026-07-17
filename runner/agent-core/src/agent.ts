import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  AssistantContent,
  ChatMessage,
  PermissionMode,
  Usage,
} from './types.js';
import type { ProviderAdapter } from './providers/types.js';
import type { ToolContext, ToolDefinition } from './tools/types.js';
import { PermissionEngine, classifyRisk } from './permissions.js';
import { CheckpointStore } from './checkpoints.js';
import { SessionStore } from './session.js';
import { defaultTools } from './tools/registry.js';
import type { UsageReporter } from './usage.js';

const MAX_STEPS_PER_TURN = 60;
const MEMORY_FILES = ['JUNO.md', 'AGENTS.md', 'CLAUDE.md'];

export interface AgentCallbacks {
  onEvent(event: AgentEvent): void;
  /** Surface-supplied approval UI. Resolves when the user decides. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface AgentOptions {
  provider: ProviderAdapter;
  cwd: string;
  model?: string;
  mode?: PermissionMode;
  tools?: ToolDefinition[];
  callbacks: AgentCallbacks;
  /** When set, each turn reserves + records against the account plan. */
  usageReporter?: UsageReporter;
}

function buildSystemPrompt(cwd: string, mode: PermissionMode): string {
  let memory = '';
  for (const name of MEMORY_FILES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) {
      memory = `\n\n# Project memory (${name})\n${fs.readFileSync(p, 'utf8').slice(0, 20_000)}`;
      break;
    }
  }
  return `You are Juno, an agentic coding assistant working directly in the user's repository.

Environment:
- Working directory: ${cwd}
- Platform: ${process.platform} (${os.release()})
- Date: ${new Date().toISOString().slice(0, 10)}

Operating rules:
- Use the tools to read code before editing it. Prefer edit_file for surgical changes; write_file only for new files or full rewrites.
- Verify your work: after making changes, run the project's own checks (build, tests, linter) with bash and fix what fails before finishing.
- Keep edits minimal and consistent with the surrounding code style.
- Tool calls are gated by user permission settings; a denied call means the user declined — adjust your approach rather than retrying the same call.
${mode === 'plan' ? '- You are in PLAN MODE: only read-only tools are available. Produce a concise numbered implementation plan and wait; do not attempt edits.' : ''}${memory}`;
}

export class AgentSession {
  readonly store: SessionStore;
  readonly cwd: string;
  model: string;
  mode: PermissionMode;
  private provider: ProviderAdapter;
  private tools: ToolDefinition[];
  private toolsByName: Map<string, ToolDefinition>;
  private permissions: PermissionEngine;
  private checkpoints: CheckpointStore;
  private messages: ChatMessage[];
  private callbacks: AgentCallbacks;
  private usageReporter?: UsageReporter;
  private aborter: AbortController | null = null;

  private constructor(store: SessionStore, opts: AgentOptions) {
    this.store = store;
    this.cwd = store.meta.cwd;
    this.model = store.meta.model;
    this.mode = store.meta.mode;
    this.provider = opts.provider;
    this.tools = opts.tools ?? defaultTools();
    this.toolsByName = new Map(this.tools.map((t) => [t.spec.name, t]));
    this.permissions = new PermissionEngine(this.cwd);
    this.checkpoints = new CheckpointStore(store.dir);
    this.messages = store.loadMessages();
    this.callbacks = opts.callbacks;
    this.usageReporter = opts.usageReporter;
  }

  static create(opts: AgentOptions): AgentSession {
    const model = opts.model ?? opts.provider.defaultModel;
    const store = SessionStore.create({
      cwd: opts.cwd,
      provider: opts.provider.id,
      model,
      mode: opts.mode ?? 'ask',
    });
    const session = new AgentSession(store, opts);
    session.emit({
      type: 'session_started',
      sessionId: store.id,
      cwd: session.cwd,
      provider: opts.provider.id,
      model,
      mode: session.mode,
    });
    return session;
  }

  static resume(id: string, opts: AgentOptions): AgentSession {
    const store = SessionStore.open(id);
    const session = new AgentSession(store, opts);
    if (opts.mode) session.setMode(opts.mode);
    session.emit({
      type: 'session_started',
      sessionId: store.id,
      cwd: session.cwd,
      provider: opts.provider.id,
      model: session.model,
      mode: session.mode,
    });
    return session;
  }

  get sessionId(): string {
    return this.store.id;
  }

  get turnCount(): number {
    return this.store.meta.turnCount;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.store.meta.mode = mode;
    this.store.saveMeta();
    this.emit({ type: 'mode_changed', mode });
  }

  abort(): void {
    this.aborter?.abort();
  }

  private emit(event: AgentEvent): void {
    this.store.appendEvent(event);
    this.callbacks.onEvent(event);
  }

  /** Run one full user turn: stream, execute tools with gating, until end_turn. */
  async prompt(text: string): Promise<void> {
    const turnIndex = this.store.meta.turnCount;
    if (this.store.meta.title === '(new session)') {
      this.store.meta.title = text.slice(0, 60);
    }
    this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    this.emit({ type: 'turn_started', turnIndex });
    this.aborter = new AbortController();

    // Reserve one message from the account plan (backend-connected sessions
    // only). A refused reservation stops the turn before any model call.
    if (this.usageReporter) {
      const reservation = await this.usageReporter.reserve();
      if (!reservation.allowed) {
        this.emit({
          type: 'error',
          message: reservation.message ?? "You've reached your plan's usage limit.",
        });
        this.store.meta.turnCount = turnIndex + 1;
        this.store.saveMeta();
        this.emit({
          type: 'turn_finished',
          turnIndex,
          stopReason: 'quota',
          usage: { inputTokens: 0, outputTokens: 0 },
        });
        return;
      }
    }

    const toolSpecs =
      this.mode === 'plan'
        ? this.tools.filter((t) => t.kind === 'read').map((t) => t.spec)
        : this.tools.map((t) => t.spec);

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason = 'end_turn';

    try {
      for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
        const assistantContent: AssistantContent[] = [];
        const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
        let textAcc = '';

        for await (const ev of this.provider.stream({
          model: this.model,
          system: buildSystemPrompt(this.cwd, this.mode),
          messages: this.messages,
          tools: toolSpecs,
          signal: this.aborter.signal,
        })) {
          if (ev.type === 'text_delta') {
            textAcc += ev.text;
            this.callbacks.onEvent({ type: 'assistant_delta', text: ev.text });
          } else if (ev.type === 'tool_call') {
            toolCalls.push({
              id: ev.id,
              name: ev.name,
              input: (ev.input ?? {}) as Record<string, unknown>,
            });
          } else if (ev.type === 'done') {
            usage = {
              inputTokens: usage.inputTokens + ev.usage.inputTokens,
              outputTokens: usage.outputTokens + ev.usage.outputTokens,
            };
            stopReason = ev.stopReason;
          }
        }

        if (textAcc) {
          assistantContent.push({ type: 'text', text: textAcc });
          this.emit({ type: 'assistant_message', text: textAcc });
        }
        for (const call of toolCalls) {
          assistantContent.push({ type: 'tool_call', id: call.id, name: call.name, input: call.input });
        }
        if (assistantContent.length > 0) {
          this.messages.push({ role: 'assistant', content: assistantContent });
        }
        this.store.saveMessages(this.messages);

        if (stopReason !== 'tool_use' || toolCalls.length === 0) break;

        const results: ChatMessage = { role: 'user', content: [] };
        for (const call of toolCalls) {
          const result = await this.executeToolCall(turnIndex, call);
          results.content.push(result);
        }
        this.messages.push(results);
        this.store.saveMessages(this.messages);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', message });
      stopReason = 'error';
    }

    const changed = this.checkpoints.changedPaths(turnIndex);
    if (changed.length > 0) {
      this.emit({ type: 'files_changed', turnIndex, paths: changed });
    }
    // Reconcile the reserved message: record real tokens on a productive turn,
    // or refund the reservation when the turn produced nothing (provider error,
    // abort before output) so a failed turn never silently burns quota.
    if (this.usageReporter) {
      if (usage.inputTokens > 0 || usage.outputTokens > 0) {
        await this.usageReporter.record(this.model, usage).catch(() => {});
      } else {
        await this.usageReporter.refund().catch(() => {});
      }
    }
    this.store.meta.turnCount = turnIndex + 1;
    this.store.saveMeta();
    this.emit({ type: 'turn_finished', turnIndex, stopReason, usage });
  }

  private async executeToolCall(
    turnIndex: number,
    call: { id: string; name: string; input: Record<string, unknown> },
  ): Promise<{ type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      return { type: 'tool_result', toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    }
    const { risk, reason } = classifyRisk(tool, call.input);
    const outcome = this.permissions.decide(this.mode, call.name, risk);

    if (outcome === 'deny') {
      const why =
        this.mode === 'plan'
          ? 'Denied: plan mode only allows read-only tools.'
          : `Denied by project permission rules.`;
      this.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: why });
      return { type: 'tool_result', toolCallId: call.id, content: why, isError: true };
    }

    if (outcome === 'ask') {
      const request: ApprovalRequest = {
        callId: call.id,
        toolName: call.name,
        input: call.input,
        risk,
        summary: `${tool.summarize(call.input)}${risk === 'sensitive' ? ` — SENSITIVE (${reason})` : ''}`,
      };
      this.emit({ type: 'approval_requested', request });
      const decision = await this.callbacks.requestApproval(request);
      this.emit({ type: 'approval_resolved', callId: call.id, decision });
      if (decision === 'deny') {
        const msg = 'The user declined this action.';
        this.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: msg });
        return { type: 'tool_result', toolCallId: call.id, content: msg, isError: true };
      }
      if (decision === 'allow_always' && risk !== 'sensitive') {
        this.permissions.grantAlways(call.name);
      }
    }

    const ctx: ToolContext = { cwd: this.cwd };
    for (const abs of tool.mutatedPaths?.(call.input, ctx) ?? []) {
      this.checkpoints.snapshot(turnIndex, abs);
    }

    this.emit({ type: 'tool_started', callId: call.id, name: call.name, input: call.input, risk });
    const started = Date.now();
    let output: string;
    let isError = false;
    try {
      const result = await tool.execute(call.input, ctx);
      output = result.output;
      isError = result.isError ?? false;
    } catch (err) {
      output = `Tool crashed: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    this.emit({
      type: 'tool_finished',
      callId: call.id,
      name: call.name,
      output: output.length > 2000 ? output.slice(0, 2000) + '…' : output,
      isError,
      durationMs: Date.now() - started,
    });
    return { type: 'tool_result', toolCallId: call.id, content: output, isError };
  }

  /** Undo everything the previous turn changed on disk. Returns restored paths. */
  undoLastTurn(): string[] {
    const turns = this.checkpoints.turnsWithChanges();
    if (turns.length === 0) return [];
    return this.checkpoints.restoreToBefore(turns[turns.length - 1]);
  }

  /** Rewind the workspace to its state before the given turn. */
  rewindToTurn(turnIndex: number): string[] {
    return this.checkpoints.restoreToBefore(turnIndex);
  }

  diffSinceTurn(turnIndex = 0): string {
    return this.checkpoints.diffSince(turnIndex, this.cwd);
  }
}
