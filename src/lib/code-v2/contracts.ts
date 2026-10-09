// Alevr Code v2 — shared contracts (SPEC docs/code-v2/SPEC.md §2–§4).
//
// Source of truth for every lane: the env server, the agent-core orchestrator,
// the model catalogue, the web workspace and the Mac app all speak these types.
// The JSON Schema twin is contracts/code/alevr-code-v2.schema.json, the
// fixtures are contracts/code/fixtures/*.json, the runner copy is
// runner/agent-core/src/contracts/code-v2.ts (byte-identical) and the Swift
// Codable mirror is native/Packages/JunoCode/Sources/JunoCodeCore/
// CodeV2Contracts.swift. `node scripts/check-code-v2-contracts.mjs` fails when
// any of them drifts; `--write` refreshes the runner copy from this file.
//
// Rules for editing: additive only (new optional fields, new union members at
// the end). This file has no imports and uses only erasable TypeScript, so
// Node can load it directly and agent-core can build it standalone.
/* eslint-disable */

export const CODE_V2_PROTOCOL = {
  name: "alevr-code-v2",
  /** Bumped only on a breaking change; readers reject a different major. */
  major: 1,
  minor: 0,
} as const;

// ── Providers ───────────────────────────────────────────────────────────────

/**
 * How a provider instance runs inference.
 * - alevr: Alevr's own engine on Alevr's keys and plan.
 * - byok: Alevr's engine on the user's own API key (not billed as ApiSpend).
 * - claude-agent: the user's own `claude` CLI through the Claude Agent SDK,
 *   shown as "Claude (your subscription)".
 * - codex: the user's own `codex app-server` (ChatGPT plan).
 * - acp: any Agent Client Protocol runtime (Gemini CLI, Grok, dsh, …).
 */
export const PROVIDER_KIND_VALUES = ["alevr", "byok", "claude-agent", "codex", "acp"] as const;
export type ProviderKind = (typeof PROVIDER_KIND_VALUES)[number];

/** Kinds that run the vendor's own runtime on the user's machine. */
export const LOCAL_SUBSCRIPTION_KINDS: readonly ProviderKind[] = ["claude-agent", "codex", "acp"];

export const PROVIDER_STATUS_VALUES = ["not-installed", "signed-out", "ready", "limited", "error", "unknown"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUS_VALUES)[number];

/** One rolling quota window a subscription reports (Claude 5-hour, Codex weekly…). */
export interface UsageWindow {
  /** Stable per provider ("five_hour", "seven_day", "primary") so sparse updates merge by id. */
  id: string;
  label: string;
  /** 0–100. */
  usedPct?: number;
  /** ISO-8601. */
  resetsAt?: string;
}

export interface ProviderAccount {
  email?: string;
  /** Plan as the vendor names it ("max", "pro", "plus", "team"). */
  plan?: string;
  /** Where the runtime's credential comes from ("claude.ai", "apiKey", "chatgpt", …). Never the token itself. */
  tokenSource?: string;
}

export const EFFORT_LEVEL_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVEL_VALUES)[number];

export const RUNTIME_MODE_VALUES = ["read-only", "ask", "auto-edit", "auto", "full"] as const;
/** Sandbox × approval presets (SPEC §3.7). */
export type RuntimeMode = (typeof RUNTIME_MODE_VALUES)[number];

export const INTERACTION_MODE_VALUES = ["default", "plan"] as const;
export type InteractionMode = (typeof INTERACTION_MODE_VALUES)[number];

/**
 * What an instance can honestly do. The UI branches on these, never on the
 * vendor's name.
 */
export interface ProviderCapabilities {
  /** Inject input into a running turn. */
  steering: boolean;
  /** Hold input until the active turn ends. */
  queue: boolean;
  interrupt: boolean;
  resume: boolean;
  fork: boolean;
  /** Restore files and conversation to a checkpoint. */
  rollback: boolean;
  planMode: boolean;
  /** Runtime modes this instance can enforce. */
  approvals: RuntimeMode[];
  subagents: boolean;
  computerUse: boolean;
  /** Offers more than one selectable context window. */
  contextTiers: boolean;
  effortLevels: EffortLevel[];
  images: boolean;
  /** Accepts Alevr's MCP server (subagents on any provider, computer use, thread search). */
  mcpInjection: boolean;
}

/** One selectable context window with its price (SPEC §4). Prices in USD per million tokens. */
export interface ContextTier {
  tokens: number;
  label: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  /** e.g. "2× input above 272K". */
  note?: string;
  /**
   * The catalogue has no verified rate for part of this window (a lab that
   * prices long prompts higher than the rate shown, without the band being
   * recorded). Clients say "price above N not confirmed" rather than imply
   * the shown rate holds for the whole window.
   */
  unverified?: boolean;
}

/** A model an instance offers (Codex `model/list`, the Alevr catalogue, an ACP agent's models). */
export interface ProviderModel {
  /** Id the instance understands (canonical `provider:model` for alevr/byok). */
  id: string;
  label: string;
  contextTiers?: ContextTier[];
  effortLevels?: EffortLevel[];
  defaultEffort?: EffortLevel;
  supportsFast?: boolean;
  isDefault?: boolean;
}

export interface ProviderInstance {
  /** Stable id ("alevr", "claude-agent:default", "codex:work"). Instances isolate accounts. */
  id: string;
  kind: ProviderKind;
  label: string;
  binaryPath?: string;
  /** Per-account config dir (CLAUDE_CONFIG_DIR, CODEX_HOME). Never HOME. */
  configDir?: string;
  env?: Record<string, string>;
  launchArgs?: string[];
  /** argv of an ACP runtime, e.g. ["gemini", "--experimental-acp"]. */
  acpCommand?: string[];
  account?: ProviderAccount;
  status: ProviderStatus;
  /** Plain-language reason for a non-ready status. */
  statusMessage?: string;
  version?: string;
  limits?: UsageWindow[];
  capabilities?: ProviderCapabilities;
  models?: ProviderModel[];
  /** ISO-8601 time of the last probe. */
  checkedAt?: string;
}

// ── Bring your own key (SPEC §2 BYOK) ──────────────────────────────────────

/**
 * Labs whose API keys a user may store for the Alevr engine. Each is one
 * provider instance with id `byok:<provider>` (see `byokInstanceId`); runs on
 * it are routed with the user's key and never billed as Alevr spend.
 */
export const BYOK_PROVIDER_VALUES = ["anthropic", "openai", "google", "xai", "deepseek"] as const;
export type ByokProvider = (typeof BYOK_PROVIDER_VALUES)[number];

export const isByokProvider = (v: unknown): v is ByokProvider =>
  typeof v === "string" && (BYOK_PROVIDER_VALUES as readonly string[]).includes(v);

/** `byok:anthropic` — the provider instance a stored key appears as. */
export function byokInstanceId(provider: ByokProvider): string {
  return `byok:${provider}`;
}

/**
 * The kind an instance id names: `alevr`, `byok:<provider>`, `claude-agent:<name>`,
 * `codex:<name>` or `acp:<name>`. Null for anything else.
 */
export function instanceKindOf(instanceId: string): ProviderKind | null {
  if (instanceId === "alevr") return "alevr";
  const colon = instanceId.indexOf(":");
  if (colon <= 0 || colon === instanceId.length - 1) return null;
  const kind = instanceId.slice(0, colon);
  if (kind === "byok") return isByokProvider(instanceId.slice(colon + 1)) ? "byok" : null;
  return kind === "claude-agent" || kind === "codex" || kind === "acp" ? kind : null;
}

// ── Model and role selection ────────────────────────────────────────────────

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
  /** The chosen ContextTier.tokens; absent = the model's default tier. */
  contextTokens?: number;
  fast?: boolean;
}

export const ROLE_PRESET_VALUES = ["solo", "lead-workers", "best-of-n"] as const;
export type RolePreset = (typeof ROLE_PRESET_VALUES)[number];

export const AGENT_ROLE_VALUES = ["orchestrator", "worker", "reviewer", "explorer", "compaction"] as const;
export type AgentRole = (typeof AGENT_ROLE_VALUES)[number];

export interface RunBudget {
  maxTokens?: number;
  maxUsd?: number;
}

/**
 * Role-based routing (SPEC §3.4). `solo` uses only the orchestrator;
 * `lead-workers` delegates to `workers`; `best-of-n` runs the prompt once per
 * entry of `workers` (each in its own worktree) and the reviewer compares.
 */
export interface RoleRouting {
  orchestrator: ModelSelection;
  workers?: ModelSelection[];
  reviewer?: ModelSelection;
  explorer?: ModelSelection;
  compaction?: ModelSelection;
  preset: RolePreset;
  budget?: RunBudget;
}

/**
 * Short aliases a model or subagent may name. Shared by web, runner and the
 * Mac (CodeModelProviderResolver, ComputerUseRoutes) so they cannot drift.
 */
export const CODE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: "anthropic:claude-opus-5-5",
  max: "anthropic:claude-opus-5-5",
  sonnet: "anthropic:claude-sonnet-5-5",
  pro: "anthropic:claude-sonnet-5-5",
  haiku: "anthropic:claude-haiku-4-5",
  flash: "google:gemini-3.8-flash",
  fast: "google:gemini-3.8-flash",
};

/** Canonical `provider:model` for an alias; any other id is returned trimmed. */
export function resolveModelAlias(modelId: string): string {
  const trimmed = modelId.trim();
  return CODE_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * How each runtime mode maps onto the vendor runtimes (SPEC §2). `ask` is
 * T3's "Supervised": every write or command asks.
 */
export const RUNTIME_MODE_VENDOR_MAP: Readonly<
  Record<
    RuntimeMode,
    {
      claudePermissionMode: "plan" | "default" | "acceptEdits" | "auto" | "bypassPermissions";
      codex: {
        approvalPolicy: "untrusted" | "on-request" | "never";
        approvalsReviewer: "user" | "auto_review";
        sandbox: "readOnly" | "workspaceWrite" | "dangerFullAccess";
      };
    }
  >
> = {
  "read-only": { claudePermissionMode: "default", codex: { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "readOnly" } },
  ask: { claudePermissionMode: "default", codex: { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "readOnly" } },
  "auto-edit": { claudePermissionMode: "acceptEdits", codex: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspaceWrite" } },
  auto: { claudePermissionMode: "auto", codex: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspaceWrite" } },
  full: { claudePermissionMode: "bypassPermissions", codex: { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "dangerFullAccess" } },
};

// ── Turn items (SPEC §3.2) ──────────────────────────────────────────────────

export const TURN_ITEM_KIND_VALUES = [
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  "todo_list",
  "user_input_request",
  "file_change",
  "command_execution",
  "search",
  "web_search",
  "approval_request",
  "checkpoint",
  "interrupt",
  "system_notice",
  "error",
  "compaction",
  "handoff",
  "subagent",
  "computer_action",
] as const;
export type TurnItemKind = (typeof TURN_ITEM_KIND_VALUES)[number];

export const ITEM_STATUS_VALUES = ["pending", "running", "completed", "failed", "declined", "interrupted"] as const;
/** Lifecycle of a tool-like item. */
export type ItemStatus = (typeof ITEM_STATUS_VALUES)[number];

export const APPROVAL_DECISION_VALUES = ["accept", "acceptForSession", "decline", "cancel"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISION_VALUES)[number];

export const STEP_STATUS_VALUES = ["pending", "in_progress", "completed"] as const;
export type StepStatus = (typeof STEP_STATUS_VALUES)[number];

export const COMPUTER_ACTION_VALUES = [
  "screenshot",
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "wait",
  "open_app",
  "zoom",
  // Accessibility-tree targeting and menus (SPEC §3.12, lane "computer").
  "ax_find",
  "ax_press",
  "menu",
] as const;
export type ComputerActionKind = (typeof COMPUTER_ACTION_VALUES)[number];

export const SUBAGENT_STATUS_VALUES = ["running", "waiting", "completed", "failed", "interrupted"] as const;
export type SubagentStatus = (typeof SUBAGENT_STATUS_VALUES)[number];

export interface Attachment {
  name: string;
  mediaType: string;
  /** Opaque reference the server resolves (upload id, file path, screenshot ref). */
  ref: string;
}

export interface UserInput {
  text: string;
  attachments?: Attachment[];
}

export interface TokenCount {
  input: number;
  output: number;
  cachedInput?: number;
}

interface TurnItemBase {
  /** Unique within the session. */
  id: string;
  turnId?: string;
  /** ISO-8601. */
  createdAt: string;
}

export interface UserMessageItem extends TurnItemBase {
  kind: "user_message";
  text: string;
  attachments?: Attachment[];
  /** How it reached the agent: a new turn, steered into the active one, or queued. */
  delivery?: "send" | "steer" | "queue";
}
export interface AssistantMessageItem extends TurnItemBase {
  kind: "assistant_message";
  text: string;
  streaming: boolean;
  /** Set when a subagent, not the orchestrator, wrote it. */
  agentId?: string;
}
export interface ReasoningItem extends TurnItemBase {
  kind: "reasoning";
  text: string;
  streaming: boolean;
  summary?: boolean;
}
export interface PlanStep {
  text: string;
  status: StepStatus;
}
export interface PlanItem extends TurnItemBase {
  kind: "plan";
  text: string;
  steps?: PlanStep[];
  /** Plan mode: the plan is waiting for the user to approve it. */
  awaitingApproval?: boolean;
}
export interface TodoListItem extends TurnItemBase {
  kind: "todo_list";
  todos: { id?: string; text: string; status: StepStatus }[];
}
export interface UserInputQuestion {
  id: string;
  prompt: string;
  options?: string[];
  multiSelect?: boolean;
}
export interface UserInputRequestItem extends TurnItemBase {
  kind: "user_input_request";
  requestId: string;
  questions: UserInputQuestion[];
  answers?: Record<string, string[]>;
  status: "pending" | "answered" | "cancelled";
}
export interface FileChangeEntry {
  path: string;
  change: "add" | "modify" | "delete" | "rename";
  previousPath?: string;
  /** Unified diff. */
  diff?: string;
  additions?: number;
  deletions?: number;
}
export interface FileChangeItem extends TurnItemBase {
  kind: "file_change";
  callId: string;
  changes: FileChangeEntry[];
  status: ItemStatus;
}
export interface CommandExecutionItem extends TurnItemBase {
  kind: "command_execution";
  callId: string;
  command: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  /** Moved to a background job (bash timeout, SPEC §3.10). */
  background?: boolean;
  status: ItemStatus;
}
export interface SearchItem extends TurnItemBase {
  kind: "search";
  callId: string;
  query: string;
  scope?: "files" | "content" | "symbols";
  matches?: number;
  status: ItemStatus;
}
export interface WebSearchItem extends TurnItemBase {
  kind: "web_search";
  callId: string;
  query: string;
  results?: { title: string; url: string }[];
  status: ItemStatus;
}
export interface ApprovalRequestItem extends TurnItemBase {
  kind: "approval_request";
  /** The tool call this approval is bound to. */
  callId: string;
  requestId: string;
  action: "command" | "file_change" | "permissions" | "tool" | "computer";
  summary: string;
  /** The model's one-line reason (SPEC §3.7). */
  justification?: string;
  detail?: string;
  /** Decisions the user may pick for this request. */
  options?: ApprovalDecision[];
  decision?: ApprovalDecision;
  status: "pending" | "resolved" | "expired";
  // web lane (additive, DESIGN §5.14): who is asking, for the takeover header.
  /** The subagent that asked; absent when the lead (orchestrator) asked. */
  agentId?: string;
  /** How the takeover names the asker ("Worker 3"). */
  agentLabel?: string;
}
export interface CheckpointItem extends TurnItemBase {
  kind: "checkpoint";
  checkpointId: string;
  turnOrdinal: number;
  /** Hidden git ref, refs/alevr/checkpoints/<thread>/turn/<n>. */
  ref?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}
export interface InterruptItem extends TurnItemBase {
  kind: "interrupt";
  reason: "user" | "limit" | "budget" | "error";
  message?: string;
  /** For `limit`: when the subscription window resets (ISO-8601). */
  resumeAt?: string;
}
export interface SystemNoticeItem extends TurnItemBase {
  kind: "system_notice";
  level: "info" | "warning";
  text: string;
  code?: string;
}
export interface ErrorItem extends TurnItemBase {
  kind: "error";
  message: string;
  code?: string;
  retryable?: boolean;
}
export interface CompactionItem extends TurnItemBase {
  kind: "compaction";
  beforeTokens: number;
  afterTokens: number;
  strategy?: "prune" | "offload" | "summarize";
  summary?: string;
}
export interface HandoffItem extends TurnItemBase {
  kind: "handoff";
  from?: ModelSelection;
  to: ModelSelection;
  reason?: string;
}
export interface SubagentItem extends TurnItemBase {
  kind: "subagent";
  agentId: string;
  role: AgentRole;
  model: ModelSelection;
  status: SubagentStatus;
  /** The task it was given, as the parent wrote it. */
  task?: string;
  /** The child's final message, delivered to the parent once as its settlement notice. */
  closingText?: string;
  tokens?: TokenCount;
  // web lane (additive, DESIGN §5.12): what the agent tree and the Agents dock show.
  /** Short task title the lead gave it ("Server route for the total"). */
  title?: string;
  /** How the tree names it ("Worker 2", "Explorer", "Candidate B"). */
  label?: string;
  /** Its current activity in a sentence, while running or waiting. */
  liveLine?: string;
  elapsedMs?: number;
  /** Alevr / BYOK spend; absent for subscription instances. */
  costUsd?: number;
  /** The worktree branch it writes to (Best of N candidates, writing workers). */
  worktreeBranch?: string;
  /** Best of N: the candidate's result summary. */
  candidate?: { additions?: number; deletions?: number; filesChanged?: number; testsLine?: string; kept?: boolean };
}
export interface ComputerActionItem extends TurnItemBase {
  kind: "computer_action";
  callId: string;
  action: ComputerActionKind;
  /** What was acted on, in words ("Safari — Address bar", "⌘L"). */
  target?: string;
  screenshotRef?: string;
  status: ItemStatus;
  /** The app the action ran in, by its display name. */
  app?: string;
  /** The one-sentence caption the thread shows ("Clicked the “Save” button in TextEdit."). */
  summary?: string;
  /** Where it landed, as a fraction (0…1 each way) of the screenshot, for the target ring. */
  point?: { x: number; y: number };
  /** Pixel size of the screenshot `screenshotRef` names. */
  frameSize?: { width: number; height: number };
  /** Why it failed or was declined, in a sentence. */
  error?: string;
  durationMs?: number;
}

export type TurnItem =
  | UserMessageItem
  | AssistantMessageItem
  | ReasoningItem
  | PlanItem
  | TodoListItem
  | UserInputRequestItem
  | FileChangeItem
  | CommandExecutionItem
  | SearchItem
  | WebSearchItem
  | ApprovalRequestItem
  | CheckpointItem
  | InterruptItem
  | SystemNoticeItem
  | ErrorItem
  | CompactionItem
  | HandoffItem
  | SubagentItem
  | ComputerActionItem;

// ── Computer use (SPEC §3.12) ───────────────────────────────────────────────
//
// One provider-agnostic function tool, `computer_use`, offered to every model
// that is not on Anthropic's native computer toolset, and served by the
// env-server's Alevr MCP server to subscription agents (Claude, Codex, ACP).
// Its `action` enum is COMPUTER_ACTION_VALUES, so every call maps 1:1 onto a
// `computer_action` turn item. The Mac app executes; the env server reaches it
// over a local socket with the bridge messages below, and both sides honour
// one desktop lock file so two sessions never drive the same pointer.

export const ALEVR_COMPUTER_TOOL_NAME = "computer_use";

export const COMPUTER_COORDINATE_SPACE_VALUES = ["pixels", "normalized_1000"] as const;
/**
 * How `x`/`y` are written: pixels of the latest screenshot (its size is in
 * the result header), or 0…999 on each axis whatever the size.
 */
export type ComputerCoordinateSpace = (typeof COMPUTER_COORDINATE_SPACE_VALUES)[number];

/** Arguments of one `computer_use` call, as the model writes them (snake_case on the wire). */
export interface ComputerToolArgs {
  action: ComputerActionKind;
  /** Bundle id or app name; defaults to the app last used. */
  app?: string;
  x?: number;
  y?: number;
  /** End point of a drag. */
  to_x?: number;
  to_y?: number;
  /** Element id from ax_find ("e12"); replaces x/y for click actions and ax_press. */
  element?: string;
  /** ax_find / ax_press: text to match in titles, labels and values. */
  query?: string;
  /** type: the text. key: a key or chord such as "return" or "cmd+shift+z". */
  text?: string;
  direction?: "up" | "down" | "left" | "right";
  /** scroll: wheel notches (1…30). */
  amount?: number;
  /** wait: seconds (0…30). */
  seconds?: number;
  /** zoom: [x0, y0, x1, y1] in the screenshot's coordinate space. */
  region?: number[];
  /** menu: menu bar titles, e.g. ["File", "Export…"]. */
  path?: string[];
  /** Overrides the route's default coordinate space for this call. */
  coordinate_space?: ComputerCoordinateSpace;
}

/** One call from the env server to the Mac app, a JSON line on the bridge socket. */
export interface ComputerBridgeRequest {
  id: string;
  type: "computer.call" | "computer.status" | "computer.release";
  /** The shared secret from the bridge token file. */
  token: string;
  /** Alevr session (or vendor thread) the call belongs to: the lock holder id. */
  sessionId: string;
  /** Shown in the lock refusal and the overlay ("Fix the export sheet"). */
  title?: string;
  /** The session's runtime mode; the Mac applies the same computer policy as its own sessions. */
  runtimeMode?: RuntimeMode;
  callId?: string;
  args?: ComputerToolArgs;
}

export interface ComputerBridgeImage {
  mediaType: string;
  /** Base64. */
  data: string;
}

/** The Mac app's answer, one JSON line per request. */
export interface ComputerBridgeResponse {
  id: string;
  ok: boolean;
  /** The text the model reads (summary, frame header, notes) or the refusal sentence. */
  text: string;
  image?: ComputerBridgeImage;
  /** The thread item for this call (computer.call only). */
  item?: ComputerActionItem;
  /** computer.status: which macOS grants are missing ("screen_recording", "accessibility"). */
  missingPermissions?: string[];
  /** computer.status: who holds the desktop now. */
  holder?: DesktopLockRecord;
  /** The model must stop: the reader pressed Esc / Stop, or a grant is missing. */
  endsTurn?: boolean;
}

/**
 * The cross-process desktop lock, a JSON file at
 * `~/Library/Application Support/Alevr/computer-use/desktop.lock`. A record is
 * live while its process runs and its heartbeat is newer than
 * DESKTOP_LOCK_STALE_MS; anything else may be taken over.
 */
export interface DesktopLockRecord {
  holderId: string;
  /** Who is driving: a Mac session, a Work task, or an agent through the env server. */
  kind: "code_session" | "work_task" | "env_server";
  title: string;
  pid: number;
  app?: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export const DESKTOP_LOCK_STALE_MS = 15_000;

// ── Env-server wire protocol (SPEC §3.1) ────────────────────────────────────
//
// Transport: one WebSocket (or stdio) carrying JSON messages.
// Client → server: ClientCommand {id, type, params}; the server answers each
// with exactly one ServerResponse {type:"response", id, ok, …}.
// Server → client: ServerEventEnvelope. Session-stream events carry a
// sequence that is monotonic and gap-free per session and durable across
// reconnects; the global stream (providers, terminals) has its own
// per-connection sequence.
//
// Snapshot + cursor: `session.open` without `afterSequence` makes the server
// send `session.snapshot` (envelope sequence = snapshotSequence) followed by
// every later event. With `afterSequence` the server replays events after it
// and only falls back to a snapshot when it no longer holds them. Clients
// apply an event iff sequence === cursor + 1 (see classifyEvent); ≤ cursor is
// a duplicate, > cursor + 1 is a gap → re-open with afterSequence = cursor.
// Text deltas are coalesced server-side into ≤ 50 ms batches.

export const SESSION_STATE_VALUES = ["idle", "running", "waiting", "limited", "error"] as const;
/** waiting = blocked on the user (approval or question); limited = subscription window exhausted. */
export type SessionState = (typeof SESSION_STATE_VALUES)[number];

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Tokens currently in the context window. */
  contextTokens?: number;
  contextWindow?: number;
  /** Absent for subscription providers. */
  costUsd?: number;
  // web lane (additive, DESIGN §5.7): the context gauge.
  /** Token count at which the engine compacts (SPEC §3.5 trigger). */
  autoCompactAt?: number;
  /** Who bills this session's tokens: Alevr, the user's own key, or a subscription plan. */
  billing?: "alevr" | "byok" | "subscription";
}

export interface QueuedInput {
  id: string;
  input: UserInput;
  /** ISO-8601. */
  queuedAt: string;
}

export interface SessionSnapshot {
  id: string;
  cwd: string;
  title?: string;
  selection: ModelSelection;
  routing?: RoleRouting;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  state: SessionState;
  activeTurnId?: string;
  /** ISO-8601, when state is `limited`. */
  resumeAt?: string;
  items: TurnItem[];
  queue: QueuedInput[];
  usage?: SessionUsage;
  /** Set when the session runs in its own git worktree (SPEC §3.9). */
  worktree?: WorktreeInfo;
}

export interface WorktreeInfo {
  /** The worktree directory; equals the session cwd. */
  path: string;
  branch: string;
  /** The repository the worktree was created from. */
  repoRoot: string;
}

export const CLIENT_COMMAND_TYPE_VALUES = [
  "session.open",
  "turn.start",
  "turn.steer",
  "turn.queue",
  "turn.interrupt",
  "approval.respond",
  "checkpoint.rollback",
  "provider.probe",
  "provider.list",
  "terminal.open",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
  // env lane (additive): whole-thread / per-turn diffs, install/sign-in steps, session listing.
  "checkpoint.diff",
  "provider.setup",
  "session.list",
  "session.close",
  "env.configure",
] as const;
export type ClientCommandType = (typeof CLIENT_COMMAND_TYPE_VALUES)[number];

export interface ClientCommandParams {
  /** `worktree: true` on a new session creates a git worktree for it and runs the session there. */
  "session.open": { sessionId?: string; cwd: string; selection?: ModelSelection; afterSequence?: number; worktree?: boolean };
  "turn.start": {
    sessionId: string;
    input: UserInput;
    selection: ModelSelection;
    routing?: RoleRouting;
    runtimeMode: RuntimeMode;
    interactionMode: InteractionMode;
  };
  "turn.steer": { sessionId: string; turnId: string; input: UserInput };
  "turn.queue": { sessionId: string; input: UserInput };
  "turn.interrupt": { sessionId: string; turnId?: string };
  /** Answers an approval_request (decision) or a user_input_request (answers). */
  "approval.respond": {
    sessionId: string;
    requestId: string;
    decision: ApprovalDecision;
    updatedInput?: Record<string, unknown>;
    answers?: Record<string, string[]>;
  };
  "checkpoint.rollback": { sessionId: string; checkpointId: string };
  "provider.probe": { instanceId: string };
  "provider.list": Record<string, never>;
  /** `command` is typed into the shell after it starts (install / login flows). */
  "terminal.open": { terminalId?: string; cwd: string; cols: number; rows: number; command?: string };
  "terminal.write": { terminalId: string; data: string };
  "terminal.resize": { terminalId: string; cols: number; rows: number };
  "terminal.close": { terminalId: string };
  /** Diff of one checkpoint against the one before it, or of the whole thread when checkpointId is absent. */
  "checkpoint.diff": { sessionId: string; checkpointId?: string };
  /** The command the client types into an in-app terminal to install the runtime or sign in. Never run by the server. */
  "provider.setup": { instanceId: string; action: ProviderSetupAction };
  "session.list": { cwd?: string; query?: string; limit?: number };
  /** Stops the session's vendor runtime; the log stays and session.open resumes it. */
  "session.close": { sessionId: string };
  /**
   * Local-only (the device relay refuses it): how the built-in engine reaches
   * Alevr's backend with the user's own session, and the user's BYOK keys.
   * Held in memory by the env server, never written to disk or logged.
   */
  "env.configure": { backend?: EnvBackendConfig; byok?: ByokKey[] };
}

export interface EnvBackendModel {
  /** Backend provider id, the path segment under /api/agent ("anthropic", "openai"). */
  provider: string;
  providerName?: string;
  kind: "anthropic" | "openai";
  model: string;
  label: string;
  available: boolean;
  contextWindow?: number;
  api?: "chat" | "responses";
}

export interface EnvBackendConfig {
  /** e.g. https://alevr.com/api/agent (no trailing slash). */
  baseUrl: string;
  /** Full Authorization header value carrying the user's Alevr session. */
  authorization: string;
  models?: EnvBackendModel[];
}

export interface ByokKey {
  /** "anthropic" | "openai" | "google" | "xai" | "deepseek" | "openrouter". */
  provider: string;
  apiKey: string;
  baseUrl?: string;
}

export const PROVIDER_SETUP_ACTION_VALUES = ["install", "login"] as const;
export type ProviderSetupAction = (typeof PROVIDER_SETUP_ACTION_VALUES)[number];

/** One step the user runs themselves in an in-app terminal (SPEC §2: the client opens a terminal with it typed in). */
export interface ProviderSetupStep {
  action: ProviderSetupAction;
  /** Shell text typed into the terminal, not executed by the server. */
  command: string;
  /** Plain-language label for the button / sheet ("Sign in to Codex"). */
  label: string;
  note?: string;
  /** Vendor documentation for the step. */
  url?: string;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  title?: string;
  state: SessionState;
  selection: ModelSelection;
  /** ISO-8601. */
  updatedAt: string;
  lastSequence: number;
  /** Set for subagent sessions: the session that spawned it. */
  parentSessionId?: string;
}

export type ClientCommand = {
  [T in ClientCommandType]: { id: string; type: T; params: ClientCommandParams[T] };
}[ClientCommandType];

export interface ClientCommandResults {
  "session.open": { sessionId: string };
  "turn.start": { turnId: string };
  "turn.steer": { accepted: boolean };
  "turn.queue": { queuedId: string };
  "turn.interrupt": Record<string, never>;
  "approval.respond": Record<string, never>;
  "checkpoint.rollback": { restoredFiles: number };
  "provider.probe": { instance: ProviderInstance };
  "provider.list": { instances: ProviderInstance[] };
  "terminal.open": { terminalId: string };
  "terminal.write": Record<string, never>;
  "terminal.resize": Record<string, never>;
  "terminal.close": Record<string, never>;
  "checkpoint.diff": { diff: string; files: FileChangeEntry[] };
  /** step is null when the instance needs nothing for that action (already installed / signed in / no CLI login). */
  "provider.setup": { step: ProviderSetupStep | null };
  "session.list": { sessions: SessionSummary[] };
  "session.close": Record<string, never>;
  "env.configure": Record<string, never>;
}

export const WIRE_ERROR_CODE_VALUES = [
  "bad_request",
  "not_found",
  "unsupported",
  "not_ready",
  "limited",
  "conflict",
  "internal",
] as const;
export type WireErrorCode = (typeof WIRE_ERROR_CODE_VALUES)[number];

export type ServerResponse =
  | { type: "response"; id: string; ok: true; result?: unknown }
  | { type: "response"; id: string; ok: false; error: { code: WireErrorCode; message: string } };

export const SERVER_EVENT_TYPE_VALUES = [
  "session.snapshot",
  "session.state",
  "turn.started",
  "turn.completed",
  "item.added",
  "item.updated",
  "item.delta",
  "queue.updated",
  "usage.updated",
  "provider.updated",
  "terminal.output",
  "terminal.exited",
] as const;
export type ServerEventType = (typeof SERVER_EVENT_TYPE_VALUES)[number];

export const TURN_OUTCOME_VALUES = ["completed", "interrupted", "failed", "limited"] as const;
export type TurnOutcome = (typeof TURN_OUTCOME_VALUES)[number];

export interface ServerEventPayloads {
  "session.snapshot": { snapshotSequence: number; session: SessionSnapshot };
  "session.state": { state: SessionState; resumeAt?: string; message?: string };
  "turn.started": { turnId: string; selection: ModelSelection };
  "turn.completed": { turnId: string; outcome: TurnOutcome; usage?: SessionUsage };
  "item.added": { item: TurnItem };
  /** Full replacement of an item by id. */
  "item.updated": { item: TurnItem };
  /** Appends to a streaming text field of an item. */
  "item.delta": { itemId: string; field: "text" | "output"; append: string };
  "queue.updated": { queue: QueuedInput[] };
  "usage.updated": { usage: SessionUsage };
  "provider.updated": { instance: ProviderInstance };
  "terminal.output": { terminalId: string; data: string };
  "terminal.exited": { terminalId: string; exitCode?: number };
}

export const GLOBAL_EVENT_TYPES: readonly ServerEventType[] = ["provider.updated", "terminal.output", "terminal.exited"];

export type ServerEvent = {
  [T in ServerEventType]: { type: T } & ServerEventPayloads[T];
}[ServerEventType];

export interface ServerEventEnvelope {
  type: "event";
  stream: "session" | "global";
  /** Present iff stream is "session". */
  sessionId?: string;
  sequence: number;
  /** ISO-8601. */
  at: string;
  event: ServerEvent;
}

export type ServerMessage = ServerResponse | ServerEventEnvelope;

// ── Small pure helpers every client needs ───────────────────────────────────

export type EventDisposition = "apply" | "duplicate" | "gap";

/**
 * What a client does with a session-stream envelope given the last sequence
 * it applied (`cursor`; null before any snapshot). A snapshot always applies
 * and resets the cursor to its snapshotSequence.
 */
export function classifyEvent(cursor: number | null, envelope: Pick<ServerEventEnvelope, "sequence" | "event">): EventDisposition {
  if (envelope.event.type === "session.snapshot") return "apply";
  if (cursor === null) return "gap";
  if (envelope.sequence <= cursor) return "duplicate";
  if (envelope.sequence === cursor + 1) return "apply";
  return "gap";
}

const includes = <T extends string>(values: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (values as readonly string[]).includes(v);

export const isProviderKind = (v: unknown): v is ProviderKind => includes(PROVIDER_KIND_VALUES, v);
export const isRuntimeMode = (v: unknown): v is RuntimeMode => includes(RUNTIME_MODE_VALUES, v);
export const isTurnItemKind = (v: unknown): v is TurnItemKind => includes(TURN_ITEM_KIND_VALUES, v);
export const isClientCommandType = (v: unknown): v is ClientCommandType => includes(CLIENT_COMMAND_TYPE_VALUES, v);
export const isServerEventType = (v: unknown): v is ServerEventType => includes(SERVER_EVENT_TYPE_VALUES, v);

/** A turn item this build understands; unknown kinds are dropped, not fatal (forward compatibility). */
export function isTurnItem(v: unknown): v is TurnItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.createdAt === "string" && isTurnItemKind(o.kind);
}

/** Cheapest ContextTier price for `tokens`, or the default (first) tier when absent. */
export function pickContextTier(tiers: readonly ContextTier[], tokens?: number): ContextTier | undefined {
  if (tiers.length === 0) return undefined;
  if (tokens === undefined) return tiers[0];
  return [...tiers].sort((a, b) => a.tokens - b.tokens).find((t) => t.tokens >= tokens);
}

/** USD for a request at a tier: input/cached/output token counts. */
export function estimateTierCostUsd(tier: ContextTier, usage: TokenCount): number {
  const cached = usage.cachedInput ?? 0;
  const fresh = Math.max(0, usage.input - cached);
  const cachedRate = tier.cachedInputPerMTok ?? tier.inputPerMTok;
  return (fresh * tier.inputPerMTok + cached * cachedRate + usage.output * tier.outputPerMTok) / 1_000_000;
}
