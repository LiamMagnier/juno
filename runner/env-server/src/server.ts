/**
 * The Alevr local environment server (SPEC §2, §3.1).
 *
 * One HTTP listener on 127.0.0.1:
 *   GET  /health  — liveness and protocol version (no secrets, no auth)
 *   POST /mcp     — the Alevr MCP server for vendor agents (scoped bearer)
 *   WS   /        — the alevr-code-v2 wire protocol (per-launch bearer)
 *
 * The WebSocket bearer is minted per launch and handed to the Mac app on
 * stdout; it travels as `Authorization: Bearer …`, or for clients that cannot
 * set headers as the subprotocol `alevr-token.<token>`. Host must be a
 * loopback name (DNS-rebinding guard) and browser Origins are refused unless
 * explicitly allowed.
 */
import http, { type IncomingMessage } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CODE_V2_PROTOCOL,
  isClientCommandType,
  type ByokKey,
  type ClientCommand,
  type ClientCommandParams,
  type ClientCommandResults,
  type ClientCommandType,
  type ProviderInstance,
  type ProviderKind,
  type ServerEvent,
  type ServerEventEnvelope,
  type ServerResponse,
  type UserInput,
} from "./contracts/code-v2.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { EnvSecrets, ProviderAdapter } from "./providers/types.js";
import { ClaudeAgentAdapter, type ClaudeQueryFn } from "./providers/claude-agent.js";
import { CodexAdapter } from "./providers/codex.js";
import { AcpAdapter, type McpBridgeCommand } from "./providers/acp.js";
import { AlevrEngineAdapter, type AlevrEngine } from "./providers/alevr.js";
import { AntigravityError, AntigravityService, isAntigravity, type AntigravityServiceOptions } from "./providers/antigravity/service.js";
import { SessionManager, WireError } from "./sessions/session-manager.js";
import { AlevrMcpServer } from "./mcp/alevr-mcp.js";
import { registerSubagentTools } from "./mcp/subagent-tools.js";
import { registerComputerUseOnAlevrMcp, type ComputerMcpScope } from "./mcp/computer-mcp-hook.js";
import { createUnixSocketBridge, DEFAULT_BRIDGE_SOCKET_PATH, type ComputerBridge } from "./mcp/computer-bridge.js";
import type { ComputerToolSession } from "./mcp/computer-tools.js";
import type { DesktopLock } from "./mcp/desktop-lock.js";
import { TerminalManager } from "./terminal/terminals.js";
import { describeError, newToken, nowIso, stderrLogger, type Logger } from "./util.js";
import { ConversationHub, conversationEngineTools, type BackendLink } from "./conversations/hub.js";
import { registerConversationTools } from "./mcp/conversation-tools.js";

export interface EnvServerOptions {
  /** Tests: the fetch the cross-conversation tools reach Alevr's backend with. */
  conversationsFetch?: typeof fetch;
  /** Default ~/.alevr/env. */
  dataDir?: string;
  /** 0 = any free port. */
  port?: number;
  /** Per-launch bearer; generated when absent. */
  token?: string;
  logger?: Logger;
  /** Origins (browser) allowed to connect, e.g. the web dev server. Default none. */
  allowedOrigins?: string[];
  /** Delta coalescing window (ms); default 50. */
  coalesceMs?: number;
  /** Test seams. */
  searchDirs?: string[];
  claudeQuery?: ClaudeQueryFn;
  alevrEngine?: AlevrEngine;
  mcpBridge?: McpBridgeCommand;
  forcePipeTerminals?: boolean;
  /** Shell for in-app terminals (default: $SHELL). Tests pin /bin/sh. */
  terminalShell?: string;
  /** Extra adapters (tests) or replacements by kind. */
  adapters?: ProviderAdapter[];
  /** Probe every installed instance after start (default true). */
  probeOnStart?: boolean;
  /** Antigravity test seams (release, fetch, search dirs, Node path). */
  antigravity?: Partial<Pick<AntigravityServiceOptions, "release" | "fetchImpl" | "searchDirs" | "nodePath" | "authTimeoutMs">>;
  /**
   * `computer_use` on the Alevr MCP server (SPEC §3.12), executed by the Mac
   * app's computer bridge. Default: on, through the bridge's Unix socket, and
   * offered to a session only while that socket exists (the Mac app is
   * running its bridge). `false` (or ALEVR_COMPUTER_USE=0) turns it off.
   */
  computerUse?: false | ComputerUseConfig;
}

export interface ComputerUseConfig {
  bridge?: ComputerBridge;
  /** Whether the Mac app's bridge is up (default: its socket exists). */
  available?: () => boolean;
  /** The desktop lock shared with the Mac app (default: the app's lock file). */
  lock?: DesktopLock;
}

export interface EnvServer {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly dataDir: string;
  readonly sessions: SessionManager;
  readonly registry: ProviderRegistry;
  readonly mcp: AlevrMcpServer;
  readonly terminals: TerminalManager;
  readonly secrets: EnvSecrets;
  readonly antigravity: AntigravityService;
  readonly conversations: ConversationHub;
  close(): Promise<void>;
}

export function defaultDataDir(): string {
  return process.env.ALEVR_ENV_HOME || path.join(os.homedir(), ".alevr", "env");
}

export async function startEnvServer(options: EnvServerOptions = {}): Promise<EnvServer> {
  const logger = options.logger ?? stderrLogger((process.env.ALEVR_ENV_LOG as "debug" | "info" | undefined) ?? "info");
  const dataDir = options.dataDir ?? defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = options.token ?? newToken();
  const secrets: EnvSecrets = { byok: new Map() };
  const connections = new Set<Connection>();

  const broadcast = (event: ServerEvent) => {
    for (const c of connections) c.sendGlobal(event);
  };

  let registryRef: ProviderRegistry | undefined;
  const antigravity = new AntigravityService({
    dataDir,
    logger,
    ...(options.searchDirs ? { searchDirs: () => options.searchDirs! } : {}),
    ...(options.antigravity ?? {}),
    publish: (instanceId, patch) => {
      const registry = registryRef;
      if (!registry) return;
      const ids = instanceId === "*" ? registry.antigravityIds() : [instanceId];
      for (const id of ids) {
        const { install: _install, auth: _auth, ...rest } = patch;
        // install/auth are decorated from the service on read; an update just re-broadcasts them.
        registry.update(id, rest);
        if (patch.install?.phase === "succeeded") void registry.probe(id).catch(() => undefined);
      }
    },
  });

  const adapters = new Map<ProviderKind, ProviderAdapter>();
  const builtIns: ProviderAdapter[] = [
    new AlevrEngineAdapter("alevr", secrets, options.alevrEngine ? { engine: options.alevrEngine } : {}),
    new AlevrEngineAdapter("byok", secrets, options.alevrEngine ? { engine: options.alevrEngine } : {}),
    new ClaudeAgentAdapter(options.claudeQuery ? { queryFn: options.claudeQuery } : {}),
    new CodexAdapter(),
    new AcpAdapter({ ...(options.mcpBridge ? { mcpBridge: options.mcpBridge } : {}), antigravity }),
  ];
  for (const a of [...builtIns, ...(options.adapters ?? [])]) adapters.set(a.kind, a);

  const registry = new ProviderRegistry({
    dataDir,
    adapters,
    logger,
    ...(options.searchDirs ? { searchDirs: options.searchDirs } : {}),
    onUpdate: (instance) => broadcast({ type: "provider.updated", instance }),
    antigravity,
  });
  registryRef = registry;
  const mcp = new AlevrMcpServer(logger);
  let port = 0;
  const sessions = new SessionManager({
    dataDir,
    registry,
    mcp,
    logger,
    baseUrl: () => `http://127.0.0.1:${port}`,
    ...(options.coalesceMs !== undefined ? { coalesceMs: options.coalesceMs } : {}),
  });
  const removeSubagentTools = registerSubagentTools(mcp, sessions);
  const conversations = new ConversationHub({
    sessions,
    dataDir,
    logger,
    backend: () => backendLink(secrets),
    ...(options.conversationsFetch ? { fetch: options.conversationsFetch } : {}),
  });
  const removeConversationTools = registerConversationTools(mcp, conversations);
  sessions.setEngineTools((sessionId) => (conversations.enabledFor(sessionId) ? conversationEngineTools(conversations, sessionId) : []));
  const computer = computerUseEnabled(options) ? registerComputerUse(mcp, sessions, options.computerUse || {}) : undefined;
  const removeComputerClose = computer ? sessions.onSessionClosed((id) => computer.disposeSession(id)) : undefined;
  const terminals = new TerminalManager(
    {
      output: (terminalId, data) => broadcast({ type: "terminal.output", terminalId, data }),
      exited: (terminalId, exitCode) => broadcast({ type: "terminal.exited", terminalId, ...(exitCode !== undefined ? { exitCode } : {}) }),
    },
    logger,
    { forcePipe: options.forcePipeTerminals ?? false, ...(options.terminalShell ? { shell: options.terminalShell } : {}) },
  );

  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const server = http.createServer((req, res) => {
    if (!hostOk(req, port)) {
      res.writeHead(421).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, protocol: CODE_V2_PROTOCOL }));
      return;
    }
    if (url.pathname === "/mcp") {
      void mcp.handle(req, res).catch((e) => {
        logger.warn(`mcp: ${describeError(e)}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(CODE_V2_PROTOCOL.name) ? CODE_V2_PROTOCOL.name : false),
  });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    if (!hostOk(req, port) || (origin && !allowedOrigins.has(origin)) || !authorized(req, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = new Connection(ws, { sessions, registry, terminals, secrets, logger, antigravity, conversations });
      connections.add(connection);
      ws.on("close", () => {
        connection.dispose();
        connections.delete(connection);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  logger.info(`listening on 127.0.0.1:${port}`);
  // Schedules saved before a restart: armed once the listener (and its MCP endpoint) is up.
  sessions.restoreSchedules();

  if (options.probeOnStart ?? true) {
    setTimeout(() => void registry.probeAll().catch(() => undefined), 500).unref?.();
  }

  return {
    port,
    token,
    url: `ws://127.0.0.1:${port}`,
    dataDir,
    sessions,
    registry,
    mcp,
    terminals,
    secrets,
    antigravity,
    conversations,
    close: async () => {
      removeSubagentTools();
      removeConversationTools();
      conversations.dispose();
      removeComputerClose?.();
      for (const c of connections) c.dispose();
      for (const ws of wss.clients) ws.terminate();
      terminals.closeAll();
      await sessions.shutdown();
      await antigravity.shutdown();
      await computer?.dispose();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function computerUseEnabled(options: EnvServerOptions): boolean {
  if (options.computerUse === false) return false;
  return process.env.ALEVR_COMPUTER_USE !== "0";
}

/** The session behind an MCP scope, as computer use needs it; undefined hides the tool. */
export function computerSessionFor(sessions: SessionManager, scope: ComputerMcpScope): ComputerToolSession | undefined {
  if (!sessions.has(scope.sessionId)) return undefined;
  let meta;
  try {
    meta = sessions.log(scope.sessionId).meta;
  } catch {
    return undefined;
  }
  const model = `${meta.selection.instanceId} ${meta.selection.model}`.toLowerCase();
  return {
    id: scope.sessionId,
    title: meta.title ?? "Alevr Code",
    runtimeMode: meta.runtimeMode,
    // Gemini-family models point in 0-999 on each axis.
    coordinateSpace: model.includes("gemini") ? "normalized_1000" : "pixels",
    images: true,
  };
}

function registerComputerUse(mcp: AlevrMcpServer, sessions: SessionManager, config: ComputerUseConfig) {
  const available = config.available ?? (() => fs.existsSync(DEFAULT_BRIDGE_SOCKET_PATH));
  return registerComputerUseOnAlevrMcp(mcp, {
    bridge: config.bridge ?? createUnixSocketBridge(),
    ...(config.lock ? { lock: config.lock } : {}),
    session: (scope) => (available() ? computerSessionFor(sessions, scope) : undefined),
    onItem: (sessionId, item) => {
      try {
        sessions.upsertItem(sessionId, item);
      } catch {
        /* the session closed mid-call */
      }
    },
  });
}

function hostOk(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const candidates: string[] = [];
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) candidates.push(auth.slice(7).trim());
  const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim());
  for (const p of protocols) if (p.startsWith("alevr-token.")) candidates.push(p.slice("alevr-token.".length));
  return candidates.some((c) => safeEqual(c, token));
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

interface ConnectionDeps {
  sessions: SessionManager;
  registry: ProviderRegistry;
  terminals: TerminalManager;
  secrets: EnvSecrets;
  logger: Logger;
  antigravity?: AntigravityService;
  conversations?: ConversationHub;
}

/** One client connection: command dispatch, session subscriptions, global stream. */
export class Connection {
  #globalSequence = 0;
  #subscriptions = new Map<string, () => void>();
  #disposed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: ConnectionDeps,
  ) {
    ws.on("message", (data) => void this.#onMessage(data.toString()));
  }

  dispose(): void {
    this.#disposed = true;
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
  }

  send(message: ServerResponse | ServerEventEnvelope): void {
    if (this.#disposed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  sendGlobal(event: ServerEvent): void {
    this.send({ type: "event", stream: "global", sequence: ++this.#globalSequence, at: nowIso(), event });
  }

  async #onMessage(raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send({ type: "response", id: "", ok: false, error: { code: "bad_request", message: "Not JSON." } });
      return;
    }
    const m = msg as Partial<ClientCommand>;
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || !isClientCommandType(m.type) || !m.params || typeof m.params !== "object") {
      this.send({ type: "response", id, ok: false, error: { code: "bad_request", message: "Expected {id, type, params}." } });
      return;
    }
    try {
      const result = await dispatchCommand(this.deps, m as ClientCommand, this);
      this.send({ type: "response", id, ok: true, ...(result === undefined ? {} : { result }) });
      if (m.type === "session.open") this.#afterOpen(m as Extract<ClientCommand, { type: "session.open" }>, (result as { sessionId: string }).sessionId);
    } catch (error) {
      const code = error instanceof WireError ? error.code : ((error as { wireCode?: WireError["code"] }).wireCode ?? "internal");
      this.send({ type: "response", id, ok: false, error: { code, message: describeError(error) } });
    }
  }

  /** Snapshot (or replay) then live events — read and subscribed in one synchronous block, so nothing falls between. */
  #afterOpen(cmd: Extract<ClientCommand, { type: "session.open" }>, sessionId: string): void {
    const log = this.deps.sessions.log(sessionId);
    this.#subscriptions.get(sessionId)?.();
    const after = cmd.params.afterSequence;
    const replay = after !== undefined ? log.eventsAfter(after) : null;
    if (replay) {
      for (const e of replay) this.send(e);
    } else {
      const { snapshotSequence, session } = log.snapshotAt();
      this.send({ type: "event", stream: "session", sessionId, sequence: snapshotSequence, at: nowIso(), event: { type: "session.snapshot", snapshotSequence, session } });
    }
    this.#subscriptions.set(sessionId, log.subscribe((envelope) => this.send(envelope)));
  }
}

/** Executes one command against the server state. Shared by the WebSocket and the device relay. */
export async function dispatchCommand(deps: ConnectionDeps, cmd: ClientCommand, _connection?: Connection): Promise<unknown> {
  const { sessions, registry, terminals, secrets } = deps;
  const type: ClientCommandType = cmd.type;
  switch (cmd.type) {
    case "session.open": {
      const log = await sessions.open(cmd.params);
      return { sessionId: log.id };
    }
    case "session.list":
      return { sessions: sessions.list(cmd.params) };
    case "session.close":
      await sessions.close(cmd.params.sessionId);
      return {};
    // A person's own input ends any chain a cross-conversation message started,
    // and a client can never pass one off as such a message.
    case "turn.start":
      deps.conversations?.noteUserInput(cmd.params.sessionId);
      return sessions.startTurn({ ...cmd.params, input: userOnly(cmd.params.input) });
    case "turn.steer":
      deps.conversations?.noteUserInput(cmd.params.sessionId);
      return sessions.steer({ ...cmd.params, input: userOnly(cmd.params.input) });
    case "turn.queue":
      deps.conversations?.noteUserInput(cmd.params.sessionId);
      return sessions.queue({ ...cmd.params, input: userOnly(cmd.params.input) });
    case "conversation.deliver":
      if (!deps.conversations) throw new WireError("unsupported", "Conversations cannot message each other here.");
      return deps.conversations.deliver(cmd.params.sessionId, cmd.params.message);
    case "conversation.read":
      if (!deps.conversations) throw new WireError("unsupported", "Conversations cannot message each other here.");
      return deps.conversations.readLocal(cmd.params.sessionId, cmd.params.lastN);
    case "conversation.toggle":
      if (!deps.conversations) throw new WireError("unsupported", "Conversations cannot message each other here.");
      return deps.conversations.toggle(cmd.params.sessionId, cmd.params.enabled);
    case "turn.interrupt":
      await sessions.interrupt(cmd.params);
      return {};
    case "approval.respond":
      sessions.respond(cmd.params);
      return {};
    case "checkpoint.rollback":
      return sessions.rollback(cmd.params);
    case "checkpoint.diff":
      return sessions.diff(cmd.params);
    case "checkpoint.applyPatch":
      return sessions.applyPatch(cmd.params);
    case "turn.schedule":
      return sessions.schedule(cmd.params);
    case "turn.unschedule":
      return sessions.unschedule(cmd.params);
    case "provider.install":
      return providerInstall(deps, cmd.params);
    case "provider.auth":
      return providerAuth(deps, cmd.params);
    case "provider.list": {
      const instances = registry.list().map((i) => {
        const adapter = registry.adapterFor(i.kind);
        return adapter && !i.capabilities ? { ...i, capabilities: adapter.capabilities(i) } : i;
      });
      return { instances };
    }
    case "provider.probe": {
      if (!registry.get(cmd.params.instanceId)) throw new WireError("not_found", `No provider instance ${cmd.params.instanceId}.`);
      return { instance: await registry.probe(cmd.params.instanceId) };
    }
    case "provider.setup": {
      const instance = registry.get(cmd.params.instanceId);
      if (!instance) throw new WireError("not_found", `No provider instance ${cmd.params.instanceId}.`);
      const adapter = registry.adapterFor(instance.kind);
      return { step: adapter?.setup(instance, cmd.params.action) ?? null };
    }
    case "terminal.open":
      return { terminalId: terminals.open(cmd.params).terminalId };
    case "terminal.write":
      terminals.write(cmd.params.terminalId, cmd.params.data);
      return {};
    case "terminal.resize":
      terminals.resize(cmd.params.terminalId, cmd.params.cols, cmd.params.rows);
      return {};
    case "terminal.close":
      terminals.close(cmd.params.terminalId);
      return {};
    case "env.configure": {
      if (cmd.params.backend) {
        const b = cmd.params.backend;
        if (!/^https?:\/\//.test(b.baseUrl)) throw new WireError("bad_request", "backend.baseUrl must be http(s).");
        secrets.backend = {
          baseUrl: b.baseUrl.replace(/\/+$/, ""),
          authorization: b.authorization,
          ...(b.models ? { models: b.models } : {}),
          ...(b.deviceId ? { deviceId: b.deviceId } : {}),
          ...(typeof b.crossMessages === "boolean" ? { crossMessages: b.crossMessages } : {}),
        };
      }
      if (cmd.params.byok) {
        const keys: ByokKey[] = cmd.params.byok;
        secrets.byok.clear();
        for (const k of keys) secrets.byok.set(k.provider, k);
        for (const instance of registry.list()) if (instance.kind === "byok" && !secrets.byok.has(instance.id.slice(5))) registry.remove(instance.id);
        for (const k of keys) registry.ensure({ id: `byok:${k.provider}`, kind: "byok", label: `${labLabel(k.provider)} (your API key)`, status: "unknown" });
      }
      for (const instance of registry.list()) if (instance.kind === "alevr" || instance.kind === "byok") void registry.probe(instance.id).catch(() => undefined);
      return {};
    }
    default: {
      const never: never = cmd;
      throw new WireError("unsupported", `Unknown command ${String(type)} ${String(never)}`);
    }
  }
}

/** The managed-runtime instance a provider.install / provider.auth names (Antigravity today). */
function managedInstance(deps: ConnectionDeps, instanceId: unknown): { instance: ProviderInstance; service: AntigravityService } {
  if (typeof instanceId !== "string") throw new WireError("bad_request", "instanceId is required.");
  const instance = deps.registry.get(instanceId);
  if (!instance) throw new WireError("not_found", `No provider instance ${instanceId}.`);
  if (!deps.antigravity || !isAntigravity(instance)) throw new WireError("unsupported", `${instance.label} installs and signs in through its own CLI (provider.setup).`);
  return { instance, service: deps.antigravity };
}

function wire<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof AntigravityError) throw new WireError(error.wireCode, error.message);
    throw error;
  }
}

async function wireAsync<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AntigravityError) throw new WireError(error.wireCode, error.message);
    throw error;
  }
}

function providerInstall(deps: ConnectionDeps, params: ClientCommandParams["provider.install"]): ClientCommandResults["provider.install"] {
  const { service } = managedInstance(deps, params?.instanceId);
  if (!["start", "cancel", "remove"].includes(params.action)) throw new WireError("bad_request", "action must be start, cancel or remove.");
  return { install: wire(() => service.install(params.action, params.operationId)) };
}

async function providerAuth(deps: ConnectionDeps, params: ClientCommandParams["provider.auth"]): Promise<ClientCommandResults["provider.auth"]> {
  const { instance, service } = managedInstance(deps, params?.instanceId);
  switch (params.action) {
    case "start":
      // A new sign-in replaces the account the running sessions use: stop them first.
      await deps.sessions.closeProviderSessions(instance.id);
      return { auth: await wireAsync(() => service.authStart(instance)) };
    case "complete":
      return { auth: await wireAsync(() => service.authComplete(instance, params.flowId, params.callbackUrl)) };
    case "cancel":
      return { auth: await wireAsync(() => service.authCancel(instance, params.flowId)) };
    case "logout":
      await deps.sessions.closeProviderSessions(instance.id);
      return { auth: await wireAsync(() => service.logout(instance)) };
    default:
      throw new WireError("bad_request", "action must be start, complete, cancel or logout.");
  }
}

function labLabel(provider: string): string {
  const names: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", xai: "xAI", deepseek: "DeepSeek", openrouter: "OpenRouter" };
  return names[provider] ?? provider;
}

/** Strips a `conversation` marker from a client's own input: only conversation.deliver may set one. */
function userOnly(input: UserInput): UserInput {
  if (!input.conversation) return input;
  const { conversation: _dropped, ...rest } = input;
  return rest;
}

/** The backend the cross-conversation tools call, from what env.configure handed over. */
export function backendLink(secrets: EnvSecrets): BackendLink | undefined {
  const b = secrets.backend;
  if (!b) return undefined;
  let origin: string;
  try {
    origin = new URL(b.baseUrl).origin;
  } catch {
    return undefined;
  }
  return { origin, authorization: b.authorization, ...(b.deviceId ? { deviceId: b.deviceId } : {}), ...(typeof b.crossMessages === "boolean" ? { crossMessages: b.crossMessages } : {}) };
}
