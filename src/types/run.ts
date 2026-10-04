import type { ActionApprovalDecision, ActionReceiptStatus, ActionRiskClass } from "@/lib/action-approval";

/*
 * The typed run record: what a turn did, in the order it did it.
 *
 * Every payload here rides INSIDE an existing activity event as an added,
 * optional key (`ClientActivityEvent.call`, `.segment`, `.commentary`, `.fact`,
 * `.notice`). Shipped native builds reject an SSE frame `type` they do not know
 * but ignore an unknown key, so the legacy `kind`/`title`/`detail` stay exactly
 * as they were and the structure lives beside them (SPEC §2.4, INV-6, INV-7).
 *
 * Server- and client-safe: nothing here may import a runtime module.
 */

export const TOOL_CALL_STATUSES = [
  "queued", "awaiting_approval", "running", "succeeded", "failed", "denied", "expired", "cancelled",
] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];
export const TERMINAL_TOOL_CALL_STATUSES: readonly ToolCallStatus[] =
  ["succeeded", "failed", "denied", "expired", "cancelled"];

/** Canonical tool ids. Juno tools use their ToolSpec id; see SPEC §3.8. */
export type CanonicalToolId =
  | "web_search" | "web_fetch" | "read_document" | "inspect_image" | "run_code"
  | "search_chats" | "current_time" | "calculate" | "start_task" | "suggest_research"
  | "search_news" | "find_in_page"   // Alevr Search (BRIEF §15)
  | "provider_web_search"   // Anthropic server web_search, OpenAI/xAI hosted web_search, Gemini grounding
  | "provider_x_search"     // xAI x_search
  | "mcp";                  // any connector tool; see connectorId/toolTitle

/** Every canonical id, for readers that must drop one this build does not know. */
export const CANONICAL_TOOL_IDS = [
  "web_search", "web_fetch", "read_document", "inspect_image", "run_code",
  "search_chats", "current_time", "calculate", "start_task", "suggest_research",
  "search_news", "find_in_page",
  "provider_web_search", "provider_x_search", "mcp",
] as const satisfies readonly CanonicalToolId[];

export interface ToolCallRecord {
  v: 1;
  /** Unique within the generation (SPEC §4.3): the provider's id when it has one and it is unseen,
   *  else a suffixed or synthesized id. */
  callId: string;
  providerCallId?: string;
  tool: CanonicalToolId;
  origin: "juno" | "connector" | "provider";
  /** English human title of the tool: ToolSpec.title, the MCP tool's own title, or "Web search". */
  title: string;
  /** connector calls only */
  connectorId?: string;
  connectorLabel?: string;
  /** connector calls only: the server's tool title or the humanised bare name, verbatim (third-party text). */
  toolTitle?: string;
  status: ToolCallStatus;
  round: number;
  /** Position of the call within its round (0-based). */
  index: number;
  /** ISO instant the call was first seen (the `call` event). */
  startedAt: string;
  /** ISO instant it reached a terminal status. */
  endedAt?: string;
  /** Measured dispatch time only (approval waits excluded), as `ClientToolDetail.durationMs`. */
  durationMs?: number;
  /** The per-tool timeout that bounded it (SPEC §4.4). Shown in the row. */
  timeoutMs?: number;
  /** Safe presentation parameters from ToolSpec.present. Strings single-line ≤ 200 chars. */
  args?: ToolPresentArgs;
  figure?: ToolFigure;
  /** `detail`: one line, ≤ 300 chars, English or third-party text (e.g. "HTTP 404", a connector's
   *  error line), shown verbatim under the localised failure phrase. Never model-facing. */
  error?: { code: ToolErrorCode; detail?: string };
  approval?: ToolCallApproval;
  /** Web-shaped detail for web_search / web_fetch / provider search (SPEC §6). */
  web?: ToolWebDetail;
  /** True when served from the turn's duplicate cache (SPEC §4.5). */
  cached?: boolean;
}

export type ToolPresentArgs = Record<string, string | number | boolean>;

export interface ToolFigure {
  kind: "results" | "pages" | "chars" | "files" | "matches" | "chats" | "value" | "exit" | "items";
  n?: number;         // for counted kinds
  value?: string;     // for "value" (calculate result, formatted time) and "exit" ("0")
}

export const TOOL_FIGURE_KINDS = [
  "results", "pages", "chars", "files", "matches", "chats", "value", "exit", "items",
] as const satisfies readonly ToolFigure["kind"][];

export const TOOL_ERROR_CODES = [
  "timeout", "invalid_args", "tool_error", "denied", "expired", "blocked", "not_permitted",
  "unavailable", "cancelled", "rate_limited", "budget", "unknown_tool", "no_results",
  "provider_error", "url_not_in_prior_context", "url_not_allowed", "url_not_accessible",
  "url_too_long", "unsupported_content_type", "too_large", "needs_browser", "outcome_unknown",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolCallApproval {
  id: string;                         // ActionApprovalReceipt id
  status: ActionReceiptStatus;        // as of the call's end; INV-18
  riskClass: ActionRiskClass;
  decision?: ActionApprovalDecision | null;
  decidedAt?: string | null;
  expiresAt?: string;
}

export interface ToolWebDetail {
  query?: string;                     // search: the query as sent (≤ 400 chars)
  engine?: string;                    // search: engine that answered ("tavily", "anthropic", "gemini"…)
  results?: Array<{ n?: number; title: string; url: string }>;   // ≤ 10, normalised (INV-3)
  requestedUrl?: string;              // fetch
  finalUrl?: string;                  // fetch, after redirects
  contentType?: "html" | "pdf" | "text" | "json" | "xml";
  pages?: number;                     // fetch of a PDF
  chars?: number;                     // fetch: characters returned
  totalChars?: number;                // fetch: characters available
  links?: string[];                   // fetch: top ≤ 20 links (T7 provenance, SPEC §6.2)
  /** fetch / search: the injection scan's verdict when not clean (SPEC §6.4 item 5). */
  injection?: "suspicious" | "hostile";
  /** Gemini grounding only: searchEntryPoint.renderedContent, ≤ 16 KiB, not rendered yet. */
  searchSuggestionsHtml?: string;
}

/** Where a source came from. Persisted additively on `ClientSource.origin` (INV-3). */
export type ChatSourceOrigin =
  | "juno_search" | "juno_fetch" | "provider_search" | "provider_grounding" | "research";

export const CHAT_SOURCE_ORIGINS = [
  "juno_search", "juno_fetch", "provider_search", "provider_grounding", "research",
] as const satisfies readonly ChatSourceOrigin[];

/** A reasoning segment starts. `offset` indexes the flat `ClientMessage.reasoning` string (UTF-16). */
export interface ReasoningSegment { round: number; part?: number; offset: number }

export interface CommentaryItem {
  round: number;
  /** Tags already extracted (SPEC §2.8). Untruncated, ≤ 64 KiB (INV-4); longer commentary stays in
   *  the answer instead. */
  text: string;
  /** True when the text streamed into the answer area live; false when the provider declared it
   *  commentary up front (OpenAI `phase`). Drives where the UI shows it at rest. */
  inline: boolean;
}

export type RunFact =
  | { key: "model"; modelId: string; provider: string; label: string; routed?: boolean }
  | { key: "effort"; effort: "instant" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; auto: boolean }
  | { key: "context"; historyMessages: number; attachments: number; projectFiles: number }
  | { key: "tools"; offered: CanonicalToolId[]; nativeSearch: boolean; roundBudget: number }
  | { key: "connectors"; ready: Array<{ id: string; label: string; tools: number }>;
      failed: Array<{ id: string; label: string; reason: ConnectorFailure }> }
  | { key: "memory" }   // payload in memoryReceipt
  /** Research completion message only (SPEC §9.6.3). */
  | { key: "research"; runId: string; title: string; workedMs: number; cited: number; read: number;
      pages: number; leadModel: string; state: "completed" | "partially_completed" };

export type ConnectorFailure = "auth_expired" | "unreachable" | "misconfigured" | "timeout" | "not_linked";

export const CONNECTOR_FAILURES = [
  "auth_expired", "unreachable", "misconfigured", "timeout", "not_linked",
] as const satisfies readonly ConnectorFailure[];

export const RUN_EFFORTS = [
  "instant", "minimal", "low", "medium", "high", "xhigh", "max",
] as const satisfies readonly Extract<RunFact, { key: "effort" }>["effort"][];

export const RUN_NOTICE_CODES = [
  "model_changed", "skill_not_applied", "connector_unavailable", "usage_limit", "stall",
  "finish_length", "finish_sensitive", "tool_budget", "web_off_lockdown", "provenance_refused",
  "hostile_content", "search_degraded", "research_skipped", "private_tools_limited",
  "tools_capped",
] as const;
export type RunNoticeCode = (typeof RUN_NOTICE_CODES)[number];
export interface RunNotice { code: RunNoticeCode; params?: Record<string, string | number> }

/**
 * The only notice codes whose rows use `kind: "warning"` (INV-7). iOS shows the
 * last warning of a turn as a research-degradation line, so a notice nobody has
 * to act on rides `kind: "context"` instead; the typed UI reads `notice.code`
 * whatever the kind (SPEC §2.4).
 */
export const MUST_ACT_NOTICE_CODES = [
  "finish_length", "usage_limit", "connector_unavailable", "hostile_content", "research_skipped",
] as const satisfies readonly RunNoticeCode[];
