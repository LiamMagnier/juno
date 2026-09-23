/**
 * The tool contract (SPEC §3.1).
 *
 * Every Juno-native chat tool is one `ToolSpec` in one registry
 * (`src/lib/tools/registry.ts`); connector tools are mapped into a
 * `ResolvedTool` of the same shape when the turn's toolset opens. The
 * dispatcher, the adapters and the presentation layer all read this one shape,
 * so a tool is described once: its model-facing text, its schema, its risk and
 * its timing live together, and nothing downstream re-derives them.
 *
 * Types only, plus `defineTool`. No runtime import may be added here: the
 * dispatcher and the adapter loops import this file and are tested offline.
 */

import type { Plan } from "@prisma/client";

import type { ClientActionApproval } from "@/lib/action-approval";
import type { ConversationAttachment } from "@/lib/agent/attachment-match";
import type { SourceRegistry } from "@/lib/chat/source-registry";
import type {
  McpFunctionTool,
  McpToolset,
  ToolExecution,
  ToolResultImage,
} from "@/lib/mcp";
import type { ToolAccess } from "@/lib/tool-access";
import type { TurnTaint } from "@/lib/web/taint";
import type { LazyUrlLedger, TurnWebLimits } from "@/lib/web/types";
import type { ClientSource } from "@/types/chat";
import type {
  CanonicalToolId,
  ConnectorFailure,
  ToolErrorCode,
  ToolFigure,
  ToolPresentArgs,
  ToolWebDetail,
} from "@/types/run";

export type ToolRisk = "read" | "write" | "external" | "destructive";
export type ToolIconKind =
  | "search" | "globe" | "document" | "image" | "code" | "chats" | "clock" | "calculator"
  | "task" | "research" | "connector";

/** The portable schema subset (DECISIONS T2): type, properties, required, items, enum, description. */
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

/** The Juno tool ids a ToolSpec may carry: every canonical id but the provider-run and connector ones. */
export type JunoToolId = Exclude<CanonicalToolId, "provider_web_search" | "provider_x_search" | "mcp">;

export interface ToolSpec<A extends Record<string, unknown> = Record<string, unknown>> {
  /** Model-facing function name, /^[a-z][a-z0-9_]{1,40}$/. Equals the CanonicalToolId. */
  id: JunoToolId;
  /** English, sentence case, for audit rows and the model; never rendered by the new UI (INV-28). */
  title: string;
  /** Model-facing, English, Anthropic template (SPEC §3.8). Declared through defineTool (INV-29). */
  description: string;
  input: PortableSchema;
  risk: ToolRisk;
  /** May run concurrently with other parallel-safe calls in the same round. Only `read`. */
  parallelSafe: boolean;
  /** Bound on one execution, excluding any approval wait (SPEC §4.4). */
  timeoutMs: number;
  icon: ToolIconKind;
  /** How the call is authorised (SPEC §3.3). "none" = pure and never brokered. */
  broker: "juno_runtime" | "none" | "self";
  /** Duplicate calls in one turn return the cached outcome. false only where a repeat means something. */
  dedupe: boolean;
  /** Safe display params for the tool record. Pure; never throws; strings single-line ≤ 200. */
  present(args: A): ToolPresentArgs;
  execute(args: A, ctx: ToolContext): Promise<ToolOutcome>;
}

/**
 * Wraps a spec literal so the i18n extractor skips its model-facing
 * `description` and `title` (INV-29, SPEC §10.5). At runtime it is the
 * identity: the marker is the call itself, which the extractor recognises.
 */
export function defineTool<A extends Record<string, unknown>>(spec: ToolSpec<A>): ToolSpec<A> {
  return spec;
}

export interface ToolContext {
  userId: string;                    // the account; present in private chats too (for rate limits only)
  conversationId: string | null;     // null in private chats
  projectId: string | null;
  generationId: string;
  callId: string;
  round: number;
  /** Already includes the per-tool timeout and the turn's abort. */
  signal: AbortSignal;
  private: boolean;
  plan: Plan;
  locale?: string;
  timeZone?: string;
  citationsNumbered: boolean;        // clientFeatures has "citations"
  sources: SourceRegistry;
  /** Null when no web tool is attached. Lazily built on the first fetch (SPEC §6.2.3). */
  ledger: LazyUrlLedger | null;
  taint: TurnTaint;
  limits: TurnWebLimits;
  /** Lazily resolved attachments of this conversation/project (read_document, inspect_image, run_code). */
  attachments(): Promise<ConversationAttachment[]>;
  /** For broker "self" tools (start_task): per-call approval callback (SPEC §3.3). */
  onApprovalRequest?: (approval: ClientActionApproval) => void;
}

export interface ToolOutcome {
  status: "succeeded" | "failed" | "denied" | "expired" | "cancelled";
  /** Model-facing. Anything not authored by Juno is inside wrapUntrusted (INV-30). */
  text: string;
  /** Panel-facing: the same content without the envelope. */
  body: string;
  images?: readonly ToolResultImage[];
  sources?: ClientSource[];
  figure?: ToolFigure;
  web?: ToolWebDetail;
  error?: { code: ToolErrorCode };
  durationMs?: number;
  /** Juno's own fee for this call (SPEC §3.9). */
  feeMicroUsd?: number;
}

/** What a toolset exposes per function name: Juno spec, mapped connector tool, or native tool. */
export interface ResolvedTool {
  name: string;                      // function name sent to the provider
  canonical: CanonicalToolId;
  origin: "juno" | "connector";
  title: string;
  risk: ToolRisk;
  parallelSafe: boolean;
  timeoutMs: number;
  dedupe: boolean;
  connectorId?: string;
  connectorLabel?: string;
  toolTitle?: string;                // connector's own title (annotations.title) or humanised bare name
  present(args: Record<string, unknown>): ToolPresentArgs;
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
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecution>;
}

/** The toolset a chat turn runs with (src/lib/tools/toolset.ts). */
export interface ChatToolset extends McpToolset {
  resolve(name: string): ResolvedTool | undefined;
  /** Per requested connector, in request order (RC-3). */
  connectors: Array<{ id: string; label: string; state: "ready" | ConnectorFailure; tools: number }>;
}
