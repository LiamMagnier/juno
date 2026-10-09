/**
 * Claude adapter: the user's own `claude` CLI driven through the Claude Agent
 * SDK (SPEC §2). Shown as "Claude (your subscription)". Alevr never offers a
 * claude.ai login, never reads the CLI's credential and never routes a
 * request through Alevr's servers: the SDK spawns the user's own binary
 * (`pathToClaudeCodeExecutable`), which talks to Anthropic with its own
 * sign-in and draws on the user's own plan limits.
 *
 * Shape (after T3 Code's ClaudeAdapterV2 / ClaudeProvider, MIT, re-implemented):
 *  - one long-lived `query()` per Alevr session whose prompt is a queue, so a
 *    turn is a push and steering is another push while the turn runs;
 *  - `canUseTool` maps to Alevr approvals: accept → allow(updatedInput),
 *    acceptForSession → allow + the CLI's suggested session rules,
 *    decline → deny, cancel → deny + interrupt; ExitPlanMode becomes a plan
 *    item awaiting the user and is denied; AskUserQuestion becomes a
 *    user_input_request whose answers go back as updatedInput;
 *  - runtime modes: plan→plan, ask→default, auto-edit→acceptEdits,
 *    auto→auto, full→bypassPermissions;
 *  - per-instance CLAUDE_CONFIG_DIR, never HOME (the keychain lives under HOME);
 *  - the health probe is a query whose prompt never yields: the CLI answers
 *    initialize (account, models) without ever calling the API; hooks and MCP
 *    are disabled, the session is not persisted, and it is aborted after 25 s.
 */
import type {
  CanUseTool,
  Options as ClaudeOptions,
  PermissionMode as ClaudePermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalRequestItem,
  EffortLevel,
  InteractionMode,
  ItemStatus,
  ProviderCapabilities,
  ProviderInstance,
  ProviderModel,
  ProviderSetupAction,
  ProviderSetupStep,
  RuntimeMode,
  SessionUsage,
  TurnItem,
  UsageWindow,
  UserInput,
} from "../contracts/code-v2.js";
import { RUNTIME_MODE_VENDOR_MAP } from "../contracts/code-v2.js";
import { classifyUsageLimit, earliestExhaustedReset, normalizeReset } from "./limits.js";
import { claudeSetup } from "./presets.js";
import { readVersion } from "./detect.js";
import { vendorEnv } from "./vendor-env.js";
import type {
  McpEndpoint,
  OpenSessionOptions,
  ProbeOptions,
  ProbeResult,
  ProviderAdapter,
  ProviderSession,
  TurnRequest,
  TurnResult,
  TurnSink,
} from "./types.js";
import { AsyncQueue, deferred, describeError, randomUUID, type Deferred, type Logger } from "../util.js";

export type ClaudeQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeOptions }) => Query;

export const PROBE_TIMEOUT_MS = 25_000;

const ALEVR_APPEND = [
  "You are running inside Alevr Code on the user's own machine, with the user's own Claude subscription.",
  "When the `alevr` MCP server is available it can start subagents on any model the user has connected (spawn_subagent, wait_subagent, list_subagents, cancel_subagent) and search earlier threads (search_threads). Prefer it over your own Task tool when the user asks for a specific model or provider.",
].join("\n");

async function loadQuery(): Promise<ClaudeQueryFn> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query as unknown as ClaudeQueryFn;
}

export function claudePermissionMode(runtime: RuntimeMode, interaction: InteractionMode): ClaudePermissionMode {
  if (interaction === "plan" || runtime === "read-only") return "plan";
  return RUNTIME_MODE_VENDOR_MAP[runtime].claudePermissionMode;
}

export function claudeEffort(effort: EffortLevel | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!effort) return undefined;
  if (effort === "none" || effort === "minimal") return "low";
  return effort;
}

/** Probe options exactly as the health check uses them (exported for tests). */
export function buildProbeOptions(instance: ProviderInstance, abortController: AbortController, cwd?: string): ClaudeOptions {
  const env = vendorEnv(instance, "CLAUDE_CONFIG_DIR");
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: instance.binaryPath,
    abortController,
    settingSources: ["user", "project", "local"],
    // The probe runs on a timer: it must never run the user's SessionStart hooks.
    settings: { disableAllHooks: true },
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...env,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(cwd ? { cwd } : {}),
    stderr: () => {},
  };
}

export class ClaudeAgentAdapter implements ProviderAdapter {
  readonly kind = "claude-agent" as const;
  #queryFn: ClaudeQueryFn | undefined;

  constructor(options: { queryFn?: ClaudeQueryFn } = {}) {
    this.#queryFn = options.queryFn;
  }

  async #query(): Promise<ClaudeQueryFn> {
    this.#queryFn ??= await loadQuery();
    return this.#queryFn;
  }

  capabilities(instance: ProviderInstance): ProviderCapabilities {
    const efforts = new Set<EffortLevel>();
    for (const m of instance.models ?? []) for (const e of m.effortLevels ?? []) efforts.add(e);
    return {
      steering: true,
      queue: true,
      interrupt: true,
      resume: true,
      fork: false,
      rollback: true,
      planMode: true,
      approvals: ["read-only", "ask", "auto-edit", "auto", "full"],
      subagents: true,
      computerUse: false,
      contextTiers: false,
      effortLevels: efforts.size ? [...efforts] : ["low", "medium", "high", "xhigh", "max"],
      images: true,
      mcpInjection: true,
    };
  }

  setup(instance: ProviderInstance, action: ProviderSetupAction): ProviderSetupStep | null {
    return claudeSetup(instance, action);
  }

  async probe(instance: ProviderInstance, options: ProbeOptions): Promise<ProbeResult> {
    if (!instance.binaryPath) return { status: "not-installed", statusMessage: "Claude is not installed on this Mac." };
    const version = await readVersion(instance.binaryPath);
    const queryFn = await this.#query();
    const abort = new AbortController();
    const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref?.();
    // Never yields: no user message ever reaches the CLI, so no API request is made.
    const neverYields = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    })();
    let q: Query | undefined;
    try {
      q = queryFn({ prompt: neverYields, options: buildProbeOptions(instance, abort, options.cwd) });
      const init = await Promise.race([
        q.initializationResult(),
        new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("Claude did not answer within 25 seconds.")), { once: true })),
      ]);
      const account = (init.account ?? {}) as { email?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string; apiProvider?: string };
      const result: ProbeResult = { ...(version ? { version } : {}) };
      const signedIn = !!(account.email || account.subscriptionType || (account.tokenSource && account.tokenSource !== "none") || (account.apiKeySource && account.apiKeySource !== "none") || (account.apiProvider && account.apiProvider !== "firstParty"));
      if (!signedIn) {
        return { ...result, status: "signed-out", statusMessage: "Sign in to Claude to use your subscription here." };
      }
      result.account = {
        ...(account.email ? { email: account.email } : {}),
        ...(account.subscriptionType ? { plan: account.subscriptionType } : {}),
        tokenSource: account.subscriptionType ? "claude.ai" : account.apiKeySource && account.apiKeySource !== "none" ? "apiKey" : (account.apiProvider ?? account.tokenSource ?? "unknown"),
      };
      const models = (init.models ?? []).map(claudeModel);
      if (models.length) result.models = models;
      const usage = await Promise.race([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 6000).unref?.()),
      ]);
      const windows = usage?.rate_limits ? claudeLimitWindows(usage.rate_limits as Record<string, unknown>) : [];
      if (windows.length) result.limits = windows;
      const reset = earliestExhaustedReset(windows);
      result.status = reset ? "limited" : "ready";
      if (reset) result.statusMessage = "Your Claude usage limit is reached.";
      return result;
    } catch (error) {
      const message = describeError(error);
      if (/not logged in|login|authenticate|unauthori[sz]ed|401/i.test(message)) {
        return { ...(version ? { version } : {}), status: "signed-out", statusMessage: "Sign in to Claude to use your subscription here." };
      }
      return { ...(version ? { version } : {}), status: "error", statusMessage: message };
    } finally {
      clearTimeout(timer);
      if (!abort.signal.aborted) abort.abort();
      try {
        q?.close();
      } catch {
        /* closed */
      }
    }
  }

  async openSession(instance: ProviderInstance, options: OpenSessionOptions): Promise<ProviderSession> {
    if (!instance.binaryPath) throw new Error("Claude is not installed on this Mac.");
    return new ClaudeSession(instance, options, await this.#query());
  }
}

function claudeModel(m: { value: string; displayName?: string; supportedEffortLevels?: string[]; supportsFastMode?: boolean }): ProviderModel {
  const model: ProviderModel = { id: m.value, label: m.displayName || m.value };
  const efforts = (m.supportedEffortLevels ?? []).filter((e): e is EffortLevel => ["low", "medium", "high", "xhigh", "max"].includes(e));
  if (efforts.length) model.effortLevels = efforts;
  if (m.supportsFastMode) model.supportsFast = true;
  if (m.value === "default") model.isDefault = true;
  return model;
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_overage_included: "Weekly · included",
};

export function claudeLimitWindows(rateLimits: Record<string, unknown>): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const [id, value] of Object.entries(rateLimits)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const w = value as { utilization?: number | null; resets_at?: string | null };
    if (typeof w.utilization !== "number") continue;
    const window: UsageWindow = { id, label: WINDOW_LABELS[id] ?? id.replace(/_/g, " "), usedPct: Math.max(0, Math.min(100, w.utilization)) };
    const reset = normalizeReset(w.resets_at ?? undefined);
    if (reset) window.resetsAt = reset;
    out.push(window);
  }
  return out;
}

interface ToolEntry {
  itemId: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeTurn {
  turnId: string;
  sink: TurnSink;
  done: Deferred<TurnResult>;
  /** Prompts pushed for this turn that the CLI has not consumed yet. */
  awaiting: Set<string>;
  /** stream index → our item id for the block being streamed. */
  streaming: Map<number, string>;
  tools: Map<string, ToolEntry>;
  limited?: { resumeAt?: string; message?: string };
  planCaptured?: boolean;
  lastAssistantUuid?: string;
}

class ClaudeSession implements ProviderSession {
  #q: Query | undefined;
  #prompts: AsyncQueue<SDKUserMessage> | undefined;
  #abort: AbortController | undefined;
  #turn: ClaudeTurn | undefined;
  #claudeSessionId: string | undefined;
  #resumeAt: string | undefined;
  /** last assistant message uuid at the end of each turn, by ordinal - 1. */
  #turnEnds: string[] = [];
  #mode: ClaudePermissionMode | undefined;
  #model: string | undefined;
  readonly #logger: Logger;

  constructor(
    private readonly instance: ProviderInstance,
    private readonly options: OpenSessionOptions,
    private readonly queryFn: ClaudeQueryFn,
  ) {
    this.#logger = options.logger;
    const s = options.resumeState ?? {};
    if (typeof s.claudeSessionId === "string") this.#claudeSessionId = s.claudeSessionId;
    if (Array.isArray(s.turnEnds)) this.#turnEnds = s.turnEnds.filter((t): t is string => typeof t === "string");
    if (typeof s.resumeSessionAt === "string") this.#resumeAt = s.resumeSessionAt;
  }

  resumeState(): Record<string, unknown> {
    return {
      ...(this.#claudeSessionId ? { claudeSessionId: this.#claudeSessionId } : {}),
      turnEnds: this.#turnEnds,
      ...(this.#resumeAt ? { resumeSessionAt: this.#resumeAt } : {}),
    };
  }

  #ensureQuery(request: TurnRequest): void {
    if (this.#q) return;
    const mode = claudePermissionMode(request.runtimeMode, request.interactionMode);
    const prompts = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    const effort = claudeEffort(request.selection.effort);
    const options: ClaudeOptions = {
      cwd: request.cwd,
      pathToClaudeCodeExecutable: this.instance.binaryPath,
      env: vendorEnv(this.instance, "CLAUDE_CONFIG_DIR"),
      abortController: abort,
      includePartialMessages: true,
      permissionMode: mode,
      ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: this.#canUseTool,
      ...(request.selection.model && request.selection.model !== "default" ? { model: request.selection.model } : {}),
      ...(effort ? { effort } : {}),
      thinking: { type: "adaptive", display: "summarized" },
      systemPrompt: { type: "preset", preset: "claude_code", append: ALEVR_APPEND },
      settingSources: ["user", "project", "local"],
      ...(this.options.mcp ? { mcpServers: { [this.options.mcp.name]: mcpConfig(this.options.mcp) } } : {}),
      ...(this.#claudeSessionId ? { resume: this.#claudeSessionId } : {}),
      ...(this.#claudeSessionId && this.#resumeAt ? { resumeSessionAt: this.#resumeAt } : {}),
      stderr: (data: string) => this.#logger.debug(`claude: ${data.trim().slice(0, 500)}`),
    };
    this.#mode = mode;
    this.#model = request.selection.model;
    this.#prompts = prompts;
    this.#abort = abort;
    this.#q = this.queryFn({ prompt: prompts, options });
    this.#resumeAt = undefined;
    void this.#consume(this.#q);
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    if (this.#turn) throw new Error("a Claude turn is already running");
    this.#ensureQuery(request);
    const q = this.#q!;
    const mode = claudePermissionMode(request.runtimeMode, request.interactionMode);
    if (mode !== this.#mode) {
      await q.setPermissionMode(mode).catch((e) => this.#logger.warn(`setPermissionMode: ${describeError(e)}`));
      this.#mode = mode;
    }
    if (request.selection.model !== this.#model) {
      await q.setModel(request.selection.model === "default" ? undefined : request.selection.model).catch((e) => this.#logger.warn(`setModel: ${describeError(e)}`));
      this.#model = request.selection.model;
    }
    const turn: ClaudeTurn = {
      turnId: request.turnId,
      sink: request.sink,
      done: deferred<TurnResult>(),
      awaiting: new Set(),
      streaming: new Map(),
      tools: new Map(),
    };
    this.#turn = turn;
    const onAbort = () => void this.interrupt();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.#push(request.input, turn, "next");
      const result = await turn.done.promise;
      if (turn.lastAssistantUuid) this.#turnEnds[request.turnOrdinal - 1] = turn.lastAssistantUuid;
      return result;
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      this.#turn = undefined;
    }
  }

  async steer(input: UserInput): Promise<boolean> {
    const turn = this.#turn;
    if (!turn || !this.#prompts) return false;
    this.#push(input, turn, "now");
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this.#q) return;
    await this.#q.interrupt().catch((e) => this.#logger.warn(`claude interrupt: ${describeError(e)}`));
  }

  async rewindTo(ordinal: number): Promise<boolean> {
    if (ordinal === 0) {
      this.#claudeSessionId = undefined;
      this.#turnEnds = [];
    } else {
      const at = this.#turnEnds[ordinal - 1];
      if (!at) return false;
      this.#resumeAt = at;
      this.#turnEnds = this.#turnEnds.slice(0, ordinal);
    }
    await this.#stopQuery();
    return true;
  }

  async close(): Promise<void> {
    await this.#stopQuery();
  }

  async #stopQuery(): Promise<void> {
    this.#prompts?.end();
    try {
      this.#q?.close();
    } catch {
      /* closed */
    }
    this.#abort?.abort();
    this.#q = undefined;
    this.#prompts = undefined;
  }

  #push(input: UserInput, turn: ClaudeTurn, priority: "now" | "next"): void {
    const uuid = randomUUID();
    turn.awaiting.add(uuid);
    const content: Array<Record<string, unknown>> = [{ type: "text", text: input.text }];
    this.#prompts!.push({
      type: "user",
      message: { role: "user", content: content as never },
      parent_tool_use_id: null,
      priority,
      uuid: uuid as never,
      ...(this.#claudeSessionId ? { session_id: this.#claudeSessionId } : {}),
    } as SDKUserMessage);
  }

  // ── Permissions ─────────────────────────────────────────────────────────

  #canUseTool: CanUseTool = async (toolName, input, options) => {
    const turn = this.#turn;
    if (!turn) return { behavior: "deny", message: "No turn is running." };
    const sink = turn.sink;
    const toolUseId = (options as { toolUseID?: string }).toolUseID ?? randomUUID();

    if (toolName === "ExitPlanMode") {
      const plan = typeof input.plan === "string" ? input.plan : "";
      turn.planCaptured = true;
      sink.item({
        id: sink.newItemId("plan"),
        kind: "plan",
        turnId: turn.turnId,
        createdAt: sink.now(),
        text: plan,
        awaitingApproval: true,
      });
      return { behavior: "deny", message: "The plan is shown to the user in Alevr. Wait for them to approve it before making changes." };
    }

    if (toolName === "AskUserQuestion") {
      const questions = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
      const answer = await sink.requestUserInput({
        questions: questions.map((q, i) => ({
          id: String(q.header ?? q.question ?? i),
          prompt: String(q.question ?? q.header ?? ""),
          ...(Array.isArray(q.options) ? { options: (q.options as { label?: string }[]).map((o) => String(o.label ?? "")) } : {}),
          ...(q.multiSelect === true ? { multiSelect: true } : {}),
        })),
      });
      if (answer.decision === "cancel" || answer.decision === "decline") {
        return { behavior: "deny", message: "The user dismissed the question.", ...(answer.decision === "cancel" ? { interrupt: true } : {}) };
      }
      const answers: Record<string, string> = {};
      questions.forEach((q, i) => {
        const id = String(q.header ?? q.question ?? i);
        const picked = answer.answers?.[id];
        if (picked?.length) answers[String(q.question ?? id)] = picked.join(", ");
      });
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }

    const entry = turn.tools.get(toolUseId);
    const answer = await sink.requestApproval({
      callId: toolUseId,
      action: approvalAction(toolName),
      summary: summarizeTool(toolName, input),
      ...(typeof (options as { decisionReason?: string }).decisionReason === "string" ? { justification: (options as { decisionReason?: string }).decisionReason } : {}),
      ...(typeof input.description === "string" && !entry ? { detail: input.description } : {}),
      options: options.suggestions?.length ? ["accept", "acceptForSession", "decline", "cancel"] : ["accept", "decline", "cancel"],
    });
    switch (answer.decision) {
      case "accept":
        return { behavior: "allow", updatedInput: answer.updatedInput ?? input } satisfies PermissionResult;
      case "acceptForSession":
        return {
          behavior: "allow",
          updatedInput: answer.updatedInput ?? input,
          ...(options.suggestions?.length ? { updatedPermissions: options.suggestions } : {}),
        };
      case "decline":
        return { behavior: "deny", message: "The user declined this action." };
      default:
        return { behavior: "deny", message: "The user stopped the turn.", interrupt: true };
    }
  };

  /** Claude's own Task subagents run on this same instance. */
  #own(item: TurnItem): TurnItem {
    return item.kind === "subagent" ? { ...item, model: { ...item.model, instanceId: this.instance.id } } : item;
  }

  // ── Message stream ─────────────────────────────────────────────────────

  async #consume(q: Query): Promise<void> {
    try {
      for await (const message of q) this.#onMessage(message);
      this.#turn?.done.resolve({ outcome: "failed", message: "Claude ended the session." });
    } catch (error) {
      const turn = this.#turn;
      const message = describeError(error);
      const limit = classifyUsageLimit({ message });
      if (turn) {
        if (limit.limited) turn.done.resolve({ outcome: "limited", message, ...(limit.resetsAt ? { resumeAt: limit.resetsAt } : {}) });
        else if (/abort/i.test(message)) turn.done.resolve({ outcome: "interrupted" });
        else turn.done.resolve({ outcome: "failed", message });
      }
    } finally {
      if (this.#q === q) {
        this.#q = undefined;
        this.#prompts = undefined;
      }
    }
  }

  #onMessage(message: SDKMessage): void {
    const m = message as SDKMessage & Record<string, unknown>;
    if (typeof m.session_id === "string" && m.session_id) this.#claudeSessionId = m.session_id;
    const turn = this.#turn;
    switch (m.type) {
      case "rate_limit_event": {
        const info = (m as { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number } }).rate_limit_info;
        if (!info) return;
        const id = info.rateLimitType ?? "five_hour";
        const window: UsageWindow = { id, label: WINDOW_LABELS[id] ?? id };
        if (typeof info.utilization === "number") window.usedPct = Math.max(0, Math.min(100, info.utilization <= 1 ? info.utilization * 100 : info.utilization));
        if (info.status === "rejected") window.usedPct = 100;
        const reset = normalizeReset(info.resetsAt);
        if (reset) window.resetsAt = reset;
        turn?.sink.limits([window]);
        if (info.status === "rejected" && turn) turn.limited = { ...(reset ? { resumeAt: reset } : {}), message: "Your Claude usage limit is reached." };
        return;
      }
      case "stream_event":
        if (turn && (m as { parent_tool_use_id?: string | null }).parent_tool_use_id == null) this.#onStreamEvent(turn, (m as unknown as { event: Record<string, unknown> }).event);
        return;
      case "assistant":
        if (turn) this.#onAssistant(turn, m as unknown as { message: { content?: Record<string, unknown>[] }; parent_tool_use_id: string | null; uuid?: string; error?: unknown });
        return;
      case "user":
        if (turn) this.#onUser(turn, m as unknown as { message: { content?: unknown }; parent_tool_use_id: string | null });
        return;
      case "result":
        if (turn) this.#onResult(turn, m as unknown as Record<string, unknown>);
        return;
      default:
        return;
    }
  }

  #onStreamEvent(turn: ClaudeTurn, event: Record<string, unknown>): void {
    const sink = turn.sink;
    const index = typeof event.index === "number" ? event.index : -1;
    if (event.type === "message_start") {
      turn.streaming.clear();
      return;
    }
    if (event.type === "content_block_start") {
      const block = event.content_block as { type?: string } | undefined;
      if (block?.type === "text" || block?.type === "thinking") {
        const id = sink.newItemId(block.type === "text" ? "msg" : "think");
        turn.streaming.set(index, id);
        sink.item(
          block.type === "text"
            ? { id, kind: "assistant_message", turnId: turn.turnId, createdAt: sink.now(), text: "", streaming: true }
            : { id, kind: "reasoning", turnId: turn.turnId, createdAt: sink.now(), text: "", streaming: true, summary: true },
        );
      }
      return;
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined;
      const id = turn.streaming.get(index);
      if (!id || !delta) return;
      if (delta.type === "text_delta" && delta.text) sink.delta(id, "text", delta.text);
      if (delta.type === "thinking_delta" && delta.thinking) sink.delta(id, "text", delta.thinking);
    }
  }

  #onAssistant(turn: ClaudeTurn, m: { message: { content?: Record<string, unknown>[] }; parent_tool_use_id: string | null; uuid?: string; error?: unknown }): void {
    if (m.parent_tool_use_id) return; // Claude's own Task subagent internals.
    if (m.uuid) turn.lastAssistantUuid = m.uuid;
    const sink = turn.sink;
    const blocks = m.message?.content ?? [];
    // Streamed blocks arrive here again complete; map them by position onto the streamed items.
    const streamed = [...turn.streaming.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
    let s = 0;
    for (const block of blocks) {
      if (block.type === "text" || block.type === "thinking") {
        const text = String(block.type === "text" ? (block.text ?? "") : (block.thinking ?? ""));
        const id = streamed[s++] ?? sink.newItemId(block.type === "text" ? "msg" : "think");
        sink.item(
          block.type === "text"
            ? { id, kind: "assistant_message", turnId: turn.turnId, createdAt: sink.now(), text, streaming: false }
            : { id, kind: "reasoning", turnId: turn.turnId, createdAt: sink.now(), text, streaming: false, summary: true },
        );
        if (block.type === "text") {
          const limit = classifyUsageLimit({ message: text });
          if (limit.limited && m.error) turn.limited = { ...(limit.resetsAt ? { resumeAt: limit.resetsAt } : {}), message: text };
        }
      } else if (block.type === "tool_use") {
        const id = String(block.id ?? randomUUID());
        const input = (block.input ?? {}) as Record<string, unknown>;
        const name = String(block.name ?? "tool");
        const itemId = sink.newItemId("tool");
        turn.tools.set(id, { itemId, name, input });
        const item = toolItem(name, input, id, itemId, turn.turnId, sink.now(), "running");
        if (item) sink.item(this.#own(item));
      }
    }
    turn.streaming.clear();
  }

  #onUser(turn: ClaudeTurn, m: { message: { content?: unknown }; parent_tool_use_id: string | null }): void {
    if (m.parent_tool_use_id) return;
    const content = Array.isArray(m.message?.content) ? (m.message.content as Record<string, unknown>[]) : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const entry = turn.tools.get(String(block.tool_use_id));
      if (!entry) continue;
      const output = toolResultText(block.content);
      const failed = block.is_error === true;
      const denied = failed && /declined|denied|user (?:rejected|stopped)|plan is shown/i.test(output);
      const item = toolItem(entry.name, entry.input, String(block.tool_use_id), entry.itemId, turn.turnId, turn.sink.now(), denied ? "declined" : failed ? "failed" : "completed", output);
      if (item) turn.sink.item(this.#own(item));
    }
  }

  #onResult(turn: ClaudeTurn, m: Record<string, unknown>): void {
    const consumed = Array.isArray(m.user_message_uuids) ? (m.user_message_uuids as string[]) : typeof m.user_message_uuid === "string" ? [m.user_message_uuid] : [];
    for (const id of consumed) turn.awaiting.delete(id);
    if (consumed.length === 0) turn.awaiting.clear();
    const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    let usage: SessionUsage | undefined;
    if (u) {
      usage = {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cachedInputTokens: u.cache_read_input_tokens ?? 0,
      };
      turn.sink.usage(usage);
    }
    // More pushed prompts still to run as part of this turn (steering folded into a follow-up).
    if (turn.awaiting.size > 0 && m.subtype === "success") return;
    const text = [typeof m.result === "string" ? m.result : "", ...(Array.isArray(m.errors) ? (m.errors as string[]) : [])].join("\n");
    const limit = classifyUsageLimit({ message: text });
    if (turn.limited || (m.is_error === true && limit.limited)) {
      const resumeAt = turn.limited?.resumeAt ?? limit.resetsAt;
      turn.done.resolve({ outcome: "limited", message: turn.limited?.message ?? text.trim(), ...(resumeAt ? { resumeAt } : {}), ...(usage ? { usage } : {}) });
      return;
    }
    if (m.subtype === "success" && m.is_error !== true) {
      turn.done.resolve({ outcome: "completed", ...(usage ? { usage } : {}) });
      return;
    }
    if (/interrupt|abort|cancel/i.test(text) || m.stop_reason === "cancelled") {
      turn.done.resolve({ outcome: "interrupted", ...(usage ? { usage } : {}) });
      return;
    }
    turn.done.resolve({ outcome: "failed", message: text.trim() || `Claude stopped (${String(m.subtype)}).`, ...(usage ? { usage } : {}) });
  }
}

function mcpConfig(mcp: McpEndpoint) {
  return { type: "http" as const, url: mcp.url, headers: { Authorization: mcp.authorization }, timeout: 15 * 60_000 };
}

function approvalAction(toolName: string): ApprovalRequestItem["action"] {
  if (toolName === "Bash" || toolName === "BashOutput" || toolName === "KillShell") return "command";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(toolName)) return "file_change";
  if (toolName.startsWith("mcp__alevr__computer")) return "computer";
  return "tool";
}

export function summarizeTool(toolName: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (toolName) {
    case "Bash":
      return s(input.command) || "Run a command";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `${toolName === "Write" ? "Write" : "Edit"} ${s(input.file_path) || s(input.notebook_path) || "a file"}`;
    case "WebFetch":
      return `Fetch ${s(input.url)}`;
    case "WebSearch":
      return `Search the web for “${s(input.query)}”`;
    default:
      return toolName.startsWith("mcp__") ? toolName.replace(/^mcp__/, "").replace(/__/g, " · ") : toolName;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** One Claude tool call as a normalized TurnItem, or undefined for tools Alevr shows elsewhere. */
export function toolItem(
  name: string,
  input: Record<string, unknown>,
  callId: string,
  itemId: string,
  turnId: string,
  createdAt: string,
  status: ItemStatus,
  output?: string,
): TurnItem | undefined {
  const base = { id: itemId, turnId, createdAt, callId };
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "Bash":
      return { ...base, kind: "command_execution", command: s(input.command) || "command", status, ...(output ? { output } : {}), ...(input.run_in_background === true ? { background: true } : {}) };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = s(input.file_path) || s(input.notebook_path) || "file";
      let diff: string | undefined;
      let additions = 0;
      let deletions = 0;
      if (name === "Edit") {
        const oldLines = s(input.old_string) ? s(input.old_string).split("\n") : [];
        const newLines = s(input.new_string) ? s(input.new_string).split("\n") : [];
        deletions = oldLines.length;
        additions = newLines.length;
        diff = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${deletions} +1,${additions} @@`, ...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)].join("\n");
      } else if (name === "Write") {
        const content = s(input.content);
        additions = content ? content.split("\n").length : 0;
      }
      return {
        ...base,
        kind: "file_change",
        status,
        changes: [{ path, change: name === "Write" ? "add" : "modify", ...(diff ? { diff } : {}), additions, deletions }],
      };
    }
    case "Read":
      return { ...base, kind: "search", query: s(input.file_path), scope: "files", status };
    case "Grep":
      return { ...base, kind: "search", query: s(input.pattern), scope: "content", status };
    case "Glob":
      return { ...base, kind: "search", query: s(input.pattern), scope: "files", status };
    case "WebSearch":
      return { ...base, kind: "web_search", query: s(input.query), status };
    case "WebFetch":
      return { ...base, kind: "web_search", query: s(input.url), status };
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as { content?: string; status?: string }[]) : [];
      return {
        id: itemId,
        turnId,
        createdAt,
        kind: "todo_list",
        todos: todos.map((t) => ({ text: s(t.content), status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending" })),
      };
    }
    case "Task":
    case "Agent":
      return {
        id: itemId,
        turnId,
        createdAt,
        kind: "subagent",
        agentId: callId,
        role: "worker",
        model: { instanceId: "claude-agent", model: s(input.model) || "inherit" },
        status: status === "running" ? "running" : status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed",
        task: s(input.description) || s(input.prompt),
        ...(output ? { closingText: output } : {}),
      };
    case "ExitPlanMode":
    case "AskUserQuestion":
      return undefined;
    default:
      if (name.startsWith("mcp__alevr__")) return undefined;
      return undefined;
  }
}
