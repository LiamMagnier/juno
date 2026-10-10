/**
 * The tool contract (docs/rework/TOOL_RUNTIME_DESIGN.md §6.4, chat-rework SPEC
 * §3.1 and §4.2–§4.3, ported onto the trunk).
 *
 * One shape for every tool a chat turn can carry, whoever built it:
 *
 *   - Alevr's own tools are a `ToolSpec` (a schema, a risk, a timeout and an
 *     `execute`). The registry tools that already exist (`read_document`,
 *     `inspect_image`, `browser_agent`, `code_interpreter`) are mapped into the
 *     same shape by the runtime, and the execution and skill lanes contribute
 *     theirs (`run_code`, `check_run`, `use_skill`, `read_skill_file`) through a
 *     `ToolProvider`.
 *   - Connector (MCP) tools and the route's native tools (`start_task`…) are
 *     described to the dispatcher as a `ResolvedTool` of the same shape.
 *
 * Every adapter hands the calls a round ended with to ONE dispatcher
 * (`src/lib/tools/dispatch.ts`) as `ToolCallInput`s and gets `BatchResult`s back
 * in call order. That is where arguments are parsed and validated (an invalid
 * call is answered with an error and never run), where the Alevr call id is
 * fixed, where parallel-safe reads run together, where timeouts start only
 * after an approval, and where Stop answers every outstanding call.
 *
 * Types and pure helpers only. Nothing here may import a `server-only` module
 * at runtime: the dispatcher, the adapters' loops and their tests import it.
 */

import type { Plan } from "@prisma/client";

import type { ClientActionApproval } from "@/lib/action-approval";
import type { ConversationAttachment } from "@/lib/agent/attachment-match";
import type { SourceRegistry } from "@/lib/chat/source-registry";
import type { McpFunctionTool, McpToolset, ToolExecution, ToolResultImage } from "@/lib/mcp";
import type { ToolAccess } from "@/lib/tool-access";
import type { TurnTaint } from "@/lib/web/taint";
import type { LazyUrlLedger, PrivateSpanSet, TurnWebLimits } from "@/lib/web/types";
import type { ClientSource } from "@/types/chat";
import type {
  CanonicalToolId,
  ConnectorFailure,
  RunNotice,
  ToolErrorCode as RunToolErrorCode,
  ToolFigure,
  ToolPresentArgs,
  ToolWebDetail,
} from "@/types/run";

// ── Identity ────────────────────────────────────────────────────────────────

/** The execution tools (design §6.5). Owned by the execution lane. */
export const RUN_CODE_TOOL_ID = "run_code";
export const CHECK_RUN_TOOL_ID = "check_run";
/** The skill tools (design §6.8). Owned by the skill lane. */
export const USE_SKILL_TOOL_ID = "use_skill";
export const READ_SKILL_FILE_TOOL_ID = "read_skill_file";

/**
 * Tools that execute something on the account's behalf or load instructions
 * that lead to execution. They are attached only for models whose tool calling
 * has been VERIFIED by the round-trip probe (design §6.11); every other model
 * gets a plain-language note instead.
 *
 * `code_interpreter` is the registry name `run_code` replaces; it is gated the
 * same way until the execution lane retires it.
 */
export const EXECUTION_TOOL_IDS: readonly string[] = Object.freeze([
  RUN_CODE_TOOL_ID,
  CHECK_RUN_TOOL_ID,
  USE_SKILL_TOOL_ID,
  READ_SKILL_FILE_TOOL_ID,
  "code_interpreter",
]);

/** Old tool ids still found in stored skill grants, activity rows and native builds. */
export const TOOL_ID_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  code_interpreter: RUN_CODE_TOOL_ID,
  browser_agent: "web_fetch",
});

/** The alias target, or the id unchanged. */
export function canonicalToolId(id: string): string {
  return TOOL_ID_ALIASES[id] ?? id;
}

// ── Risk and schema ─────────────────────────────────────────────────────────

/** Server-side risk vocabulary. Only `ActionRiskClass` ever reaches the wire. */
export type ToolRisk = "read" | "write" | "external" | "destructive";

export type ToolIconKind =
  | "search" | "globe" | "document" | "image" | "code" | "chats" | "clock" | "calculator"
  | "task" | "research" | "connector";

export type JunoToolId = Exclude<CanonicalToolId, "provider_web_search" | "provider_x_search" | "mcp">;

/** The portable schema subset every provider accepts untranslated (SPEC DECISIONS T2). */
export type PortableSchema = {
  type: "object";
  properties: Record<string, PortableProperty>;
  required?: string[];
};
export type PortableProperty =
  | { type: "string"; description: string; enum?: string[] }
  | { type: "number" | "integer"; description: string }
  | { type: "boolean"; description: string }
  | { type: "array"; description: string; items: PortableProperty }
  | { type: "object"; description: string; properties: Record<string, PortableProperty>; required?: string[] };

/** The only JSON-Schema keywords a portable schema may use. */
export const PORTABLE_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "description",
]);

const PORTABLE_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean", "array", "object"]);

/**
 * Why `schema` is not in the portable subset, or null when it is.
 *
 * A keyword outside the subset (`additionalProperties`, `oneOf`, `format`,
 * `default`…) is one some lab rejects outright, and a tool whose schema one lab
 * refuses takes the whole request down with it on that lab.
 */
export function portableSchemaProblem(schema: unknown, path = "input"): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${path} is not an object`;
  const node = schema as Record<string, unknown>;
  for (const key of Object.keys(node)) {
    if (!PORTABLE_SCHEMA_KEYWORDS.has(key)) return `${path} uses "${key}", which is not portable`;
  }
  if (typeof node.type !== "string" || !PORTABLE_TYPES.has(node.type)) return `${path}.type is missing or unknown`;
  if (path !== "input" && typeof node.description !== "string") return `${path} has no description`;
  if (node.enum !== undefined) {
    if (node.type !== "string" || !Array.isArray(node.enum) || node.enum.some((v) => typeof v !== "string")) {
      return `${path}.enum must be a list of strings on a string`;
    }
  }
  if (node.type === "array") {
    const nested = portableSchemaProblem(node.items, `${path}.items`);
    if (nested) return nested;
  } else if (node.items !== undefined) {
    return `${path}.items is only allowed on an array`;
  }
  if (node.type === "object") {
    const properties = node.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return `${path}.properties is missing`;
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      const nested = portableSchemaProblem(child, `${path}.properties.${name}`);
      if (nested) return nested;
    }
    if (node.required !== undefined) {
      if (!Array.isArray(node.required)) return `${path}.required must be a list`;
      for (const name of node.required) {
        if (typeof name !== "string" || !(name in (properties as Record<string, unknown>))) {
          return `${path}.required names "${String(name)}", which is not a property`;
        }
      }
    }
  } else if (node.properties !== undefined || node.required !== undefined) {
    return `${path}.properties is only allowed on an object`;
  }
  return null;
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/**
 * How one call ended.
 *
 * `outcome_unknown` is the honest answer when the process that was running a
 * call died before it could collect the result (design §6.6): nothing is re-run
 * automatically and nothing claims success. On the WIRE it is sent as
 * `status: "failed"` with `error.code: "outcome_unknown"`, because native
 * builds already shipped read an unknown status as "running" forever.
 */
export type ToolOutcomeStatus = "succeeded" | "failed" | "denied" | "expired" | "cancelled" | "outcome_unknown";

/** Why a call did not succeed. The model reads the text; the UI reads the code. */
export type ToolErrorCode = RunToolErrorCode | "outcome_unknown";

/** Where an execution ran (design §6.1). Named on every run, so a hosted run never implies the user's machine. */
export type ToolExecutionContext = "hosted_sandbox" | "agent_computer" | "task_container" | "local_host";

/** A file an execution produced, already stored as a conversation attachment. */
export interface ToolRunFile {
  attachmentId: string;
  name: string;
  mime: string;
  bytes: number;
}

/**
 * What an execution tool reports about the run behind a call (design §6.4).
 * Filled by the execution lane from its `ToolRun` row; the dispatcher and the
 * route only carry it.
 */
export interface ToolRunRecord {
  runId: string;
  context: ToolExecutionContext;
  language?: "python" | "javascript" | "bash";
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "outcome_unknown";
  exitCode?: number | null;
  durationMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  files: ToolRunFile[];
  /** The skill bundle the run used, when a skill's script ran. */
  skill?: { slug: string; versionId?: string; bundleDigest?: string };
}

/** At most this many lines of output per progress frame. */
export const TOOL_PROGRESS_MAX_LINES = 20;
/** One progress line is cut to this many characters. */
export const TOOL_PROGRESS_MAX_LINE_CHARS = 500;
/** The dispatcher forwards at most one progress frame per call per this interval. */
export const TOOL_PROGRESS_MIN_INTERVAL_MS = 1_000;

/** A running call's latest output, for the live row (design §6.4 `progress`). No percentages. */
export interface ToolProgress {
  /** The last lines written, oldest first, ≤ TOOL_PROGRESS_MAX_LINES. */
  lines: Array<{ stream: "stdout" | "stderr"; text: string }>;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface ToolOutcome {
  status: ToolOutcomeStatus;
  /** Model-facing. Anything not authored by Alevr is inside `wrapUntrusted`. */
  text: string;
  /** Panel-facing: the same content without the envelope. */
  body: string;
  images?: readonly ToolResultImage[];
  sources?: ClientSource[];
  figure?: ToolFigure;
  web?: ToolWebDetail;
  error?: { code: ToolErrorCode };
  durationMs?: number;
  feeMicroUsd?: number;
  /** Execution tools only. */
  run?: ToolRunRecord;
}

// ── Specs ───────────────────────────────────────────────────────────────────

export interface ToolContext {
  userId: string;
  /** Which product surface is acting. Recorded on receipts and runs. */
  surface?: "chat" | "work" | "voice";
  /** The chat generation id (or Work run id). With `callId` it is the replay key. */
  sessionId?: string;
  conversationId: string | null;
  projectId: string | null;
  generationId?: string;
  /** The stable Alevr call id (`ToolCallInput.callId`). */
  callId?: string;
  round?: number;
  /** The turn's abort and the per-tool timeout, combined. */
  signal: AbortSignal;
  private?: boolean;
  privateSpans?: PrivateSpanSet | readonly string[];
  plan?: Plan | string;
  locale?: string;
  timeZone?: string;
  citationsNumbered?: boolean;
  sources?: SourceRegistry;
  ledger?: LazyUrlLedger | null;
  taint?: TurnTaint;
  limits?: TurnWebLimits;
  attachments?: () => Promise<ConversationAttachment[]>;
  /** Forward a running call's latest output; rate-limited by the dispatcher. */
  reportProgress?(progress: ToolProgress): void;
  /** Per-call approval callback, for a spec that asks a person itself. */
  onApprovalRequest?: (approval: ClientActionApproval) => void;
}

export interface ToolSpec<A extends Record<string, unknown> = Record<string, unknown>> {
  /** Model-facing function name, /^[a-z][a-z0-9_]{1,40}$/. */
  id: string;
  /** English, sentence case; for audit rows and receipts. */
  title: string;
  /** Model-facing description. */
  description: string;
  input: PortableSchema;
  risk: ToolRisk;
  /**
   * May run concurrently with other parallel-safe reads in the same round.
   * Only a `read` with `broker: "none"`: a brokered call can ask a person, and
   * approvals are never raised two at a time (`resolvedSpecTool`).
   */
  parallelSafe: boolean;
  /** Bound on one execution, excluding any approval wait. */
  timeoutMs: number;
  icon?: ToolIconKind;
  /**
   * How the call is authorised. `juno_runtime`: the runtime asks the approval
   * broker before `execute` (exact rules in `action-approval.ts`). `none`: pure,
   * never brokered — allowed for a `read` only; any other risk is brokered
   * whatever it declares. A spec never authorises itself.
   */
  broker?: "juno_runtime" | "none" | "self";
  /** Identical calls in one turn return the first outcome. */
  dedupe?: boolean;
  present?(args: A): ToolPresentArgs;
  execute(args: A, ctx: ToolContext): Promise<ToolOutcome>;
}

const TOOL_ID = /^[a-z][a-z0-9_]{1,40}$/;

/**
 * Validates a spec literal at module load: a function name every provider
 * accepts, a schema in the portable subset, and a read-only parallel flag.
 * Specs are module-level constants, so a bad one fails in the registry test
 * rather than on one lab in production.
 */
export function defineTool<A extends Record<string, unknown>>(spec: ToolSpec<A>): ToolSpec<A> {
  if (!TOOL_ID.test(spec.id)) throw new Error(`defineTool: "${spec.id}" is not a valid tool name`);
  const problem = portableSchemaProblem(spec.input);
  if (problem) throw new Error(`defineTool(${spec.id}): ${problem}`);
  if (spec.parallelSafe && spec.risk !== "read") throw new Error(`defineTool(${spec.id}): only a read may be parallel-safe`);
  // A spec never waives its own authorisation: only a pure read may skip the
  // broker (the runtime brokers any other spec regardless, `specIsBrokered`).
  if (spec.broker === "none" && spec.risk !== "read") throw new Error(`defineTool(${spec.id}): only a read may skip the broker`);
  if (!(spec.timeoutMs > 0)) throw new Error(`defineTool(${spec.id}): timeoutMs must be positive`);
  return spec;
}

/**
 * What the dispatcher knows about a function name in the turn's toolset: an
 * Alevr spec or registry tool, a connector tool, or a native tool.
 */
export interface ResolvedTool {
  /** Function name sent to the provider. */
  name: string;
  origin: "alevr" | "connector" | "native" | "juno";
  canonical?: CanonicalToolId | string;
  title: string;
  risk: ToolRisk;
  parallelSafe: boolean;
  /** Started only once the call is authorised; never covers an approval wait. */
  timeoutMs: number;
  dedupe: boolean;
  spec?: ToolSpec;
  connectorId?: string;
  connectorLabel?: string;
  toolTitle?: string;
  present?(args: Record<string, unknown>): ToolPresentArgs;
  /** Alevr tools: validated strictly (required, primitive types, enum, unknown keys refused). */
  input?: PortableSchema;
  /** Connector and native tools: their own schema, checked shallowly (required, primitive types). */
  inputSchema?: Record<string, unknown>;
}

/**
 * What the dispatcher hands an executor with each call (`McpToolset.execute`'s
 * fifth argument). Every field is optional, so an executor written before the
 * dispatcher keeps working; one that honours them gives the person a truthful
 * live row.
 */
export interface ToolExecuteOptions {
  /** Per-call approval callback. Composed with, never instead of, the toolset's own. */
  onApprovalRequest?: (approval: ClientActionApproval) => void;
  /**
   * Called once, right after authorisation succeeded and before the sink runs.
   * The dispatcher yields `running` from it and only then starts the tool's
   * timer, so an approval wait is never cut short by a tool budget.
   */
  onAuthorized?: () => void;
  /** The tool's bound once running; informational for the executor. */
  timeoutMs?: number;
  /** Forward a running call's output (rate-limited by the dispatcher). */
  reportProgress?: (progress: ToolProgress) => void;
  round?: number;
}

/**
 * A tool the chat route builds for one turn and runs itself.
 *
 * Not a registry tool, and deliberately so. A native tool is a closure over
 * the turn it belongs to (the account, the conversation, the user message it
 * answers) and decides for itself when a person has to be asked. `start_task`
 * (src/lib/chat/task-tool.ts) is the one that exists. Moved here from
 * `src/lib/llm.ts`, which is `server-only` and re-exports it.
 */
export interface NativeChatTool {
  tool: McpFunctionTool;
  /** The name the activity row and the thought-process panel show for it. */
  label: string;
  access: ToolAccess;
  /** The canonical id its calls are recorded under. Absent: `start_task`, as before. */
  canonical?: CanonicalToolId;
  /** The arguments its row may show (`ToolCallRecord.args`). Absent: none. */
  present?(args: Record<string, unknown>): ToolPresentArgs;
  /**
   * Its bound once running. Absent: the native default (a minute). A tool
   * that waits on the person's own machine — the folder tools — sets its own.
   */
  timeoutMs?: number;
  /**
   * Whether an identical call in the same turn is answered from the first.
   * Absent: yes. The folder tools say no — reading a file again after
   * editing it must read the new file.
   */
  dedupe?: boolean;
  execute(args: Record<string, unknown>, signal?: AbortSignal, opts?: ToolExecuteOptions): Promise<ToolExecution>;
}

/** The toolset a turn runs with: the provider-facing tools plus what the dispatcher needs to know. */
export interface ChatToolset extends McpToolset {
  /** Undefined for a name the turn does not carry: the call is refused, never guessed. */
  resolve(name: string): ResolvedTool | undefined;
  /** Per requested connector, in request order (RC-3). */
  connectors?: Array<{ id: string; label: string; state: "ready" | ConnectorFailure; tools: number }>;
  /**
   * What opening the toolset had to tell the turn: `tools_capped` with
   * `params.dropped` when tools past the cap were not offered (SPEC §3.4
   * item 3). Optional so a hand-built toolset (tests, adapters) need not say.
   */
  notices?: RunNotice[];
}

// ── Providers (the execution and skill lanes plug in here) ──────────────────

/** The turn a provider is asked about. Server facts only; nothing from the request body. */
export interface ToolTurn {
  userId: string;
  surface: "chat" | "work" | "voice";
  sessionId: string;
  conversationId: string | null;
  projectId: string | null;
  plan: string;
  modelId: string;
  vision: boolean;
  /**
   * A skill the user armed explicitly for this message (`/slug`) that passed
   * every check and APPLIED (`loadChatSkill`); null when none did. Never the
   * raw slug from the request.
   */
  skillSlug: string | null;
}

export type ToolProviderUnavailableReason =
  | "not_configured"
  | "unhealthy"
  | "network_not_isolated"
  | "disabled"
  | "nothing_to_offer";

export type ToolProviderAvailability =
  | { available: true }
  | { available: false; reason: ToolProviderUnavailableReason };

export interface ToolProviderSession {
  /** The specs for this turn, already closed over it. Only granted ids are kept. */
  specs: readonly ToolSpec[];
  /** One short system-prompt section for these tools (the runtime manifest, the skills list). */
  promptSection?: string;
  close?(): Promise<void>;
}

/**
 * Something that contributes Alevr tools to a turn: the execution lane
 * (`exec`: `run_code`, `check_run`) and the skill lane (`skills`: `use_skill`,
 * `read_skill_file`). The entitlement rows (`src/lib/tools/entitlements.ts`)
 * decide WHETHER a turn may carry a tool; the provider says whether it CAN, and
 * builds the specs.
 */
export interface ToolProvider {
  id: "exec" | "skills";
  /** Every tool id this provider can contribute. */
  tools: readonly string[];
  /** Cheap, cached, never throws: a failure is `{ available: false }`. */
  availability(turn: ToolTurn): Promise<ToolProviderAvailability>;
  /**
   * Called only for an available provider and a non-empty grant, before the
   * system prompt is built (its `promptSection` goes there). Must be cheap and
   * must not allocate remote resources: allocate on the first `execute`
   * (sandbox sessions are keyed by `ToolContext.sessionId`). `close()` is
   * best-effort cleanup at the end of the turn.
   */
  open(turn: ToolTurn, granted: readonly string[]): Promise<ToolProviderSession>;
}

// ── The dispatcher's interface ──────────────────────────────────────────────

export interface ToolCallInput {
  /** Function name as the model sent it. */
  name: string;
  /** The Alevr call id: the record id, the broker idempotency half, the stream key. */
  callId: string;
  /** The provider's own id, echoed back on the wire. Absent when the provider sent none. */
  providerCallId?: string;
  round: number;
  /** Position within the round, 0-based. */
  index: number;
  /** Raw argument text as the provider sent it; parsed and validated by the dispatcher. */
  argsText: string;
}

export interface BatchResult {
  callId: string;
  name: string;
  providerCallId?: string;
  /** Model-facing text; for a failure an instructive message. */
  text: string;
  isError: boolean;
  images: readonly ToolResultImage[];
  status: ToolOutcomeStatus;
  errorCode?: ToolErrorCode;
}
