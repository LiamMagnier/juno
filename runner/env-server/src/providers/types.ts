/**
 * One adapter per provider kind, all behind the same interface (SPEC §2).
 *
 * An adapter turns a vendor runtime (the user's own `claude`, `codex
 * app-server`, an ACP agent, or Alevr's own engine) into normalized TurnItems.
 * It never decides policy: approvals go to the user through the sink, limits
 * are reported, and capabilities are declared honestly so the UI branches on
 * them rather than on the vendor's name.
 */
import type {
  ApprovalDecision,
  ApprovalRequestItem,
  InteractionMode,
  ModelSelection,
  ProviderCapabilities,
  ProviderInstance,
  ProviderKind,
  ProviderSetupAction,
  ProviderSetupStep,
  RoleRouting,
  RuntimeMode,
  SessionUsage,
  TurnItem,
  TurnOutcome,
  UsageWindow,
  UserInput,
  UserInputRequestItem,
  EnvBackendConfig,
  ByokKey,
  AgentControlResult,
} from "../contracts/code-v2.js";
import type { Logger } from "../util.js";

export interface ApprovalAnswer {
  decision: ApprovalDecision;
  updatedInput?: Record<string, unknown>;
  answers?: Record<string, string[]>;
}

/** What an adapter may do to the session while a turn runs. */
export interface TurnSink {
  /** Adds the item, or replaces the item with the same id. */
  item(item: TurnItem): void;
  /** Streams text into an item already added. */
  delta(itemId: string, field: "text" | "output", append: string): void;
  usage(usage: SessionUsage): void;
  /** Subscription windows observed mid-turn (Claude rate_limit_event, Codex rateLimits/updated). */
  limits(windows: UsageWindow[]): void;
  notice(level: "info" | "warning", text: string, code?: string): void;
  /** Blocks until the user decides. The sink adds/updates the approval_request item. */
  requestApproval(
    request: Pick<ApprovalRequestItem, "callId" | "action" | "summary" | "justification" | "detail" | "options" | "agentId" | "agentLabel"> & {
      requestId?: string;
      /**
       * True when Full access would run this call without asking (inside the
       * project). Kept by the session, never sent: a switch to Full access while
       * the request waits answers it.
       */
      fullAccessAllows?: boolean;
    },
  ): Promise<ApprovalAnswer>;
  requestUserInput(request: Pick<UserInputRequestItem, "questions"> & { requestId?: string }): Promise<ApprovalAnswer>;
  /** Generates a session-unique item id. */
  newItemId(prefix?: string): string;
  /** ISO time for createdAt. */
  now(): string;
}

/** The Alevr MCP endpoint a vendor agent is given for this session (SPEC §3.11). */
export interface McpEndpoint {
  name: string;
  url: string;
  /** Full Authorization header value. */
  authorization: string;
}

export interface TurnRequest {
  sessionId: string;
  turnId: string;
  /** 1-based. */
  turnOrdinal: number;
  cwd: string;
  input: UserInput;
  selection: ModelSelection;
  routing?: RoleRouting;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  sink: TurnSink;
  signal: AbortSignal;
  /**
   * skills lane: the instructions of the skills this turn runs under, for an
   * engine that takes them in its system prompt (Alevr's). Vendor runtimes get
   * them ahead of `input.text` instead and never see this field.
   */
  skillInstructions?: string;
}

export interface TurnResult {
  outcome: TurnOutcome;
  message?: string;
  /** For `limited`: when the window resets (ISO-8601). */
  resumeAt?: string;
  usage?: SessionUsage;
}

/** A live connection to a vendor runtime for one Alevr session. */
export interface ProviderSession {
  runTurn(request: TurnRequest): Promise<TurnResult>;
  /** Injects input into the running turn. Resolves false when it could not (the caller queues instead). */
  steer?(input: UserInput): Promise<boolean>;
  messageAgent?(agentId: string, text: string): Promise<{ accepted: boolean; message?: string }>;
  interruptAgent?(agentId: string): Promise<void>;
  /** Agents lane (REA backlog 10): a person's Pause / Resume, one child or (no id) every child, between steps. */
  pauseAgent?(agentId?: string): Promise<AgentControlResult>;
  resumeAgent?(agentId?: string): Promise<AgentControlResult>;
  /** A person's bounded top-up: one child's token cap, or (no id) the run budget. The engine enforces the bounds. */
  topUpAgent?(agentId: string | undefined, add: { tokens?: number; usd?: number }): Promise<AgentControlResult>;
  interrupt(): Promise<void>;
  /**
   * The thread's mode changed while a turn may be running (the composer's
   * access picker, on the Mac or a paired phone). Approvals raised from now on
   * follow the new mode; the next turn passes it again through `runTurn`.
   */
  setRuntimeMode?(runtimeMode: RuntimeMode, interactionMode: InteractionMode, cwd?: string): void;
  /** Rewinds the vendor conversation so the next turn follows turn `ordinal` (0 = before the first turn). */
  rewindTo?(ordinal: number): Promise<boolean>;
  close(): Promise<void>;
  /** Opaque state persisted in SessionMeta.providerState so the vendor session can be resumed. */
  resumeState(): Record<string, unknown>;
}

export interface OpenSessionOptions {
  sessionId: string;
  cwd: string;
  selection: ModelSelection;
  resumeState?: Record<string, unknown>;
  mcp?: McpEndpoint;
  /** Tools for the built-in engine (no MCP): agent-core ToolDefinitions, opaque here. */
  extraTools?: unknown[];
  logger: Logger;
}

/** Fields a probe may fill in on an instance. Probes never open sessions, run hooks or start logins. */
export type ProbeResult = Partial<
  Pick<
    ProviderInstance,
    "status" | "statusMessage" | "version" | "account" | "limits" | "models" | "capabilities" | "binaryPath" | "acpCommand" | "install" | "auth"
  >
> & {
  /**
   * The vendor's usage API said "too many requests": wait this long before
   * asking it again. Kept by the registry, never sent to clients.
   */
  retryAfterMs?: number;
};

export interface ProbeOptions {
  logger: Logger;
  timeoutMs?: number;
  cwd?: string;
}

/** Process-wide settings the client pushes with env.configure. Kept in memory only. */
export interface EnvSecrets {
  backend?: EnvBackendConfig;
  byok: Map<string, ByokKey>;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  capabilities(instance: ProviderInstance): ProviderCapabilities;
  probe(instance: ProviderInstance, options: ProbeOptions): Promise<ProbeResult>;
  openSession(instance: ProviderInstance, options: OpenSessionOptions): Promise<ProviderSession>;
  /** The step the user runs in a terminal for install / login; null when nothing is needed or possible. */
  setup(instance: ProviderInstance, action: ProviderSetupAction): ProviderSetupStep | null;
  /**
   * The shortest gap between two automatic probes of one instance (a client's
   * `provider.probe` with `maxAgeMs`): how often the vendor's usage API may be
   * asked, or how often it is worth starting the runtime at all. A manual
   * Re-check (no `maxAgeMs`) is not held to it. Default: the registry's cache.
   */
  minProbeIntervalMs?(instance: ProviderInstance): number;
}

export const NO_CAPABILITIES: ProviderCapabilities = {
  steering: false,
  queue: true,
  interrupt: false,
  resume: false,
  fork: false,
  rollback: false,
  planMode: false,
  approvals: [],
  subagents: false,
  computerUse: false,
  contextTiers: false,
  effortLevels: [],
  images: false,
  mcpInjection: false,
};
