/**
 * Stage: the persisted run record — what `Message.activity` gives back.
 *
 * `serializeActivity` used to live in `serializers.ts`, which is `server-only`,
 * so the one function deciding what survives a reload could not be imported by
 * a test. It lives here now, pure and client-safe, and `serializers.ts`
 * unseals the column and hands the recovered structure to it (SPEC §2.7).
 *
 * IT IS STILL A FIELD WHITELIST, and that is still the trap: an event is
 * rebuilt from named fields, so anything added to `ClientActivityEvent`
 * without a reader here streams live and then vanishes the moment the page
 * reloads. The failure is silent and looks exactly like the feature working.
 *
 * Every reader below follows one rule: a malformed or unknown payload degrades
 * to `undefined` — that field, never the event and never a thrown conversation
 * load — because a row written by a LATER build must still load in this one.
 * Strings are clamped to the limits of SPEC §2.4, unknown enum values are
 * dropped, and the two read-time rewrites of §2.5 are applied: a persisted
 * turn cannot still be running, so a call that never ended reads back as
 * `cancelled`, and an approval that never settled reads back as `expired`.
 *
 * No runtime import may pull `node:crypto` in here (the redaction helpers in
 * `action-approval.ts` do): the client's run model reads these helpers too.
 */

import type { ActionApprovalDecision, ActionReceiptStatus, ActionRiskClass } from "@/lib/action-approval";
import { clampChars, clampUtf8, normalizeSource, singleLine, utf8Length } from "@/lib/chat/source-registry";
import type {
  ActivityKind,
  ClientActivityEvent,
  ClientMemoryReceipt,
  ClientToolDetail,
} from "@/types/chat";
import {
  CANONICAL_TOOL_IDS,
  CONNECTOR_FAILURES,
  MUST_ACT_NOTICE_CODES,
  RUN_EFFORTS,
  RUN_NOTICE_CODES,
  TERMINAL_TOOL_CALL_STATUSES,
  TOOL_CALL_STATUSES,
  TOOL_ERROR_CODES,
  TOOL_FIGURE_KINDS,
  type CanonicalToolId,
  type CommentaryItem,
  type ReasoningSegment,
  type RunFact,
  type RunNotice,
  type RunNoticeCode,
  type ToolCallApproval,
  type ToolCallRecord,
  type ToolCallStatus,
  type ToolFigure,
  type ToolPresentArgs,
  type ToolWebDetail,
} from "@/types/run";

// ── Vocabularies ─────────────────────────────────────────────────────────────

export const ACTIVITY_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  "context",
  "model",
  "reasoning",
  "search",
  "visit",
  "write",
  "usage",
  "done",
  "warning",
  "tool",
  // Artifact verification receipts were written from the start and dropped
  // here on the way back out, so a reload lost every "Artifact repaired" row.
  "artifact",
]);

/*
 * The approval vocabularies, repeated rather than imported: the module that
 * owns them also owns the redaction helpers, which import `node:crypto`. The
 * type checks below fail the build if either list drifts from its source.
 */
const RECEIPT_STATUSES = [
  "pending", "allowed", "denied", "executing", "executed", "failed", "expired", "superseded", "blocked",
] as const satisfies readonly ActionReceiptStatus[];
const RISK_CLASSES = [
  "read_only", "reversible_write", "external_write", "destructive_or_sensitive", "unknown",
] as const satisfies readonly ActionRiskClass[];
const APPROVAL_DECISIONS = ["allow_once", "allow_scope", "deny"] as const satisfies readonly ActionApprovalDecision[];
type Exhaustive<T extends never> = T;
export type RunRecordVocabulariesAreComplete = [
  Exhaustive<Exclude<ActionReceiptStatus, (typeof RECEIPT_STATUSES)[number]>>,
  Exhaustive<Exclude<ActionRiskClass, (typeof RISK_CLASSES)[number]>>,
  Exhaustive<Exclude<ActionApprovalDecision, (typeof APPROVAL_DECISIONS)[number]>>,
];

/** A receipt that could still move. A persisted turn cannot still be waiting on one (INV-18). */
const OPEN_RECEIPT_STATUSES: ReadonlySet<ActionReceiptStatus> = new Set(["pending", "allowed", "executing"]);

export const TOOL_ARGS_NOTES = ["unavailable", "empty", "unparsable", "over_budget"] as const;
export const TOOL_RESULT_NOTES = ["pending", "unfinished", "empty", "over_budget"] as const;

// ── Limits (SPEC §2.4) ───────────────────────────────────────────────────────

/** `ToolCallRecord.args` strings: single line, this many characters. */
export const MAX_PRESENT_ARG_CHARS = 200;
const MAX_PRESENT_ARGS = 24;
/** `ToolCallRecord.error.detail`: one line, this many characters. */
export const MAX_ERROR_DETAIL_CHARS = 300;
const MAX_TITLE_CHARS = 200;
const MAX_LABEL_CHARS = 300;
const MAX_ID_CHARS = 256;
const MAX_QUERY_CHARS = 400;
const MAX_ENGINE_CHARS = 40;
const MAX_URL_CHARS = 2_048;
const MAX_WEB_RESULTS = 10;
const MAX_WEB_LINKS = 20;
const MAX_SEARCH_SUGGESTIONS_BYTES = 16 * 1_024;
/** INV-4: one commentary item, like one `delta` frame. */
const MAX_COMMENTARY_ITEM_BYTES = 64 * 1_024;
const MAX_NOTICE_PARAMS = 20;
const MAX_NOTICE_PARAM_CHARS = 300;

// ── String helpers ───────────────────────────────────────────────────────────

export { clampChars, clampUtf8, singleLine, utf8Length };

function readString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? clampChars(value, max) : undefined;
}

function readLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = clampChars(singleLine(value), max);
  return line || undefined;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readInteger(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : undefined;
}

function readHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_CHARS) return undefined;
  try {
    const url = new URL(trimmed);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── Tool detail (moved from tool-detail.ts, which re-exports it) ──────────────

/**
 * Rebuild a persisted tool detail from the `Message.activity` JSON.
 *
 * As tolerant as `serializeActivity` itself, and for the same reason: a row
 * written by a LATER build must still load here. An unrecognised note degrades
 * that one field to `undefined` — never the whole event, and never a thrown
 * conversation load. A row written BEFORE this shipped has no `tool` at all and
 * returns `undefined`, which is what lets replay degrade to the old name-only
 * row with no version check anywhere.
 */
export function readToolDetail(raw: unknown): ClientToolDetail | undefined {
  if (!isRecord(raw)) return undefined;
  const server = typeof raw.server === "string" ? raw.server : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!server || !name) return undefined;

  const detail: ClientToolDetail = { server, name };
  if (typeof raw.args === "string") detail.args = raw.args;
  const argsNote = readEnum(raw.argsNote, TOOL_ARGS_NOTES);
  if (argsNote) detail.argsNote = argsNote;
  if (raw.argsTruncated === true) detail.argsTruncated = true;

  if (typeof raw.result === "string") detail.result = raw.result;
  const resultNote = readEnum(raw.resultNote, TOOL_RESULT_NOTES);
  // "pending" is a claim about the present tense, and it is only ever true
  // while a stream is open. A run stopped mid-call persists its row as it
  // stood, so anything read back from the database has a run that is over by
  // definition — telling someone that last Tuesday's call is "still running"
  // would be the panel lying with a field rather than with a number.
  if (resultNote) detail.resultNote = resultNote === "pending" ? "unfinished" : resultNote;
  if (raw.resultTruncated === true) detail.resultTruncated = true;
  const resultChars = readCount(raw.resultChars);
  if (resultChars !== undefined) detail.resultChars = resultChars;

  const status = readEnum(raw.status, ["ok", "failed"] as const);
  if (status) detail.status = status;
  const durationMs = readCount(raw.durationMs);
  if (durationMs !== undefined) detail.durationMs = durationMs;

  return detail;
}

// ── The typed payloads ───────────────────────────────────────────────────────

export function isTerminalToolCallStatus(status: ToolCallStatus): boolean {
  return TERMINAL_TOOL_CALL_STATUSES.includes(status);
}

/** The legacy `tool.status` a stale tab still reads: `succeeded` → ok, any other ending → failed. */
export function legacyToolStatus(status: ToolCallStatus): "ok" | "failed" | undefined {
  if (status === "succeeded") return "ok";
  return isTerminalToolCallStatus(status) ? "failed" : undefined;
}

export function readPresentArgs(raw: unknown): ToolPresentArgs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: ToolPresentArgs = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_PRESENT_ARGS) break;
    if (!key || key.length > 64) continue;
    if (typeof value === "string") {
      const line = clampChars(singleLine(value), MAX_PRESENT_ARG_CHARS);
      if (!line) continue;
      out[key] = line;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else {
      continue;
    }
    count += 1;
  }
  return out;
}

export function readToolFigure(raw: unknown): ToolFigure | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = readEnum(raw.kind, TOOL_FIGURE_KINDS);
  if (!kind) return undefined;
  const figure: ToolFigure = { kind };
  const n = readInteger(raw.n, 0);
  if (n !== undefined) figure.n = n;
  const value = readLine(raw.value, MAX_PRESENT_ARG_CHARS);
  if (value !== undefined) figure.value = value;
  return figure;
}

export function readToolWebDetail(raw: unknown): ToolWebDetail | undefined {
  if (!isRecord(raw)) return undefined;
  const web: ToolWebDetail = {};
  const query = readLine(raw.query, MAX_QUERY_CHARS);
  if (query) web.query = query;
  const engine = readLine(raw.engine, MAX_ENGINE_CHARS);
  if (engine) web.engine = engine;
  if (Array.isArray(raw.results)) {
    const results: NonNullable<ToolWebDetail["results"]> = [];
    for (const item of raw.results) {
      if (results.length >= MAX_WEB_RESULTS) break;
      if (!isRecord(item) || typeof item.url !== "string") continue;
      // The same normalisation a streamed source gets (INV-3), so a result row
      // can never carry a title the native decoder would refuse.
      const source = normalizeSource({ url: item.url, title: typeof item.title === "string" ? item.title : "" });
      if (!source) continue;
      const n = readInteger(item.n, 1);
      results.push({ ...(n !== undefined ? { n } : {}), title: source.title, url: source.url });
    }
    web.results = results;
  }
  const requestedUrl = readHttpUrl(raw.requestedUrl);
  if (requestedUrl) web.requestedUrl = requestedUrl;
  const finalUrl = readHttpUrl(raw.finalUrl);
  if (finalUrl) web.finalUrl = finalUrl;
  const contentType = readEnum(raw.contentType, ["html", "pdf", "text", "json", "xml"] as const);
  if (contentType) web.contentType = contentType;
  const pages = readInteger(raw.pages, 0);
  if (pages !== undefined) web.pages = pages;
  const chars = readInteger(raw.chars, 0);
  if (chars !== undefined) web.chars = chars;
  const totalChars = readInteger(raw.totalChars, 0);
  if (totalChars !== undefined) web.totalChars = totalChars;
  if (Array.isArray(raw.links)) {
    web.links = raw.links.map(readHttpUrl).filter((link): link is string => !!link).slice(0, MAX_WEB_LINKS);
  }
  const injection = readEnum(raw.injection, ["suspicious", "hostile"] as const);
  if (injection) web.injection = injection;
  if (typeof raw.searchSuggestionsHtml === "string" && raw.searchSuggestionsHtml) {
    web.searchSuggestionsHtml = clampUtf8(raw.searchSuggestionsHtml, MAX_SEARCH_SUGGESTIONS_BYTES);
  }
  return web;
}

function readApproval(raw: unknown): ToolCallApproval | undefined {
  if (!isRecord(raw)) return undefined;
  const id = readString(raw.id, MAX_ID_CHARS);
  const status = readEnum(raw.status, RECEIPT_STATUSES);
  if (!id || !status) return undefined;
  const approval: ToolCallApproval = {
    id,
    // INV-18: the receipt, not this copy, is the live record. A copy that was
    // never settled belongs to a turn that is over, so the wait expired.
    status: OPEN_RECEIPT_STATUSES.has(status) ? "expired" : status,
    riskClass: readEnum(raw.riskClass, RISK_CLASSES) ?? "unknown",
  };
  if (raw.decision === null) approval.decision = null;
  else {
    const decision = readEnum(raw.decision, APPROVAL_DECISIONS);
    if (decision) approval.decision = decision;
  }
  if (raw.decidedAt === null) approval.decidedAt = null;
  else if (typeof raw.decidedAt === "string" && raw.decidedAt) approval.decidedAt = clampChars(raw.decidedAt, 64);
  if (typeof raw.expiresAt === "string" && raw.expiresAt) approval.expiresAt = clampChars(raw.expiresAt, 64);
  return approval;
}

function readToolError(raw: unknown): ToolCallRecord["error"] {
  if (!isRecord(raw)) return undefined;
  const code = readEnum(raw.code, TOOL_ERROR_CODES);
  if (!code) return undefined;
  const detail = readLine(raw.detail, MAX_ERROR_DETAIL_CHARS);
  return detail ? { code, detail } : { code };
}

function defaultOrigin(tool: CanonicalToolId): ToolCallRecord["origin"] {
  if (tool === "provider_web_search" || tool === "provider_x_search") return "provider";
  return tool === "mcp" ? "connector" : "juno";
}

/**
 * A persisted tool record, or `undefined` when it is not one this build can
 * present (no id, an unknown tool). `fallbackStartedAt` is the row's own
 * `createdAt`, which is the call's start by construction.
 */
export function readToolCallRecord(raw: unknown, fallbackStartedAt = ""): ToolCallRecord | undefined {
  if (!isRecord(raw) || raw.v !== 1) return undefined;
  const callId = readString(raw.callId, MAX_ID_CHARS);
  const tool = readEnum(raw.tool, CANONICAL_TOOL_IDS);
  if (!callId || !tool) return undefined;

  let status: ToolCallStatus = readEnum(raw.status, TOOL_CALL_STATUSES) ?? "cancelled";
  let error = readToolError(raw.error);
  // §2.5: the typed twin of the `pending` → `unfinished` rewrite. Whatever was
  // happening when the row was written, the turn is over now.
  if (!isTerminalToolCallStatus(status)) {
    status = "cancelled";
    error = { code: "cancelled" };
  }

  const record: ToolCallRecord = {
    v: 1,
    callId,
    tool,
    origin: readEnum(raw.origin, ["juno", "connector", "provider"] as const) ?? defaultOrigin(tool),
    title: readLine(raw.title, MAX_TITLE_CHARS) ?? tool,
    status,
    round: readInteger(raw.round, 0) ?? 0,
    index: readInteger(raw.index, 0) ?? 0,
    startedAt:
      typeof raw.startedAt === "string" && raw.startedAt ? clampChars(raw.startedAt, 64) : fallbackStartedAt,
  };
  const providerCallId = readString(raw.providerCallId, MAX_ID_CHARS);
  if (providerCallId) record.providerCallId = providerCallId;
  const connectorId = readLine(raw.connectorId, MAX_LABEL_CHARS);
  if (connectorId) record.connectorId = connectorId;
  const connectorLabel = readLine(raw.connectorLabel, MAX_LABEL_CHARS);
  if (connectorLabel) record.connectorLabel = connectorLabel;
  const toolTitle = readLine(raw.toolTitle, MAX_LABEL_CHARS);
  if (toolTitle) record.toolTitle = toolTitle;
  if (typeof raw.endedAt === "string" && raw.endedAt) record.endedAt = clampChars(raw.endedAt, 64);
  const durationMs = readCount(raw.durationMs);
  if (durationMs !== undefined) record.durationMs = durationMs;
  const timeoutMs = readCount(raw.timeoutMs);
  if (timeoutMs !== undefined) record.timeoutMs = timeoutMs;
  const args = readPresentArgs(raw.args);
  if (args) record.args = args;
  const figure = readToolFigure(raw.figure);
  if (figure) record.figure = figure;
  if (error) record.error = error;
  const approval = readApproval(raw.approval);
  if (approval) record.approval = approval;
  const web = readToolWebDetail(raw.web);
  if (web) record.web = web;
  if (raw.cached === true) record.cached = true;
  return record;
}

export function readReasoningSegment(raw: unknown): ReasoningSegment | undefined {
  if (!isRecord(raw)) return undefined;
  const round = readInteger(raw.round, 0);
  const offset = readInteger(raw.offset, 0);
  if (round === undefined || offset === undefined) return undefined;
  const part = readInteger(raw.part, 0);
  return part === undefined ? { round, offset } : { round, part, offset };
}

export function readCommentaryItem(raw: unknown): CommentaryItem | undefined {
  if (!isRecord(raw)) return undefined;
  const round = readInteger(raw.round, 0);
  if (round === undefined || typeof raw.text !== "string" || !raw.text.trim()) return undefined;
  return {
    round,
    text: clampUtf8(raw.text, MAX_COMMENTARY_ITEM_BYTES),
    // A later build that omits the flag wrote a text-first provider's
    // commentary, which is the common shape; `inline` is the safe default.
    inline: raw.inline !== false,
  };
}

function readConnectorFacts(raw: unknown): Extract<RunFact, { key: "connectors" }> | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.ready) || !Array.isArray(raw.failed)) return undefined;
  const ready: Extract<RunFact, { key: "connectors" }>["ready"] = [];
  for (const item of raw.ready) {
    if (!isRecord(item)) continue;
    const id = readLine(item.id, MAX_LABEL_CHARS);
    const label = readLine(item.label, MAX_LABEL_CHARS);
    if (!id || !label) continue;
    ready.push({ id, label, tools: readInteger(item.tools, 0) ?? 0 });
  }
  const failed: Extract<RunFact, { key: "connectors" }>["failed"] = [];
  for (const item of raw.failed) {
    if (!isRecord(item)) continue;
    const id = readLine(item.id, MAX_LABEL_CHARS);
    const label = readLine(item.label, MAX_LABEL_CHARS);
    const reason = readEnum(item.reason, CONNECTOR_FAILURES);
    if (!id || !label || !reason) continue;
    failed.push({ id, label, reason });
  }
  return { key: "connectors", ready, failed };
}

export function readRunFact(raw: unknown): RunFact | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.key) {
    case "model": {
      const modelId = readLine(raw.modelId, MAX_LABEL_CHARS);
      const provider = readLine(raw.provider, MAX_LABEL_CHARS);
      const label = readLine(raw.label, MAX_LABEL_CHARS);
      if (!modelId || !provider || !label) return undefined;
      return { key: "model", modelId, provider, label, ...(raw.routed === true ? { routed: true } : {}) };
    }
    case "effort": {
      const effort = readEnum(raw.effort, RUN_EFFORTS);
      return effort ? { key: "effort", effort, auto: raw.auto === true } : undefined;
    }
    case "context":
      return {
        key: "context",
        historyMessages: readInteger(raw.historyMessages, 0) ?? 0,
        attachments: readInteger(raw.attachments, 0) ?? 0,
        projectFiles: readInteger(raw.projectFiles, 0) ?? 0,
      };
    case "tools":
      return {
        key: "tools",
        offered: Array.isArray(raw.offered)
          ? raw.offered.filter((id): id is CanonicalToolId => readEnum(id, CANONICAL_TOOL_IDS) !== undefined)
          : [],
        nativeSearch: raw.nativeSearch === true,
        roundBudget: readInteger(raw.roundBudget, 1) ?? 1,
      };
    case "connectors":
      return readConnectorFacts(raw);
    case "memory":
      return { key: "memory" };
    case "research": {
      const runId = readString(raw.runId, MAX_ID_CHARS);
      const title = readLine(raw.title, 2_000);
      const leadModel = readLine(raw.leadModel, MAX_LABEL_CHARS);
      const state = readEnum(raw.state, ["completed", "partially_completed"] as const);
      if (!runId || !title || !leadModel || !state) return undefined;
      return {
        key: "research",
        runId,
        title,
        workedMs: readCount(raw.workedMs) ?? 0,
        cited: readInteger(raw.cited, 0) ?? 0,
        read: readInteger(raw.read, 0) ?? 0,
        pages: readInteger(raw.pages, 0) ?? 0,
        leadModel,
        state,
      };
    }
    default:
      return undefined;
  }
}

export function readRunNotice(raw: unknown): RunNotice | undefined {
  if (!isRecord(raw)) return undefined;
  const code = readEnum(raw.code, RUN_NOTICE_CODES);
  if (!code) return undefined;
  if (!isRecord(raw.params)) return { code };
  const params: Record<string, string | number> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw.params)) {
    if (count >= MAX_NOTICE_PARAMS) break;
    if (!key || key.length > 64) continue;
    if (typeof value === "number" && Number.isFinite(value)) params[key] = value;
    else if (typeof value === "string") params[key] = clampChars(singleLine(value), MAX_NOTICE_PARAM_CHARS);
    else continue;
    count += 1;
  }
  return count ? { code, params } : { code };
}

function readOptionalText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

export function readMemoryReceipt(raw: unknown): ClientMemoryReceipt[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const receipt: ClientMemoryReceipt[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || typeof item.content !== "string") continue;
    const entry: ClientMemoryReceipt = { id: item.id, content: item.content };
    const category = readOptionalText(item.category);
    if (category !== undefined) entry.category = category;
    const sourceRef = readOptionalText(item.sourceRef);
    if (sourceRef !== undefined) entry.sourceRef = sourceRef;
    const sourceMessageId = readOptionalText(item.sourceMessageId);
    if (sourceMessageId !== undefined) entry.sourceMessageId = sourceMessageId;
    receipt.push(entry);
  }
  return receipt.length ? receipt : undefined;
}

type ArtifactVerification = NonNullable<ClientActivityEvent["artifactVerification"]>;
type ArtifactProblem = ArtifactVerification["problems"][number];

function readStringList(raw: unknown): string[] | undefined {
  return Array.isArray(raw) && raw.every((item) => typeof item === "string") ? [...raw] : undefined;
}

function readProblems(raw: unknown): ArtifactProblem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const problems: ArtifactProblem[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.identifier !== "string" ||
      typeof item.code !== "string" ||
      typeof item.detail !== "string" ||
      typeof item.repairable !== "boolean"
    ) {
      return undefined;
    }
    problems.push({ identifier: item.identifier, code: item.code, detail: item.detail, repairable: item.repairable });
  }
  return problems;
}

export function readArtifactVerification(raw: unknown): ArtifactVerification | undefined {
  if (!isRecord(raw) || raw.version !== 1) return undefined;
  const status = readEnum(raw.status, ["verified", "repaired", "refused"] as const);
  const attempts = readInteger(raw.attempts, 0);
  const checked = readInteger(raw.checked, 0);
  const accepted = readStringList(raw.accepted);
  const refused = readStringList(raw.refused);
  const problems = readProblems(raw.problems);
  const repairs = readProblems(raw.repairs);
  if (!status || attempts === undefined || checked === undefined || !accepted || !refused || !problems || !repairs) {
    return undefined;
  }
  return { version: 1, status, attempts, checked, accepted, refused, problems, repairs };
}

// ── The row ──────────────────────────────────────────────────────────────────

/**
 * Rebuild the activity log from the (already decrypted) `Message.activity`
 * JSON. `serializers.ts` unseals the column first; this runs on the recovered
 * structure, so a row that could not be decrypted arrives as null and lands on
 * the `!Array.isArray` branch — the same "no activity" rendering a message
 * written before the column existed already gets.
 *
 * Legacy rows (no `seq` anywhere) come back exactly as they did before the
 * rework; the new keys are spread in only when present and valid.
 */
export function serializeActivity(decrypted: unknown): ClientActivityEvent[] | undefined {
  if (!Array.isArray(decrypted)) return undefined;

  const events = decrypted.flatMap((item): ClientActivityEvent[] => {
    if (!isRecord(item)) return [];
    const record = item;
    const id = typeof record.id === "string" ? record.id : "";
    const kind = typeof record.kind === "string" && ACTIVITY_KINDS.has(record.kind as ActivityKind) ? record.kind : "";
    const title = typeof record.title === "string" ? record.title : "";
    const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
    if (!id || !kind || !title || !createdAt) return [];

    // The connector payload behind a tool row. Absent on every message written
    // before it shipped, and on every row that is not one real call — which is
    // exactly why replay degrades to the old name-only row rather than needing
    // a version check.
    const tool = readToolDetail(record.tool);

    // Juno Code's two extra keys on the shared row shape. `patch` is the
    // unified diff a `write` row may carry (capped at write time by
    // persistCodeTaskOutcome in lib/code-task-outcome.ts); `exitCode` is a tool
    // row's process status. Both were being written and then dropped on the
    // way back out — the exact silent failure the note above describes — so a
    // reloaded Code session lost every diff it had shown live. Read
    // additively: a chat row never carries either and sees no change.
    const patch = typeof record.patch === "string" && record.patch.length > 0 ? record.patch : undefined;
    const exitCode =
      typeof record.exitCode === "number" && Number.isFinite(record.exitCode) ? record.exitCode : undefined;

    // What the rework adds (SPEC §2.4), each read by its own tolerant reader.
    const memoryReceipt = readMemoryReceipt(record.memoryReceipt);
    const artifactVerification = readArtifactVerification(record.artifactVerification);
    const seq = readInteger(record.seq, 1);
    const round = readInteger(record.round, 0);
    const call = readToolCallRecord(record.call, createdAt);
    const segment = readReasoningSegment(record.segment);
    const commentary = readCommentaryItem(record.commentary);
    const fact = readRunFact(record.fact);
    const notice = readRunNotice(record.notice);

    return [
      {
        id,
        kind: kind as ActivityKind,
        title,
        detail: typeof record.detail === "string" ? record.detail : undefined,
        url: typeof record.url === "string" ? record.url : undefined,
        createdAt,
        ...(tool ? { tool } : {}),
        ...(memoryReceipt ? { memoryReceipt } : {}),
        ...(artifactVerification ? { artifactVerification } : {}),
        ...(patch ? { patch } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(seq !== undefined ? { seq } : {}),
        ...(round !== undefined ? { round } : {}),
        ...(call ? { call } : {}),
        ...(segment ? { segment } : {}),
        ...(commentary ? { commentary } : {}),
        ...(fact ? { fact } : {}),
        ...(notice ? { notice } : {}),
      },
    ];
  });

  return events.length ? events : undefined;
}

// ── Row builders shared by the server's emitters ─────────────────────────────

const MUST_ACT: ReadonlySet<RunNoticeCode> = new Set(MUST_ACT_NOTICE_CODES);

/** `warning` only for what a reader must act on (INV-7); every other notice is `context`. */
export function noticeKind(code: RunNoticeCode): "warning" | "context" {
  return MUST_ACT.has(code) ? "warning" : "context";
}

/**
 * A notice row: the typed `notice` beside the legacy English title a native
 * build shows (SPEC §2.4). The caller owns the English wording, because only
 * the caller knows what the legacy row said before the rework.
 */
export function noticeActivity(
  notice: RunNotice,
  legacy: { title: string; detail?: string },
): Omit<ClientActivityEvent, "id" | "createdAt"> {
  return {
    kind: noticeKind(notice.code),
    title: legacy.title,
    ...(legacy.detail ? { detail: legacy.detail } : {}),
    notice: notice.params ? { code: notice.code, params: { ...notice.params } } : { code: notice.code },
  };
}

/**
 * Rows a profile-1 client never receives live, though every client gets them
 * back from the database (SPEC §2.4): reasoning segment markers, commentary
 * and the offered-tools fact. iOS draws its progress block for ANY activity
 * row, so streaming them would grow a native turn's trail for nothing.
 */
export function isTimelineOnlyActivity(event: Pick<ClientActivityEvent, "segment" | "commentary" | "fact">): boolean {
  return !!event.segment || !!event.commentary || event.fact?.key === "tools";
}

/**
 * The persisted shape of a record: the read-time rewrites applied at write
 * time too, so the row in the database already says what a reload will show.
 */
export function settleToolCallRecord(record: ToolCallRecord): ToolCallRecord {
  if (isTerminalToolCallStatus(record.status) && !(record.approval && OPEN_RECEIPT_STATUSES.has(record.approval.status))) {
    return record;
  }
  const settled: ToolCallRecord = { ...record };
  if (!isTerminalToolCallStatus(settled.status)) {
    settled.status = "cancelled";
    settled.error = { code: "cancelled" };
  }
  if (settled.approval && OPEN_RECEIPT_STATUSES.has(settled.approval.status)) {
    settled.approval = { ...settled.approval, status: "expired" };
  }
  return settled;
}
