/**
 * Codex adapter: the user's own `codex app-server` (ChatGPT plan), JSON-RPC
 * over stdio (SPEC §2). OpenAI documents app-server as the way to embed Codex
 * in another product; Alevr is a client of it and never touches the ChatGPT
 * credential. The "Connect with ChatGPT" token-sharing mode (Path B) is a
 * disabled stub until OpenAI confirms Alevr may use it.
 *
 * Protocol shapes follow codex app-server v2 as captured by T3 Code's
 * generated schema (packages/effect-codex-app-server, MIT): initialize →
 * initialized, account/read, model/list (paged), account/rateLimits/read,
 * thread/start|resume, turn/start|steer|interrupt, thread/revert, and the
 * server requests item/{commandExecution,fileChange,permissions}/requestApproval
 * and item/tool/requestUserInput.
 */
import type {
  ApprovalDecision,
  CommandExecutionItem,
  EffortLevel,
  FileChangeEntry,
  FileChangeItem,
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
import { JsonRpcError, JsonRpcStdio } from "./jsonrpc-stdio.js";
import { classifyUsageLimit, earliestExhaustedReset, normalizeReset } from "./limits.js";
import { codexSetup } from "./presets.js";
import { readVersion } from "./detect.js";
import { vendorEnv } from "./vendor-env.js";
import type {
  OpenSessionOptions,
  ProbeOptions,
  ProbeResult,
  ProviderAdapter,
  ProviderSession,
  TurnRequest,
  TurnResult,
  TurnSink,
  McpEndpoint,
} from "./types.js";
import { deferred, describeError, type Deferred, type Logger } from "../util.js";

const CLIENT_INFO = { name: "Alevr", title: "Alevr Code", version: "2.0.0" };
const PROBE_TIMEOUT_MS = 25_000;

/** Path B (ChatGPT OAuth token sharing): deliberately unavailable. See PROVIDERS-LEGAL.md. */
export const CODEX_CHATGPT_TOKEN_SHARING = {
  enabled: false,
  reason: "Connecting with ChatGPT directly waits on OpenAI confirming Alevr may use it. Sign in with `codex login` instead.",
} as const;

export function codexSandboxPolicy(mode: RuntimeMode): Record<string, unknown> {
  const sandbox = RUNTIME_MODE_VENDOR_MAP[mode].codex.sandbox;
  return { type: sandbox };
}

export function codexTurnPolicy(mode: RuntimeMode) {
  const m = RUNTIME_MODE_VENDOR_MAP[mode].codex;
  return { approvalPolicy: m.approvalPolicy, approvalsReviewer: m.approvalsReviewer, sandboxPolicy: codexSandboxPolicy(mode) };
}

function codexArgs(instance: ProviderInstance): string[] {
  return ["app-server", ...(instance.launchArgs ?? [])];
}

export interface CodexAdapterOptions {
  clientVersion?: string;
}

export class CodexAdapter implements ProviderAdapter {
  readonly kind = "codex" as const;

  constructor(private readonly options: CodexAdapterOptions = {}) {}

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
      effortLevels: efforts.size ? [...efforts] : ["low", "medium", "high", "xhigh"],
      images: true,
      mcpInjection: true,
    };
  }

  setup(instance: ProviderInstance, action: ProviderSetupAction): ProviderSetupStep | null {
    return codexSetup(instance, action);
  }

  async probe(instance: ProviderInstance, options: ProbeOptions): Promise<ProbeResult> {
    if (!instance.binaryPath) return { status: "not-installed", statusMessage: "Codex is not installed on this Mac." };
    const version = await readVersion(instance.binaryPath);
    const rpc = new JsonRpcStdio({
      command: instance.binaryPath,
      args: codexArgs(instance),
      cwd: options.cwd ?? process.cwd(),
      env: vendorEnv(instance, "CODEX_HOME"),
      logger: options.logger,
      requestTimeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      handlers: {
        onNotification: () => {},
        // A probe never starts a turn, so nothing should ask; refuse anything that does.
        onRequest: async () => {
          throw new JsonRpcError("not handled during a health check", -32601);
        },
      },
    });
    rpc.start();
    try {
      await initialize(rpc, this.options.clientVersion);
      const account = await rpc.request<{ account?: Record<string, unknown> | null; requiresOpenaiAuth?: boolean }>("account/read", {});
      const result: ProbeResult = { ...(version ? { version } : {}) };
      if (!account?.account && account?.requiresOpenaiAuth !== false) {
        return { ...result, status: "signed-out", statusMessage: "Sign in to Codex to use your ChatGPT plan here." };
      }
      const a = account.account ?? {};
      result.account = {
        ...(typeof a.email === "string" ? { email: a.email } : {}),
        ...(typeof a.planType === "string" ? { plan: a.planType } : {}),
        ...(typeof a.type === "string" ? { tokenSource: a.type === "chatgpt" ? "chatgpt" : String(a.type) } : {}),
      };
      result.models = await listModels(rpc).catch(() => undefined);
      if (!result.models) delete result.models;
      const limits = await rpc.request<Record<string, unknown>>("account/rateLimits/read", {}).catch(() => undefined);
      const windows = limits ? codexLimitWindows(limits.rateLimits as Record<string, unknown> | undefined) : [];
      if (windows.length) result.limits = windows;
      const reset = earliestExhaustedReset(windows);
      result.status = reset ? "limited" : "ready";
      if (reset) result.statusMessage = "Your Codex usage limit is reached.";
      return result;
    } finally {
      await rpc.stop(1000);
    }
  }

  async openSession(instance: ProviderInstance, options: OpenSessionOptions): Promise<ProviderSession> {
    if (!instance.binaryPath) throw new Error("Codex is not installed on this Mac.");
    const session = new CodexSession(instance, options, this.options.clientVersion);
    await session.start();
    return session;
  }
}

async function initialize(rpc: JsonRpcStdio, version?: string): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: { ...CLIENT_INFO, ...(version ? { version } : {}) },
    capabilities: { experimentalApi: true, optOutNotificationMethods: ["turn/diff/updated"] },
  });
  rpc.notify("initialized", {});
}

async function listModels(rpc: JsonRpcStdio): Promise<ProviderModel[]> {
  const out: ProviderModel[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await rpc.request<{ data?: Record<string, unknown>[]; nextCursor?: string | null }>("model/list", cursor ? { cursor } : {});
    for (const m of res?.data ?? []) {
      if (m.hidden === true) continue;
      const efforts = Array.isArray(m.supportedReasoningEfforts)
        ? (m.supportedReasoningEfforts as { reasoningEffort?: string }[]).map((e) => e.reasoningEffort).filter(isEffort)
        : [];
      const model: ProviderModel = { id: String(m.model ?? m.id), label: String(m.displayName ?? m.model ?? m.id) };
      if (efforts.length) model.effortLevels = efforts;
      if (isEffort(m.defaultReasoningEffort)) model.defaultEffort = m.defaultReasoningEffort;
      if (m.isDefault === true) model.isDefault = true;
      if (Array.isArray(m.additionalSpeedTiers) && m.additionalSpeedTiers.length) model.supportsFast = true;
      out.push(model);
    }
    cursor = res?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
function isEffort(v: unknown): v is EffortLevel {
  return typeof v === "string" && EFFORTS.has(v);
}

export function codexLimitWindows(snapshot: Record<string, unknown> | undefined): UsageWindow[] {
  if (!snapshot) return [];
  const out: UsageWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = snapshot[key] as { usedPercent?: number; resetsAt?: number | null; windowDurationMins?: number | null } | null | undefined;
    if (!w || typeof w.usedPercent !== "number") continue;
    const mins = w.windowDurationMins ?? undefined;
    const label = mins ? (mins >= 7 * 24 * 60 - 1 ? "Weekly" : mins >= 24 * 60 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`) : key === "primary" ? "Session" : "Weekly";
    const window: UsageWindow = { id: key, label, usedPct: Math.max(0, Math.min(100, w.usedPercent)) };
    const reset = normalizeReset(w.resetsAt ?? undefined);
    if (reset) window.resetsAt = reset;
    out.push(window);
  }
  return out;
}

function toCodexInput(input: UserInput): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ type: "text", text: input.text }];
  for (const a of input.attachments ?? []) {
    if (a.mediaType.startsWith("image/") && a.ref.startsWith("/")) out.push({ type: "localImage", path: a.ref });
    else if (a.ref.startsWith("/")) out.push({ type: "mention", name: a.name, path: a.ref });
  }
  return out;
}

const STATUS: Record<string, ItemStatus> = {
  inProgress: "running",
  completed: "completed",
  failed: "failed",
  declined: "declined",
};

interface ActiveTurn {
  turnId: string;
  codexTurnId?: string;
  sink: TurnSink;
  done: Deferred<TurnResult>;
  limited?: { resetsAt?: string; message?: string };
  error?: string;
  /** codex item id → our item */
  items: Map<string, TurnItem>;
  todoItemId?: string;
}

class CodexSession implements ProviderSession {
  #rpc: JsonRpcStdio;
  #threadId: string | undefined;
  #active: ActiveTurn | undefined;
  /** codex turn id of each completed Alevr turn, by ordinal - 1. */
  #codexTurns: string[] = [];
  readonly #logger: Logger;

  constructor(
    private readonly instance: ProviderInstance,
    private readonly options: OpenSessionOptions,
    private readonly clientVersion?: string,
  ) {
    this.#logger = options.logger;
    const state = options.resumeState ?? {};
    if (typeof state.threadId === "string") this.#threadId = state.threadId;
    if (Array.isArray(state.codexTurns)) this.#codexTurns = state.codexTurns.filter((t): t is string => typeof t === "string");
    this.#rpc = new JsonRpcStdio({
      command: instance.binaryPath!,
      args: codexArgs(instance),
      cwd: options.cwd,
      env: vendorEnv(instance, "CODEX_HOME"),
      logger: options.logger,
      handlers: {
        onNotification: (method, params) => this.#onNotification(method, params as Record<string, unknown>),
        onRequest: (method, params) => this.#onRequest(method, params as Record<string, unknown>),
        onExit: ({ stderr }) => {
          const active = this.#active;
          if (active) active.done.resolve({ outcome: "failed", message: `Codex stopped unexpectedly. ${stderr.trim().split("\n").slice(-2).join(" ")}`.trim() });
        },
      },
    });
  }

  async start(): Promise<void> {
    this.#rpc.start();
    await initialize(this.#rpc, this.clientVersion);
    const config = threadConfig(this.options.mcp);
    if (this.#threadId) {
      try {
        await this.#rpc.request("thread/resume", { threadId: this.#threadId, cwd: this.options.cwd, excludeTurns: true, ...(config ? { config } : {}) });
        return;
      } catch (error) {
        this.#logger.warn(`codex thread/resume failed, starting a new thread: ${describeError(error)}`);
        this.#threadId = undefined;
        this.#codexTurns = [];
      }
    }
    const res = await this.#rpc.request<{ thread?: { id?: string } }>("thread/start", {
      cwd: this.options.cwd,
      model: this.options.selection.model,
      ...(config ? { config } : {}),
    });
    const id = res?.thread?.id;
    if (!id) throw new Error("codex app-server returned no thread id");
    this.#threadId = id;
  }

  resumeState(): Record<string, unknown> {
    return { threadId: this.#threadId, codexTurns: this.#codexTurns };
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    if (this.#active) throw new Error("a Codex turn is already running");
    const active: ActiveTurn = { turnId: request.turnId, sink: request.sink, done: deferred<TurnResult>(), items: new Map() };
    this.#active = active;
    const onAbort = () => void this.interrupt();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const policy = codexTurnPolicy(request.runtimeMode);
      const effort = request.selection.effort;
      const params: Record<string, unknown> = {
        threadId: this.#threadId,
        input: toCodexInput(request.input),
        cwd: request.cwd,
        model: request.selection.model,
        summary: "detailed",
        ...policy,
        ...(effort ? { effort } : {}),
        ...(request.selection.fast ? { serviceTier: "fast" } : {}),
      };
      if (request.interactionMode === "plan") {
        params.collaborationMode = {
          mode: "plan",
          settings: { model: request.selection.model, reasoning_effort: effort ?? "medium" },
        };
      }
      const res = await this.#rpc.request<{ turn?: { id?: string } }>("turn/start", params);
      active.codexTurnId = res?.turn?.id;
      const result = await active.done.promise;
      if (active.codexTurnId) this.#codexTurns[request.turnOrdinal - 1] = active.codexTurnId;
      return result;
    } catch (error) {
      const limit = classifyUsageLimit({ message: describeError(error), code: errorCode(error) });
      if (limit.limited) return { outcome: "limited", message: describeError(error), ...(limit.resetsAt ? { resumeAt: limit.resetsAt } : {}) };
      return { outcome: "failed", message: describeError(error) };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      this.#active = undefined;
    }
  }

  async steer(input: UserInput): Promise<boolean> {
    const active = this.#active;
    if (!active?.codexTurnId || !this.#threadId) return false;
    try {
      await this.#rpc.request("turn/steer", { threadId: this.#threadId, expectedTurnId: active.codexTurnId, input: toCodexInput(input) });
      return true;
    } catch (error) {
      this.#logger.info(`codex turn/steer refused: ${describeError(error)}`);
      return false;
    }
  }

  async interrupt(): Promise<void> {
    const active = this.#active;
    if (!active?.codexTurnId || !this.#threadId) return;
    await this.#rpc.request("turn/interrupt", { threadId: this.#threadId, turnId: active.codexTurnId }).catch((e) => {
      this.#logger.warn(`codex turn/interrupt: ${describeError(e)}`);
    });
  }

  async rewindTo(ordinal: number): Promise<boolean> {
    const before = this.#codexTurns[ordinal];
    if (!this.#threadId || !before) return ordinal >= this.#codexTurns.length;
    try {
      await this.#rpc.request("thread/revert", { threadId: this.#threadId, beforeTurnId: before });
      this.#codexTurns = this.#codexTurns.slice(0, ordinal);
      return true;
    } catch (error) {
      this.#logger.warn(`codex thread/revert: ${describeError(error)}`);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.#rpc.stop();
  }

  // ── Server → client ─────────────────────────────────────────────────────

  async #onRequest(method: string, p: Record<string, unknown>): Promise<unknown> {
    const active = this.#active;
    if (!active) throw new JsonRpcError(`no active turn for ${method}`, -32600);
    const sink = active.sink;
    const options: ApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const answer = await sink.requestApproval({
          callId: String(p.itemId ?? p.approvalId ?? "command"),
          ...(typeof p.approvalId === "string" ? { requestId: p.approvalId } : {}),
          action: "command",
          summary: typeof p.command === "string" && p.command ? p.command : "Run a command",
          ...(typeof p.reason === "string" ? { justification: p.reason } : {}),
          ...(typeof p.cwd === "string" ? { detail: `in ${p.cwd}` } : {}),
          options,
        });
        if (answer.decision === "cancel") void this.interrupt();
        return { decision: answer.decision };
      }
      case "item/fileChange/requestApproval": {
        const changes = active.items.get(String(p.itemId));
        const files = changes && changes.kind === "file_change" ? changes.changes.map((c) => c.path) : [];
        const answer = await sink.requestApproval({
          callId: String(p.itemId ?? "edit"),
          action: "file_change",
          summary: files.length ? `Edit ${files.length === 1 ? files[0] : `${files.length} files`}` : "Edit files",
          ...(typeof p.reason === "string" ? { justification: p.reason } : {}),
          ...(typeof p.grantRoot === "string" ? { detail: `Write access to ${p.grantRoot}` } : {}),
          options,
        });
        if (answer.decision === "cancel") void this.interrupt();
        return { decision: answer.decision };
      }
      case "item/permissions/requestApproval": {
        const answer = await sink.requestApproval({
          callId: String(p.itemId ?? "permissions"),
          action: "permissions",
          summary: "Allow more access",
          ...(typeof p.reason === "string" ? { justification: p.reason } : {}),
          detail: JSON.stringify(p.permissions ?? {}),
          options,
        });
        if (answer.decision === "accept" || answer.decision === "acceptForSession") {
          return { permissions: p.permissions ?? {}, scope: answer.decision === "acceptForSession" ? "session" : "turn" };
        }
        if (answer.decision === "cancel") void this.interrupt();
        return { permissions: {}, scope: "turn" };
      }
      case "item/tool/requestUserInput": {
        const questions = Array.isArray(p.questions) ? (p.questions as Record<string, unknown>[]) : [];
        const answer = await sink.requestUserInput({
          questions: questions.map((q) => ({
            id: String(q.id),
            prompt: String(q.question ?? q.header ?? ""),
            ...(Array.isArray(q.options) ? { options: (q.options as { label?: string }[]).map((o) => String(o.label ?? "")) } : {}),
          })),
        });
        const answers: Record<string, { answers: string[] }> = {};
        for (const [id, values] of Object.entries(answer.answers ?? {})) answers[id] = { answers: values };
        return { answers };
      }
      case "mcpServer/elicitation/request":
        return { action: "decline" };
      default:
        throw new JsonRpcError(`Alevr does not handle ${method}`, -32601);
    }
  }

  #onNotification(method: string, p: Record<string, unknown>): void {
    const active = this.#active;
    if (method === "account/rateLimits/updated") {
      const windows = codexLimitWindows(p.rateLimits as Record<string, unknown> | undefined);
      if (windows.length) active?.sink.limits(windows);
      return;
    }
    if (!active) return;
    if (active.codexTurnId && typeof p.turnId === "string" && p.turnId !== active.codexTurnId) return;
    const sink = active.sink;
    switch (method) {
      case "turn/started": {
        const turn = p.turn as { id?: string } | undefined;
        if (!active.codexTurnId && turn?.id) active.codexTurnId = turn.id;
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = this.#mapItem(p.item as Record<string, unknown>, method === "item/completed", active);
        if (item) {
          active.items.set(String((p.item as Record<string, unknown>).id), item);
          sink.item(item);
        }
        return;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/plan/delta": {
        const ours = active.items.get(String(p.itemId));
        if (ours && typeof p.delta === "string") sink.delta(ours.id, "text", p.delta);
        return;
      }
      case "item/commandExecution/outputDelta": {
        const ours = active.items.get(String(p.itemId));
        if (ours && typeof p.delta === "string") sink.delta(ours.id, "output", p.delta);
        return;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(p.plan) ? (p.plan as { step?: string; status?: string }[]) : [];
        active.todoItemId ??= sink.newItemId("todo");
        sink.item({
          id: active.todoItemId,
          kind: "todo_list",
          turnId: active.turnId,
          createdAt: sink.now(),
          todos: plan.map((s) => ({
            text: String(s.step ?? ""),
            status: s.status === "completed" ? "completed" : s.status === "inProgress" ? "in_progress" : "pending",
          })),
        });
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = p.tokenUsage as { total?: Record<string, number>; last?: Record<string, number>; modelContextWindow?: number | null } | undefined;
        if (!usage?.total) return;
        const u: SessionUsage = {
          inputTokens: usage.total.inputTokens ?? 0,
          outputTokens: usage.total.outputTokens ?? 0,
          cachedInputTokens: usage.total.cachedInputTokens ?? 0,
        };
        if (usage.last?.totalTokens !== undefined) u.contextTokens = usage.last.inputTokens ?? usage.last.totalTokens;
        if (usage.modelContextWindow) u.contextWindow = usage.modelContextWindow;
        sink.usage(u);
        return;
      }
      case "error": {
        const err = p.error as { message?: string; codexErrorInfo?: unknown } | undefined;
        if (p.willRetry === true) return;
        const code = typeof err?.codexErrorInfo === "string" ? err.codexErrorInfo : undefined;
        const limit = classifyUsageLimit({ message: err?.message, code });
        if (limit.limited) active.limited = { ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}), ...(err?.message ? { message: err.message } : {}) };
        else active.error = err?.message ?? "Codex reported an error.";
        return;
      }
      case "turn/completed": {
        const turn = p.turn as { status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null } | undefined;
        const code = typeof turn?.error?.codexErrorInfo === "string" ? turn.error.codexErrorInfo : undefined;
        const limit = classifyUsageLimit({ message: turn?.error?.message, code });
        if (limit.limited || active.limited) {
          const resumeAt = limit.resetsAt ?? active.limited?.resetsAt;
          active.done.resolve({
            outcome: "limited",
            message: turn?.error?.message ?? active.limited?.message ?? "Your Codex usage limit is reached.",
            ...(resumeAt ? { resumeAt } : {}),
          });
          return;
        }
        if (turn?.status === "interrupted") active.done.resolve({ outcome: "interrupted" });
        else if (turn?.status === "failed") active.done.resolve({ outcome: "failed", message: turn.error?.message ?? active.error ?? "Codex failed." });
        else active.done.resolve({ outcome: "completed" });
        return;
      }
      default:
        return;
    }
  }

  #mapItem(item: Record<string, unknown> | undefined, completed: boolean, active: ActiveTurn): TurnItem | undefined {
    if (!item || typeof item.type !== "string") return undefined;
    const sink = active.sink;
    const existing = active.items.get(String(item.id));
    const id = existing?.id ?? sink.newItemId(item.type);
    const base = { id, turnId: active.turnId, createdAt: existing?.createdAt ?? sink.now() };
    switch (item.type) {
      case "agentMessage":
        return { ...base, kind: "assistant_message", text: completed ? String(item.text ?? "") : textOf(existing) ?? String(item.text ?? ""), streaming: !completed };
      case "reasoning": {
        const summary = Array.isArray(item.summary) ? (item.summary as string[]).join("\n\n") : "";
        const content = Array.isArray(item.content) ? (item.content as string[]).join("\n\n") : "";
        const text = completed ? summary || content : (textOf(existing) ?? (summary || content));
        return { ...base, kind: "reasoning", text, streaming: !completed, summary: true };
      }
      case "plan":
        return { ...base, kind: "plan", text: completed ? String(item.text ?? "") : (textOf(existing) ?? String(item.text ?? "")) };
      case "commandExecution": {
        const out: CommandExecutionItem = {
          ...base,
          kind: "command_execution",
          callId: String(item.id),
          command: String(item.command ?? "command") || "command",
          status: STATUS[String(item.status)] ?? (completed ? "completed" : "running"),
        };
        if (typeof item.cwd === "string") out.cwd = item.cwd;
        const prior = existing?.kind === "command_execution" ? existing.output : undefined;
        const output = typeof item.aggregatedOutput === "string" && item.aggregatedOutput ? item.aggregatedOutput : prior;
        if (output) out.output = output;
        if (typeof item.exitCode === "number") out.exitCode = item.exitCode;
        if (typeof item.durationMs === "number") out.durationMs = item.durationMs;
        return out;
      }
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
        const out: FileChangeItem = {
          ...base,
          kind: "file_change",
          callId: String(item.id),
          status: STATUS[String(item.status)] ?? (completed ? "completed" : "running"),
          changes: changes.map(mapFileChange),
        };
        return out;
      }
      case "webSearch":
        return { ...base, kind: "web_search", callId: String(item.id), query: String(item.query ?? ""), status: completed ? "completed" : "running" };
      case "mcpToolCall": {
        // Alevr's own MCP tools (subagents, computer use) add their own items.
        if (item.server === "alevr") return undefined;
        if (!completed) return undefined;
        return { ...base, kind: "system_notice", level: "info", text: `Used ${String(item.server)} · ${String(item.tool)}`, code: "mcp_tool" };
      }
      default:
        return undefined;
    }
  }
}

function textOf(item: TurnItem | undefined): string | undefined {
  return item && "text" in item && typeof item.text === "string" ? item.text : undefined;
}

function mapFileChange(c: Record<string, unknown>): FileChangeEntry {
  const kind = c.kind as { type?: string; move_path?: string | null } | undefined;
  const diff = typeof c.diff === "string" ? c.diff : undefined;
  const entry: FileChangeEntry = {
    path: String(c.path ?? ""),
    change: kind?.type === "add" ? "add" : kind?.type === "delete" ? "delete" : kind?.move_path ? "rename" : "modify",
  };
  if (kind?.move_path) {
    entry.previousPath = entry.path;
    entry.path = kind.move_path;
  }
  if (diff) {
    entry.diff = diff;
    let add = 0;
    let del = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    entry.additions = add;
    entry.deletions = del;
  }
  return entry;
}

function threadConfig(mcp: McpEndpoint | undefined): Record<string, unknown> | undefined {
  if (!mcp) return undefined;
  return { mcp_servers: { [mcp.name]: { url: mcp.url, http_headers: { Authorization: mcp.authorization } } } };
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof JsonRpcError && error.data && typeof error.data === "object") {
    const info = (error.data as { codexErrorInfo?: unknown }).codexErrorInfo;
    if (typeof info === "string") return info;
  }
  return undefined;
}
