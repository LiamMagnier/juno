/**
 * Generic Agent Client Protocol adapter (SPEC §2): Gemini CLI, Grok, DeepSeek
 * Harness, OpenCode, Antigravity's official ACP runtime, or any ACP agent the
 * user adds. The transport is the ACP client vendored from the Electron app
 * (providers/acp/client.ts); ideas for MCP injection and mode handling follow
 * T3 Code's AcpAdapterV2 (MIT), re-implemented.
 *
 * ACP has no steering and no subscription-limit telemetry, so the adapter
 * says so: steering false, limits only from error text. Health checks call
 * `initialize` and nothing else — no session, no login.
 */
import path from "node:path";
import type {
  ApprovalDecision,
  FileChangeEntry,
  ItemStatus,
  ProviderCapabilities,
  ProviderInstance,
  ProviderSetupAction,
  ProviderSetupStep,
  RuntimeMode,
  TurnItem,
  UserInput,
} from "../contracts/code-v2.js";
import { AcpClient, AcpError, scrubEnvironment, type LaunchCommand } from "./acp/client.js";
import {
  EmptyResponseSchema,
  type InitializeResponse,
  type McpServerHttp,
  type McpServerStdio,
  type PermissionOption,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionNotification,
} from "./acp/schema.js";
import { acpPreset, acpSetup } from "./presets.js";
import { findBinary, spawnPath } from "./detect.js";
import { classifyUsageLimit } from "./limits.js";
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
import { describeError, type Logger } from "../util.js";

/** How the env server launches its own stdio→HTTP MCP bridge for agents without HTTP MCP. */
export interface McpBridgeCommand {
  command: string;
  args: string[];
}

export interface AcpAdapterOptions {
  mcpBridge?: McpBridgeCommand;
}

export function launchFor(instance: ProviderInstance, argv?: string[]): LaunchCommand {
  const command = argv ?? instance.acpCommand ?? [];
  if (command.length === 0) throw new Error(`${instance.label} has no ACP command.`);
  const binary = instance.binaryPath && (!argv || path.basename(argv[0]) === path.basename(instance.acpCommand?.[0] ?? "")) ? instance.binaryPath : findBinary(command[0]) ?? command[0];
  return {
    command: binary,
    args: [...command.slice(1), ...(instance.launchArgs ?? [])],
    env: { PATH: spawnPath(binary), ...(instance.env ?? {}) },
  };
}

function passthrough(instance: ProviderInstance): string[] {
  return acpPreset(instance)?.envPassthrough ?? [];
}

export class AcpAdapter implements ProviderAdapter {
  readonly kind = "acp" as const;

  constructor(private readonly options: AcpAdapterOptions = {}) {}

  capabilities(_instance: ProviderInstance): ProviderCapabilities {
    return {
      steering: false,
      queue: true,
      interrupt: true,
      resume: true,
      fork: false,
      rollback: true,
      planMode: false,
      // The agent asks through session/request_permission; Alevr answers per mode.
      approvals: ["ask", "auto-edit", "full"],
      subagents: true,
      computerUse: false,
      contextTiers: false,
      effortLevels: [],
      images: false,
      mcpInjection: true,
    };
  }

  setup(instance: ProviderInstance, action: ProviderSetupAction): ProviderSetupStep | null {
    return acpSetup(instance, action);
  }

  async probe(instance: ProviderInstance, options: ProbeOptions): Promise<ProbeResult> {
    if (!instance.binaryPath && !instance.acpCommand?.length) return { status: "not-installed" };
    const preset = acpPreset(instance);
    const attempts = [instance.acpCommand ?? preset?.command ?? [], ...(preset?.fallbacks ?? [])].filter((a) => a.length);
    let lastError = "";
    for (const argv of attempts) {
      const client = new AcpClient({
        launch: launchFor(instance, argv),
        cwd: options.cwd ?? process.cwd(),
        envPassthrough: passthrough(instance),
        handlers: {
          onSessionUpdate: () => {},
          onRequestPermission: async () => ({ outcome: "cancelled" }),
        },
        clientInfo: { name: "alevr-env", version: "0.1.0" },
        requestTimeoutMs: options.timeoutMs ?? 15_000,
        shutdownGraceMs: 1500,
      });
      try {
        const init = await client.start();
        const result: ProbeResult = { status: "ready" };
        const version = typeof init.agentInfo?.version === "string" ? init.agentInfo.version : undefined;
        if (version) result.version = version;
        // A fallback argv that worked (older/newer CLI flag) becomes the instance's command.
        if (argv !== instance.acpCommand) result.acpCommand = [...argv];
        return result;
      } catch (error) {
        lastError = describeError(error);
      } finally {
        await client.stop().catch(() => undefined);
      }
    }
    return { status: "error", statusMessage: `${instance.label} did not start: ${lastError}` };
  }

  async openSession(instance: ProviderInstance, options: OpenSessionOptions): Promise<ProviderSession> {
    const session = new AcpSession(instance, options, this.options.mcpBridge);
    await session.start();
    return session;
  }
}

interface AcpTurn {
  turnId: string;
  sink: TurnSink;
  runtimeMode: RuntimeMode;
  /** messageId (or "current") → item id */
  messageItem?: { key: string; id: string };
  thoughtItem?: { key: string; id: string };
  tools: Map<string, { itemId: string; item: TurnItem }>;
  todoItemId?: string;
}

class AcpSession implements ProviderSession {
  #client: AcpClient;
  #init: InitializeResponse | undefined;
  #acpSessionId: string | undefined;
  #turn: AcpTurn | undefined;
  #abort: AbortController | undefined;
  #modes: { id: string; name: string }[] = [];
  #modelOption: { id: string; current?: unknown } | undefined;
  #model: string | undefined;
  readonly #logger: Logger;

  constructor(
    private readonly instance: ProviderInstance,
    private readonly options: OpenSessionOptions,
    private readonly bridge?: McpBridgeCommand,
  ) {
    this.#logger = options.logger;
    const s = options.resumeState ?? {};
    if (typeof s.acpSessionId === "string") this.#acpSessionId = s.acpSessionId;
    this.#client = new AcpClient({
      launch: launchFor(instance),
      cwd: options.cwd,
      envPassthrough: passthrough(instance),
      clientInfo: { name: "alevr-env", version: "0.1.0" },
      handlers: {
        onSessionUpdate: (n) => this.#onUpdate(n),
        onRequestPermission: (r) => this.#onPermission(r),
        onProtocolWarning: (m) => this.#logger.debug(`acp: ${m}`),
      },
      logger: { debug: (m) => this.#logger.debug(m), warn: (m) => this.#logger.warn(m), error: (m) => this.#logger.error(m) },
    });
  }

  async start(): Promise<void> {
    try {
      this.#init = await this.#client.start();
    } catch (error) {
      throw new Error(`${this.instance.label} did not start: ${describeError(error)}`);
    }
    const mcpServers = this.#mcpServers(this.options.mcp);
    const canLoad = this.#init.agentCapabilities?.loadSession === true || !!this.#init.agentCapabilities?.sessionCapabilities?.resume;
    try {
      if (this.#acpSessionId && canLoad) {
        const loaded = await this.#client.loadSession({ cwd: this.options.cwd, mcpServers: mcpServers as McpServerStdio[], sessionId: this.#acpSessionId });
        this.#readModes(loaded.modes ?? undefined, loaded.configOptions ?? undefined);
        return;
      }
      const created = await this.#client.newSession({ cwd: this.options.cwd, mcpServers: mcpServers as McpServerStdio[] });
      this.#acpSessionId = created.sessionId;
      this.#readModes(created.modes ?? undefined, created.configOptions ?? undefined);
    } catch (error) {
      if (error instanceof AcpError && error.code === -32000) {
        throw new Error(`Sign in to ${this.instance.label} first. ${describeError(error)}`);
      }
      throw error;
    }
  }

  #mcpServers(mcp: McpEndpoint | undefined): (McpServerStdio | McpServerHttp)[] {
    if (!mcp) return [];
    if (this.#init?.agentCapabilities?.mcpCapabilities?.http) {
      return [{ type: "http", name: mcp.name, url: mcp.url, headers: [{ name: "Authorization", value: mcp.authorization }] }];
    }
    if (!this.bridge) return [];
    return [
      {
        name: mcp.name,
        command: this.bridge.command,
        args: [...this.bridge.args, "--url", mcp.url],
        env: [{ name: "ALEVR_MCP_AUTHORIZATION", value: mcp.authorization }],
      },
    ];
  }

  #readModes(modes: { availableModes?: { id: string; name: string }[] } | undefined, config: { id: string; currentValue?: unknown }[] | undefined): void {
    this.#modes = modes?.availableModes ?? [];
    const model = config?.find((o) => o.id === "model");
    if (model) this.#modelOption = { id: model.id, current: model.currentValue };
  }

  resumeState(): Record<string, unknown> {
    return this.#acpSessionId ? { acpSessionId: this.#acpSessionId } : {};
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    if (!this.#acpSessionId) throw new Error("ACP session is not open");
    if (this.#turn) throw new Error("an ACP turn is already running");
    await this.#applyMode(request.runtimeMode);
    await this.#applyModel(request.selection.model);
    const turn: AcpTurn = { turnId: request.turnId, sink: request.sink, runtimeMode: request.runtimeMode, tools: new Map() };
    this.#turn = turn;
    const abort = new AbortController();
    this.#abort = abort;
    const onAbort = () => abort.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.#client.prompt({ sessionId: this.#acpSessionId, prompt: toAcpPrompt(request.input) }, abort.signal);
      this.#finishStreaming(turn);
      const usage = res.usage
        ? { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, ...(res.usage.cachedReadTokens ? { cachedInputTokens: res.usage.cachedReadTokens } : {}) }
        : undefined;
      if (usage) request.sink.usage(usage);
      switch (res.stopReason) {
        case "cancelled":
          return { outcome: "interrupted", ...(usage ? { usage } : {}) };
        case "refusal":
          return { outcome: "failed", message: `${this.instance.label} refused to continue.`, ...(usage ? { usage } : {}) };
        case "max_tokens":
        case "max_turn_requests":
          request.sink.notice("warning", `${this.instance.label} stopped at its own ${res.stopReason === "max_tokens" ? "output" : "step"} limit.`, res.stopReason);
          return { outcome: "completed", ...(usage ? { usage } : {}) };
        default:
          return { outcome: "completed", ...(usage ? { usage } : {}) };
      }
    } catch (error) {
      this.#finishStreaming(turn);
      const message = describeError(error);
      const limit = classifyUsageLimit({ message });
      if (limit.limited) return { outcome: "limited", message, ...(limit.resetsAt ? { resumeAt: limit.resetsAt } : {}) };
      if (abort.signal.aborted) return { outcome: "interrupted" };
      return { outcome: "failed", message };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      this.#turn = undefined;
      this.#abort = undefined;
    }
  }

  async interrupt(): Promise<void> {
    this.#abort?.abort();
    if (this.#acpSessionId) this.#client.cancel(this.#acpSessionId);
  }

  async close(): Promise<void> {
    await this.#client.stop();
  }

  async #applyMode(mode: RuntimeMode): Promise<void> {
    if (!this.#acpSessionId || this.#modes.length === 0) return;
    const wanted = acpModeFor(mode, this.#modes);
    if (!wanted) return;
    await this.#client.setMode(this.#acpSessionId, wanted).catch((e) => this.#logger.debug(`acp set_mode: ${describeError(e)}`));
  }

  async #applyModel(model: string): Promise<void> {
    if (!this.#acpSessionId || !this.#modelOption || !model || model === "default" || model === this.#model) return;
    try {
      await this.#client.request("session/set_config_option", { sessionId: this.#acpSessionId, configId: this.#modelOption.id, value: model }, EmptyResponseSchema);
      this.#model = model;
    } catch (error) {
      this.#logger.debug(`acp set model: ${describeError(error)}`);
    }
  }

  #finishStreaming(turn: AcpTurn): void {
    for (const ref of [turn.messageItem, turn.thoughtItem]) {
      if (!ref) continue;
      // The final text is the sum of the deltas; a closing update only flips `streaming`.
      turn.sink.item({ ...(this.#lastItems.get(ref.id) as TurnItem), streaming: false } as TurnItem);
    }
    turn.messageItem = undefined;
    turn.thoughtItem = undefined;
  }

  /** Latest full state of streamed items, so closing them keeps their text. */
  #lastItems = new Map<string, TurnItem>();

  #onUpdate(n: SessionNotification): void {
    const turn = this.#turn;
    if (!turn || n.sessionId !== this.#acpSessionId) return;
    const sink = turn.sink;
    const u = n.update as Record<string, unknown> & { sessionUpdate: string };
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = contentText(u.content);
        if (!text) return;
        const isThought = u.sessionUpdate === "agent_thought_chunk";
        const key = typeof u.messageId === "string" ? u.messageId : "current";
        const slot = isThought ? turn.thoughtItem : turn.messageItem;
        if (!slot || slot.key !== key) {
          if (slot) this.#closeItem(turn, slot.id);
          const id = sink.newItemId(isThought ? "think" : "msg");
          const item: TurnItem = isThought
            ? { id, kind: "reasoning", turnId: turn.turnId, createdAt: sink.now(), text, streaming: true }
            : { id, kind: "assistant_message", turnId: turn.turnId, createdAt: sink.now(), text, streaming: true };
          this.#lastItems.set(id, item);
          sink.item(item);
          if (isThought) turn.thoughtItem = { key, id };
          else turn.messageItem = { key, id };
          return;
        }
        const last = this.#lastItems.get(slot.id) as TurnItem & { text: string };
        this.#lastItems.set(slot.id, { ...last, text: last.text + text } as TurnItem);
        sink.delta(slot.id, "text", text);
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        // A tool call ends the current message block.
        if (turn.messageItem) {
          this.#closeItem(turn, turn.messageItem.id);
          turn.messageItem = undefined;
        }
        const callId = String(u.toolCallId);
        const prior = turn.tools.get(callId);
        const item = acpToolItem(u, prior?.item, prior?.itemId ?? sink.newItemId("tool"), turn.turnId, sink.now());
        if (!item) return;
        turn.tools.set(callId, { itemId: item.id, item });
        sink.item(item);
        return;
      }
      case "plan": {
        const entries = Array.isArray(u.entries) ? (u.entries as { content: string; status: string }[]) : [];
        turn.todoItemId ??= sink.newItemId("todo");
        sink.item({
          id: turn.todoItemId,
          kind: "todo_list",
          turnId: turn.turnId,
          createdAt: sink.now(),
          todos: entries.map((e) => ({ text: e.content, status: e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending" })),
        });
        return;
      }
      case "usage_update": {
        // Context-window occupancy, not billing.
        if (typeof u.used === "number" && typeof u.size === "number") {
          sink.usage({ inputTokens: 0, outputTokens: 0, contextTokens: u.used, contextWindow: u.size });
        }
        return;
      }
      default:
        return;
    }
  }

  #closeItem(turn: AcpTurn, id: string): void {
    const last = this.#lastItems.get(id);
    if (last) turn.sink.item({ ...last, streaming: false } as TurnItem);
  }

  async #onPermission(request: RequestPermissionRequest): Promise<RequestPermissionOutcome> {
    const turn = this.#turn;
    if (!turn) return { outcome: "cancelled" };
    const kind = request.toolCall.kind ?? undefined;
    const auto = autoDecision(turn.runtimeMode, kind);
    let decision: ApprovalDecision;
    if (auto) decision = auto;
    else {
      const allowAlways = request.options.some((o) => o.kind === "allow_always");
      const answer = await turn.sink.requestApproval({
        callId: request.toolCall.toolCallId,
        action: kind === "execute" ? "command" : kind === "edit" || kind === "delete" || kind === "move" ? "file_change" : "tool",
        summary: request.toolCall.title ?? "Allow this action",
        options: allowAlways ? ["accept", "acceptForSession", "decline", "cancel"] : ["accept", "decline", "cancel"],
      });
      decision = answer.decision;
    }
    if (decision === "cancel") {
      void this.interrupt();
      return { outcome: "cancelled" };
    }
    const option = pickOption(request.options, decision);
    return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
  }
}

/** Host-side answers for modes the agent itself does not enforce. */
export function autoDecision(mode: RuntimeMode, kind: string | undefined): ApprovalDecision | undefined {
  if (mode === "full") return "accept";
  if (mode === "auto-edit" && (kind === "edit" || kind === "read" || kind === "search" || kind === "think" || kind === "move")) return "accept";
  if (mode === "read-only" && (kind === "edit" || kind === "delete" || kind === "move" || kind === "execute")) return "decline";
  return undefined;
}

export function pickOption(options: readonly PermissionOption[], decision: ApprovalDecision): PermissionOption | undefined {
  const exact = decision === "accept" ? "allow_once" : decision === "acceptForSession" ? "allow_always" : "reject_once";
  const direct = options.find((o) => o.kind === exact);
  if (direct) return direct;
  const allowing = decision === "accept" || decision === "acceptForSession";
  return options.find((o) => (allowing ? o.kind.startsWith("allow") : o.kind.startsWith("reject")));
}

export function acpModeFor(mode: RuntimeMode, modes: { id: string; name: string }[]): string | undefined {
  const find = (re: RegExp) => modes.find((m) => re.test(m.id) || re.test(m.name))?.id;
  switch (mode) {
    case "read-only":
      return find(/^(plan|read[-_ ]?only|ask)$/i);
    case "ask":
      return find(/^(default|ask|normal|supervised)$/i);
    case "auto-edit":
      return find(/accept[-_ ]?edits|auto[-_ ]?edit/i);
    case "auto":
      return find(/^auto$/i) ?? find(/accept[-_ ]?edits|auto[-_ ]?edit/i);
    case "full":
      return find(/bypass|yolo|full|dangerous/i);
  }
}

function toAcpPrompt(input: UserInput) {
  const blocks: { type: "text"; text: string }[] = [{ type: "text", text: input.text }];
  for (const a of input.attachments ?? []) {
    if (a.ref.startsWith("/")) blocks.push({ type: "text", text: `Attached file: ${a.ref}` });
  }
  return blocks as never;
}

function contentText(content: unknown): string {
  if (content && typeof content === "object" && (content as { type?: string }).type === "text") return String((content as { text?: string }).text ?? "");
  return "";
}

const ACP_STATUS: Record<string, ItemStatus> = { pending: "pending", in_progress: "running", completed: "completed", failed: "failed" };

export function acpToolItem(u: Record<string, unknown>, prior: TurnItem | undefined, itemId: string, turnId: string, now: string): TurnItem | undefined {
  const kind = (u.kind as string | null | undefined) ?? (prior ? priorKind(prior) : undefined) ?? "other";
  const status = ACP_STATUS[String(u.status ?? "")] ?? (prior && "status" in prior ? (prior.status as ItemStatus) : "running");
  const title = typeof u.title === "string" ? u.title : undefined;
  const callId = String(u.toolCallId);
  const base = { id: itemId, turnId, createdAt: prior?.createdAt ?? now, callId };
  const raw = (u.rawInput ?? {}) as Record<string, unknown>;
  const content = Array.isArray(u.content) ? (u.content as Record<string, unknown>[]) : [];
  const outputText = content
    .filter((c) => c.type === "content")
    .map((c) => contentText(c.content))
    .filter(Boolean)
    .join("\n");
  switch (kind) {
    case "execute": {
      const p = prior?.kind === "command_execution" ? prior : undefined;
      const command = (typeof raw.command === "string" ? raw.command : Array.isArray(raw.command) ? raw.command.join(" ") : undefined) ?? p?.command ?? title ?? "command";
      const output = outputText || p?.output;
      return { ...base, kind: "command_execution", command, status, ...(output ? { output } : {}) };
    }
    case "edit":
    case "delete":
    case "move": {
      const diffs = content.filter((c) => c.type === "diff");
      const p = prior?.kind === "file_change" ? prior : undefined;
      const changes: FileChangeEntry[] = diffs.length
        ? diffs.map((d) => diffEntry(String(d.path), d.oldText as string | null | undefined, String(d.newText ?? ""), kind))
        : (p?.changes ??
          (Array.isArray(u.locations) ? (u.locations as { path: string }[]).map((l) => ({ path: l.path, change: kind === "delete" ? ("delete" as const) : ("modify" as const) })) : []));
      return { ...base, kind: "file_change", status, changes };
    }
    case "read":
    case "search": {
      const p = prior?.kind === "search" ? prior : undefined;
      const query = (typeof raw.pattern === "string" ? raw.pattern : typeof raw.path === "string" ? raw.path : undefined) ?? p?.query ?? title ?? "";
      return { ...base, kind: "search", query, scope: kind === "read" ? "files" : "content", status };
    }
    case "fetch": {
      const p = prior?.kind === "web_search" ? prior : undefined;
      const query = (typeof raw.url === "string" ? raw.url : typeof raw.query === "string" ? raw.query : undefined) ?? p?.query ?? title ?? "";
      return { ...base, kind: "web_search", query, status };
    }
    default: {
      // think / switch_mode / other: shown as a quiet line once it settles.
      if (status !== "completed" && status !== "failed") return undefined;
      return { id: itemId, turnId, createdAt: base.createdAt, kind: "system_notice", level: status === "failed" ? "warning" : "info", text: title ?? "Tool call", code: "acp_tool" };
    }
  }
}

function priorKind(item: TurnItem): string | undefined {
  switch (item.kind) {
    case "command_execution":
      return "execute";
    case "file_change":
      return "edit";
    case "search":
      return item.scope === "files" ? "read" : "search";
    case "web_search":
      return "fetch";
    default:
      return undefined;
  }
}

function diffEntry(file: string, oldText: string | null | undefined, newText: string, kind: string): FileChangeEntry {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  const change = kind === "delete" ? "delete" : oldText == null ? "add" : "modify";
  return {
    path: file,
    change,
    diff: [`--- ${oldText == null ? "/dev/null" : `a/${file}`}`, `+++ b/${file}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`, ...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)].join("\n"),
    additions: newLines.length,
    deletions: oldLines.length,
  };
}

/** Exposed for tests: env the ACP client would hand an agent. */
export function acpChildEnv(instance: ProviderInstance): Record<string, string> {
  return scrubEnvironment(process.env, { passthrough: passthrough(instance), extra: launchFor(instance).env as Record<string, string> });
}
