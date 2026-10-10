/**
 * Alevr's own engine (agent-core) inside the env server (SPEC §2):
 *  - kind "alevr": inference through Alevr's backend proxy (/api/agent/<lab>)
 *    with the user's own Alevr session, so usage lands on their Alevr plan;
 *  - kind "byok": the same engine on the user's own API key, not billed by
 *    Alevr. Keys arrive with env.configure and live only in memory.
 *
 * The engine is loaded lazily from @juno/agent-core so the env server starts
 * (and its vendor adapters work) even when agent-core is not built; tests
 * inject a fake engine.
 */
import type {
  ApprovalRequestItem,
  CompactionItem,
  ProviderCapabilities,
  ProviderInstance,
  ProviderModel,
  ProviderSetupAction,
  ProviderSetupStep,
  RoleRouting,
  ModelSelection,
  RuntimeMode,
  InteractionMode,
  SubagentItem,
  TurnItem,
} from "../contracts/code-v2.js";
import { instanceKindOf, resolveModelAlias } from "../contracts/code-v2.js";
import { phaseOfRole } from "../mcp/team-brief.js";
import type {
  EnvSecrets,
  OpenSessionOptions,
  ProbeOptions,
  ProbeResult,
  ProviderAdapter,
  ProviderSession,
  TurnRequest,
  TurnResult,
  TurnSink,
} from "./types.js";
import { classifyUsageLimit } from "./limits.js";
import { describeError, type Logger } from "../util.js";
import { CROSS_CONVERSATION_PROMPT_SECTION } from "../conversations/policy.js";

// ── The slice of agent-core this adapter uses (structural, so no build-time dependency) ──

export type EnginePermissionMode = "plan" | "ask" | "auto-edit" | "full";
export type EngineDecision = "allow" | "allow_always" | "deny";

export interface EngineApprovalRequest {
  callId: string;
  toolName: string;
  input: unknown;
  risk: "safe" | "edit" | "command" | "sensitive";
  summary: string;
  agentId?: string;
  agentLabel?: string;
}

export type EngineEvent = { type: string; [key: string]: unknown };

export interface EngineSession {
  readonly sessionId: string;
  prompt(text: string): Promise<void>;
  abort(): void;
  setMode(mode: EnginePermissionMode): void;
  queueUserMessage(text: string): Promise<void>;
  rewindToTurn?(turnIndex: number): string[];
}

export interface EngineSessionOptions {
  provider: unknown;
  cwd: string;
  model?: string;
  mode?: EnginePermissionMode;
  callbacks: { onEvent(event: EngineEvent): void; requestApproval(request: EngineApprovalRequest): Promise<EngineDecision> };
  reasoningEffort?: string;
  /** Team lane: the thread's role routing, so the engine runs Plan → Build → Verify itself. */
  routing?: RoleRouting;
  /** How a role's selection becomes an engine adapter (Alevr and BYOK selections; others inherit). */
  resolveProvider?: (selection: ModelSelection) => { adapter: unknown; model: string; billable?: boolean } | null;
  /** Added to the engine's own tools (agent-core AgentOptions.extraTools). */
  extraTools?: unknown[];
  /** Constant system-prompt text for those tools (agent-core AgentOptions.systemAppendix). */
  systemAppendix?: string;
}

export interface AlevrEngine {
  createSession(options: EngineSessionOptions): EngineSession;
  resumeSession(id: string, options: EngineSessionOptions): EngineSession;
  /** Builds the agent-core ProviderAdapter for an instance + model, or throws a plain-language error. */
  providerFor(instance: ProviderInstance, model: string, secrets: EnvSecrets): unknown;
}

/** Loads agent-core from @juno/agent-core (runner/agent-core, built). */
export async function loadAgentCoreEngine(): Promise<AlevrEngine> {
  const core = (await import("@juno/agent-core" as string)) as Record<string, any>;
  return {
    createSession: (o) => core.AgentSession.create(o) as EngineSession,
    resumeSession: (id, o) => core.AgentSession.resume(id, o) as EngineSession,
    providerFor: (instance, model, secrets) => {
      const { lab } = splitModel(model);
      if (instance.kind === "alevr") {
        const backend = secrets.backend;
        if (!backend) throw new Error("Open Alevr and sign in so Code can use your Alevr plan.");
        const models = [...(backend.models ?? [])];
        const bare = splitModel(model).model;
        if (!models.some((m) => m.provider === lab && m.model === bare)) {
          models.push({ provider: lab, kind: lab === "anthropic" ? "anthropic" : "openai", model: bare, label: bare, available: true });
        }
        return core.createProxyProvider({ baseUrl: backend.baseUrl, cookie: "", authorization: backend.authorization, models }, `backend/${lab}`);
      }
      const byokLab = instance.id.startsWith("byok:") ? instance.id.slice(5) : lab;
      const key = secrets.byok.get(byokLab);
      if (!key) throw new Error(`Add your ${byokLab} API key in Alevr settings to use it here.`);
      if (byokLab === "anthropic") return new core.AnthropicAdapter(key.apiKey, key.baseUrl ? { baseURL: key.baseUrl } : undefined);
      const config = core.COMPAT_PROVIDERS?.[byokLab];
      if (!config) throw new Error(`Alevr's engine has no ${byokLab} adapter yet.`);
      return new core.OpenAICompatAdapter(key.baseUrl ? { ...config, baseUrl: key.baseUrl } : config, { apiKey: key.apiKey });
    },
  };
}

/** The contract role an engine child reports as (the engine sends `contractRole`; older builds only `role`). */
export function contractRoleOfEngine(role: string): SubagentItem["role"] {
  if (role === "explorer" || role === "reviewer" || role === "architect" || role === "orchestrator" || role === "compaction") return role;
  return phaseOfRole(role) === "plan" ? "architect" : "worker";
}

function isSelection(v: unknown): v is ModelSelection {
  return !!v && typeof v === "object" && typeof (v as ModelSelection).instanceId === "string" && typeof (v as ModelSelection).model === "string";
}

/** "anthropic:claude-opus-5-5" → { lab: "anthropic", model: "claude-opus-5-5" }; aliases resolved first. */
export function splitModel(id: string): { lab: string; model: string } {
  const canonical = resolveModelAlias(id);
  const i = canonical.indexOf(":");
  if (i <= 0) return { lab: "anthropic", model: canonical };
  return { lab: canonical.slice(0, i), model: canonical.slice(i + 1) };
}

export function engineMode(runtime: RuntimeMode, interaction: InteractionMode): EnginePermissionMode {
  if (interaction === "plan" || runtime === "read-only") return "plan";
  switch (runtime) {
    case "ask":
      return "ask";
    case "auto-edit":
    case "auto":
      return "auto-edit";
    case "full":
      return "full";
  }
}

export class AlevrEngineAdapter implements ProviderAdapter {
  readonly kind: "alevr" | "byok";
  #engine: AlevrEngine | undefined;
  readonly #loadEngine: () => Promise<AlevrEngine>;

  constructor(
    kind: "alevr" | "byok",
    private readonly secrets: EnvSecrets,
    options: { engine?: AlevrEngine; loadEngine?: () => Promise<AlevrEngine> } = {},
  ) {
    this.kind = kind;
    this.#engine = options.engine;
    this.#loadEngine = options.loadEngine ?? loadAgentCoreEngine;
  }

  async #get(): Promise<AlevrEngine> {
    this.#engine ??= await this.#loadEngine();
    return this.#engine;
  }

  capabilities(_instance: ProviderInstance): ProviderCapabilities {
    return {
      steering: true,
      queue: true,
      interrupt: true,
      resume: true,
      fork: false,
      rollback: true,
      planMode: true,
      // No model reviewer in the engine yet: "auto" runs as auto-edit, so it is not claimed.
      approvals: ["read-only", "ask", "auto-edit", "full"],
      subagents: true,
      computerUse: false,
      contextTiers: true,
      effortLevels: ["low", "medium", "high", "xhigh"],
      images: true,
      mcpInjection: false,
    };
  }

  setup(_instance: ProviderInstance, _action: ProviderSetupAction): ProviderSetupStep | null {
    // Alevr's own plan and BYOK keys are managed in Alevr's settings, not a terminal.
    return null;
  }

  async probe(instance: ProviderInstance, _options: ProbeOptions): Promise<ProbeResult> {
    if (this.kind === "alevr") {
      const backend = this.secrets.backend;
      if (!backend) return { status: "signed-out", statusMessage: "Open Alevr and sign in so Code can use your Alevr plan." };
      const models: ProviderModel[] = (backend.models ?? [])
        .filter((m) => m.available)
        .map((m) => {
          const model: ProviderModel = { id: `${m.provider}:${m.model}`, label: m.label };
          if (m.contextWindow) model.contextTiers = [{ tokens: m.contextWindow, label: `${Math.round(m.contextWindow / 1000)}K`, inputPerMTok: 0, outputPerMTok: 0 }];
          return model;
        });
      return { status: "ready", ...(models.length ? { models } : {}), account: { tokenSource: "alevr" } };
    }
    const lab = instance.id.startsWith("byok:") ? instance.id.slice(5) : undefined;
    if (!lab || !this.secrets.byok.has(lab)) return { status: "signed-out", statusMessage: "Add your API key in Alevr settings." };
    return { status: "ready", account: { tokenSource: "apiKey" } };
  }

  async openSession(instance: ProviderInstance, options: OpenSessionOptions): Promise<ProviderSession> {
    const engine = await this.#get();
    return new EngineBackedSession(engine, instance, options, this.secrets);
  }
}

interface EngineTurn {
  turnId: string;
  sink: TurnSink;
  assistantId?: string;
  assistantText: string;
  reasoningId?: string;
  reasoningText: string;
  tools: Map<string, TurnItem>;
  subagents: Map<string, string>;
  error?: { message: string; code?: string };
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  aborted?: boolean;
}

class EngineBackedSession implements ProviderSession {
  #session: EngineSession | undefined;
  #engineSessionId: string | undefined;
  #turn: EngineTurn | undefined;
  #model: string | undefined;
  /** The routing the live engine session was built with; a change rebuilds it. */
  #routingKey = "";
  #skillText = "";
  readonly #logger: Logger;
  readonly #extraTools: unknown[] | undefined;

  constructor(
    private readonly engine: AlevrEngine,
    private readonly instance: ProviderInstance,
    options: OpenSessionOptions,
    private readonly secrets: EnvSecrets,
  ) {
    this.#logger = options.logger;
    this.#extraTools = options.extraTools;
    const s = options.resumeState ?? {};
    if (typeof s.engineSessionId === "string") this.#engineSessionId = s.engineSessionId;
  }

  resumeState(): Record<string, unknown> {
    return this.#engineSessionId ? { engineSessionId: this.#engineSessionId } : {};
  }

  #ensure(request: TurnRequest): EngineSession {
    const model = splitModel(request.selection.model);
    const routingKey = request.routing && request.routing.preset !== "solo" ? JSON.stringify(request.routing) : "";
    // skills lane: the selected skills live in the system prompt, so a change
    // of skills resumes the same engine session under the new prompt.
    const skillText = request.skillInstructions?.trim() ?? "";
    if (this.#session && this.#model === request.selection.model && this.#routingKey === routingKey && this.#skillText === skillText) {
      this.#session.setMode(engineMode(request.runtimeMode, request.interactionMode));
      return this.#session;
    }
    const opts: EngineSessionOptions = {
      provider: this.engine.providerFor(this.instance, request.selection.model, this.secrets),
      cwd: request.cwd,
      model: model.model,
      mode: engineMode(request.runtimeMode, request.interactionMode),
      callbacks: {
        onEvent: (e) => this.#onEvent(e),
        requestApproval: (r) => this.#approve(r),
      },
      ...(request.selection.effort ? { reasoningEffort: request.selection.effort } : {}),
      ...(routingKey && request.routing ? { routing: request.routing, resolveProvider: (sel: ModelSelection) => this.#resolve(sel) } : {}),
      ...(this.#extraTools?.length ? { extraTools: this.#extraTools } : {}),
    };
    const appendix = [this.#extraTools?.length ? CROSS_CONVERSATION_PROMPT_SECTION : "", skillText].filter(Boolean).join("\n\n");
    if (appendix) opts.systemAppendix = appendix;
    let session: EngineSession;
    if (this.#engineSessionId) {
      try {
        session = this.engine.resumeSession(this.#engineSessionId, opts);
      } catch (error) {
        this.#logger.warn(`engine resume failed, new session: ${describeError(error)}`);
        session = this.engine.createSession(opts);
      }
    } else session = this.engine.createSession(opts);
    this.#session = session;
    this.#engineSessionId = session.sessionId;
    this.#model = request.selection.model;
    this.#routingKey = routingKey;
    this.#skillText = skillText;
    return session;
  }

  /**
   * A role's selection as an engine adapter. Alevr's engine serves Alevr and
   * BYOK selections; a subscription selection (Claude, Codex) cannot run
   * inside it, so that role inherits the lead's model and the engine says so.
   */
  #resolve(selection: ModelSelection): { adapter: unknown; model: string; billable?: boolean } | null {
    const kind = instanceKindOf(selection.instanceId);
    if (kind !== "alevr" && kind !== "byok") return null;
    try {
      const instance = selection.instanceId === this.instance.id ? this.instance : ({ ...this.instance, id: selection.instanceId, kind } as ProviderInstance);
      return { adapter: this.engine.providerFor(instance, selection.model, this.secrets), model: splitModel(selection.model).model, billable: kind === "alevr" };
    } catch (error) {
      this.#logger.warn(`team role ${selection.instanceId} · ${selection.model}: ${describeError(error)}`);
      return null;
    }
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    if (this.#turn) throw new Error("a turn is already running");
    let session: EngineSession;
    try {
      session = this.#ensure(request);
    } catch (error) {
      return { outcome: "failed", message: describeError(error) };
    }
    const turn: EngineTurn = { turnId: request.turnId, sink: request.sink, assistantText: "", reasoningText: "", tools: new Map(), subagents: new Map() };
    this.#turn = turn;
    const onAbort = () => {
      turn.aborted = true;
      session.abort();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(request.input.text);
      this.#closeText(turn);
      const usage = turn.usage;
      if (turn.error) {
        const limit = classifyUsageLimit({ message: turn.error.message, code: turn.error.code === "plan_limit" ? "usage_limit_reached" : turn.error.code });
        if (limit.limited || turn.error.code === "plan_limit") {
          return { outcome: "limited", message: turn.error.message, ...(limit.resetsAt ? { resumeAt: limit.resetsAt } : {}) };
        }
        if (turn.aborted) return { outcome: "interrupted" };
        return { outcome: "failed", message: turn.error.message };
      }
      return { outcome: turn.aborted ? "interrupted" : "completed", ...(usage ? { usage } : {}) };
    } catch (error) {
      this.#closeText(turn);
      if (turn.aborted) return { outcome: "interrupted" };
      return { outcome: "failed", message: describeError(error) };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      this.#turn = undefined;
    }
  }

  async steer(input: { text: string }): Promise<boolean> {
    if (!this.#turn || !this.#session) return false;
    void this.#session.queueUserMessage(input.text);
    return true;
  }

  async interrupt(): Promise<void> {
    if (this.#turn) this.#turn.aborted = true;
    this.#session?.abort();
  }

  async rewindTo(ordinal: number): Promise<boolean> {
    if (!this.#session?.rewindToTurn) return false;
    try {
      this.#session.rewindToTurn(ordinal);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.#session?.abort();
    this.#session = undefined;
  }

  async #approve(r: EngineApprovalRequest): Promise<EngineDecision> {
    const turn = this.#turn;
    if (!turn) return "deny";
    const action: ApprovalRequestItem["action"] = r.risk === "command" || r.toolName === "bash" ? "command" : r.risk === "edit" ? "file_change" : r.toolName.startsWith("computer") ? "computer" : "tool";
    const answer = await turn.sink.requestApproval({
      callId: r.callId,
      action,
      summary: r.summary || r.toolName,
      ...(r.agentLabel ? { detail: `Asked by ${r.agentLabel}` } : {}),
      options: ["accept", "acceptForSession", "decline", "cancel"],
    });
    if (answer.decision === "cancel") {
      void this.interrupt();
      return "deny";
    }
    return answer.decision === "accept" ? "allow" : answer.decision === "acceptForSession" ? "allow_always" : "deny";
  }

  #closeText(turn: EngineTurn): void {
    const sink = turn.sink;
    if (turn.assistantId) sink.item({ id: turn.assistantId, kind: "assistant_message", turnId: turn.turnId, createdAt: sink.now(), text: turn.assistantText, streaming: false });
    if (turn.reasoningId) sink.item({ id: turn.reasoningId, kind: "reasoning", turnId: turn.turnId, createdAt: sink.now(), text: turn.reasoningText, streaming: false });
    turn.assistantId = undefined;
    turn.reasoningId = undefined;
    turn.assistantText = "";
    turn.reasoningText = "";
  }

  #onEvent(e: EngineEvent): void {
    const turn = this.#turn;
    if (!turn) return;
    const sink = turn.sink;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    switch (e.type) {
      case "assistant_delta": {
        if (e.agentId) return;
        const text = str(e.text);
        if (!turn.assistantId) {
          turn.assistantId = sink.newItemId("msg");
          turn.assistantText = text;
          sink.item({ id: turn.assistantId, kind: "assistant_message", turnId: turn.turnId, createdAt: sink.now(), text, streaming: true });
        } else {
          turn.assistantText += text;
          sink.delta(turn.assistantId, "text", text);
        }
        return;
      }
      case "assistant_message": {
        if (e.agentId) return;
        const id = turn.assistantId ?? sink.newItemId("msg");
        sink.item({ id, kind: "assistant_message", turnId: turn.turnId, createdAt: sink.now(), text: str(e.text), streaming: false });
        turn.assistantId = undefined;
        turn.assistantText = "";
        return;
      }
      case "thinking_delta": {
        const text = str(e.text);
        if (!turn.reasoningId) {
          turn.reasoningId = sink.newItemId("think");
          turn.reasoningText = text;
          sink.item({ id: turn.reasoningId, kind: "reasoning", turnId: turn.turnId, createdAt: sink.now(), text, streaming: true });
        } else {
          turn.reasoningText += text;
          sink.delta(turn.reasoningId, "text", text);
        }
        return;
      }
      case "thinking_message": {
        const id = turn.reasoningId ?? sink.newItemId("think");
        sink.item({ id, kind: "reasoning", turnId: turn.turnId, createdAt: sink.now(), text: str(e.text), streaming: false });
        turn.reasoningId = undefined;
        turn.reasoningText = "";
        return;
      }
      case "tool_started": {
        if (e.agentId) return;
        // A tool call closes the streamed text before it.
        if (turn.assistantId) {
          sink.item({ id: turn.assistantId, kind: "assistant_message", turnId: turn.turnId, createdAt: sink.now(), text: turn.assistantText, streaming: false });
          turn.assistantId = undefined;
          turn.assistantText = "";
        }
        const item = engineToolItem(str(e.name), (e.input ?? {}) as Record<string, unknown>, str(e.callId), sink.newItemId("tool"), turn.turnId, sink.now());
        if (item) {
          turn.tools.set(str(e.callId), item);
          sink.item(item);
        }
        return;
      }
      case "tool_finished":
      case "tool_denied": {
        const prior = turn.tools.get(str(e.callId));
        if (!prior) return;
        const status = e.type === "tool_denied" ? "declined" : e.isError === true ? "failed" : "completed";
        const next = { ...prior, status } as TurnItem;
        if (next.kind === "command_execution") {
          if (typeof e.output === "string") next.output = e.output;
          if (typeof e.exitCode === "number") next.exitCode = e.exitCode;
          if (typeof e.durationMs === "number") next.durationMs = e.durationMs;
        }
        turn.tools.set(str(e.callId), next);
        sink.item(next);
        return;
      }
      case "context_compacted": {
        const item: CompactionItem = {
          id: sink.newItemId("compact"),
          kind: "compaction",
          turnId: turn.turnId,
          createdAt: sink.now(),
          beforeTokens: Number(e.tokensBefore ?? 0),
          afterTokens: Number(e.tokensAfter ?? 0),
          strategy: "summarize",
        };
        sink.item(item);
        return;
      }
      case "subagent_update": {
        const a = (e.agent ?? {}) as Record<string, unknown>;
        const agentId = str(a.id);
        if (!agentId) return;
        const id = turn.subagents.get(agentId) ?? sink.newItemId("agent");
        turn.subagents.set(agentId, id);
        const st = str(a.status);
        const item: SubagentItem = {
          id,
          kind: "subagent",
          turnId: turn.turnId,
          createdAt: sink.now(),
          agentId,
          role: contractRoleOfEngine(str(a.contractRole) || str(a.role)),
          model: isSelection(a.selection) ? a.selection : { instanceId: this.instance.id, model: str(a.model) || this.#model || "default" },
          status: st === "completed" || st === "done" ? "completed" : st === "failed" ? "failed" : st === "cancelled" || st === "interrupted" ? "interrupted" : st === "queued" ? "waiting" : "running",
          task: str(a.title),
          ...(typeof a.summary === "string" ? { closingText: a.summary } : {}),
          ...(a.phase === "plan" || a.phase === "build" || a.phase === "verify" ? { phase: a.phase } : {}),
          ...(str(a.label) ? { label: str(a.label), title: str(a.title) } : {}),
        };
        sink.item(item);
        return;
      }
      case "turn_finished": {
        const u = (e.usage ?? {}) as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
        turn.usage = { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, ...(u.cacheReadTokens ? { cachedInputTokens: u.cacheReadTokens } : {}) };
        sink.usage(turn.usage);
        return;
      }
      case "error":
        turn.error = { message: str(e.message) || "Alevr's engine reported an error.", ...(typeof e.code === "string" ? { code: e.code } : {}) };
        return;
      default:
        return;
    }
  }
}

export function engineToolItem(name: string, input: Record<string, unknown>, callId: string, itemId: string, turnId: string, now: string): TurnItem | undefined {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const base = { id: itemId, turnId, createdAt: now, callId };
  switch (name) {
    case "bash":
      return { ...base, kind: "command_execution", command: s(input.command) || "command", status: "running" };
    case "write_file":
    case "edit_file":
      return { ...base, kind: "file_change", status: "running", changes: [{ path: s(input.path) || s(input.file_path) || "file", change: name === "write_file" ? "add" : "modify" }] };
    case "read_file":
      return { ...base, kind: "search", query: s(input.path) || s(input.file_path), scope: "files", status: "running" };
    case "grep":
      return { ...base, kind: "search", query: s(input.pattern), scope: "content", status: "running" };
    case "glob":
      return { ...base, kind: "search", query: s(input.pattern), scope: "files", status: "running" };
    case "web_search":
    case "web_fetch":
      return { ...base, kind: "web_search", query: s(input.query) || s(input.url), status: "running" };
    default:
      return undefined;
  }
}
