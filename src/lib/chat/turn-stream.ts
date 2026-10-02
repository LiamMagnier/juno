/**
 * The one place a turn's `LlmEvent`s become SSE frames and activity rows
 * (SPEC §2.10). Both of the route's paths — saved and private — call it, so
 * the frame grammar a client receives is decided here and gated here by what
 * the client declared (INV-1, INV-27).
 *
 * THE TWO GRAMMARS. A client that declared `timeline` gets `round`/`phase` on
 * its text frames and the timeline-only rows (reasoning segments, commentary,
 * the offered-tools fact) live. Every other client — every shipped native
 * build — gets the frozen profile-1 grammar: the same frame types it always
 * got, a blank-line separator delta between two steps' text so live text is
 * never glued (INV-8), and the legacy "needs approval" row. Both get the same
 * persisted activity: a timeline-only row is RECORDED for every client and
 * STREAMED only to a timeline one, so a reload renders it whoever started the
 * turn (SPEC §2.4).
 *
 * ONE ROW PER CALL. A tool call is one activity event, created at the `call`
 * act with its typed record (`call`) beside the legacy `kind`/`title`/`detail`
 * a native build reads (INV-7), then updated IN PLACE — same object, same `id`,
 * same `seq` — on every status and on the result (SPEC §2.5). The entry the
 * sender hands back is the one sitting in its log, which is what persists, so
 * mutating it and re-sending keeps the log's order and the finished payload.
 *
 * What it never does: send `done`, `error` or `handoff` (the route owns the
 * terminal frame), write to the database, or decide a tool's outcome. It
 * reports how many calls are running or waiting, so the route can pause the
 * stall watchdog (INV-33), and hands every approval to the route, which owns
 * the approval frame.
 */

import type { ActionReceiptStatus, ClientActionApproval } from "@/lib/action-approval";
import type { SseSender } from "@/lib/chat-stream";
import { commentaryForRound, isCommentarySegment, splitAnswer } from "@/lib/chat/answer-split";
import type { ClientFeatureSet } from "@/lib/chat/client-features";
import {
  humanizeToolName,
  isTerminalToolCallStatus,
  isTimelineOnlyActivity,
  junoToolIdOf,
  readPresentArgs,
  readToolFigure,
  readToolWebDetail,
  settleToolCallRecord,
} from "@/lib/chat/run-record";
import { clampChars, singleLine, type SourceRegistry } from "@/lib/chat/source-registry";
import type { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import { START_TASK_TOOL_ID, isTaskApproval, taskActivityTitle, taskTitleFromArgs } from "@/lib/chat/task-tool";
import { closeToolDetail, createToolDetailBudget, openToolDetail } from "@/lib/chat/tool-detail";
import type { ResolvedTool } from "@/lib/tools/types";
import type { TaintSource, TurnTaint } from "@/lib/web/taint";
import type { LazyUrlLedger, UrlLedgerKind } from "@/lib/web/types";
import type { ClientActivityEvent, ClientSource, ClientToolDetail } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";
import type {
  CanonicalToolId,
  ChatSourceOrigin,
  ToolCallApproval,
  ToolCallRecord,
  ToolCallStatus,
  ToolErrorCode,
} from "@/types/run";

/** What the turn stream needs to know about a function name the model called. */
export type TurnToolIdentity = Pick<
  ResolvedTool,
  "canonical" | "origin" | "title" | "connectorId" | "connectorLabel" | "toolTitle"
>;

export interface TurnStreamOptions {
  sender: SseSender;
  features: ClientFeatureSet;
  acc: GenerationAccumulator;
  sources: SourceRegistry;
  /** The turn's provenance ledger; null when no web tool is attached. */
  ledger: LazyUrlLedger | null;
  taint: TurnTaint;
  /** false under lockdown. */
  toolDetailEnabled: boolean;
  /** Calls in `running` or `awaiting_approval`: the route pauses the stall watchdog while > 0 (INV-33). */
  onToolActivityChange(active: number): void;
  /** Sends the approval frame (the route owns it). */
  onApproval(approval: ClientActionApproval): void;
  /** Budget guard enforce + soft finalize. */
  onUsage(ev: Extract<LlmEvent, { type: "usage" }>): void;
  /** A provider search finished (server_tool result); counts against the turn's search cap. */
  onProviderSearch(): void;
  /** Suppresses text frames, as artifact-edit turns do today. */
  artifactEdit: boolean;
  /**
   * The turn's toolset lookup (`ChatToolset.resolve`). Absent, or unknown to
   * it, a name is read as a Juno tool id (aliases included), `start_task`, or
   * otherwise a connector function named `<connector>__<tool>`.
   */
  resolveTool?: (name: string) => TurnToolIdentity | undefined;
  /** A private chat: its first text writes the private path's legacy row. */
  privateTurn?: boolean;
  /** The clock behind `startedAt`/`endedAt`. The `/dev/run` player passes script time. */
  now?: () => number;
}

// ── Legacy wire text (INV-7) ─────────────────────────────────────────────────
//
// English, exactly as the pre-rework route wrote it: shipped native builds show
// these titles, and iOS matches some of them. The typed UI never reads them on
// a typed row (INV-28); it reads `call`, `segment`, `commentary`, `fact` and
// `notice`.

const LEGACY_SEARCH_TITLE = "Searching the web";
const LEGACY_VISIT_TITLE = "Visited source";
const LEGACY_THINKING_TITLE = "Thinking";
const LEGACY_COMMENTARY_TITLE = "Commentary";
const LEGACY_TASK_APPROVAL_TITLE = "Starting a task needs your approval";

function legacyWriteRow(opts: { artifactEdit: boolean; privateTurn: boolean }): Omit<ClientActivityEvent, "id" | "createdAt"> {
  if (opts.artifactEdit) return { kind: "write", title: "Preparing targeted changes", detail: "Building an exact source patch" };
  if (opts.privateTurn) return { kind: "write", title: "Writing the private answer", detail: "Streaming response text" };
  return { kind: "write", title: "Writing the answer", detail: "Streaming response text" };
}

/**
 * The English human title of a Juno tool when the toolset gave none. Keyed by
 * id, never shown by the typed UI; it names the tool on legacy rows and in the
 * record, as `ToolSpec.title` does when the route passes `resolveTool`.
 */
const FALLBACK_TOOL_TITLES: Readonly<Record<CanonicalToolId, string>> = {
  web_search: "Web search",
  web_fetch: "Web page reader",
  read_document: "Document reader",
  inspect_image: "Image inspector",
  run_code: "Code runner",
  search_chats: "Chat search",
  current_time: "Clock",
  calculate: "Calculator",
  start_task: "Task handoff",
  suggest_research: "Research suggestion",
  provider_web_search: "Web search",
  provider_x_search: "X search",
  mcp: "Connector tool",
};

/** One activity row's detail line: single line, at most this many characters. */
const MAX_LEGACY_DETAIL_CHARS = 300;
/** The legacy `detail` of a commentary row: its first characters (SPEC §2.4). */
const COMMENTARY_DETAIL_CHARS = 96;

// ── Rows ─────────────────────────────────────────────────────────────────────

interface CallRow {
  entry: ClientActivityEvent;
  /** The same object as `entry.call`, mutated in place. */
  record: ToolCallRecord;
  server: string;
  name: string;
  /** Raw argument text, from whichever act carried it. */
  args?: string;
  opened?: ClientToolDetail;
  queuedSeen: boolean;
  approvalRowSent: boolean;
  /** The call passed an approval wait and was allowed to run. */
  ranAfterApproval: boolean;
}

interface ServerCallRow {
  entry: ClientActivityEvent;
  record: ToolCallRecord;
}

type ActivityRow = Omit<ClientActivityEvent, "id" | "createdAt">;

function line(value: string | undefined | null, max = MAX_LEGACY_DETAIL_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = clampChars(singleLine(value), max);
  return out || undefined;
}

function argString(argsText: string | undefined, key: string): string | undefined {
  if (!argsText) return undefined;
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

function defaultErrorCode(status: ToolCallStatus): ToolErrorCode | undefined {
  switch (status) {
    case "failed":
      return "tool_error";
    case "denied":
      return "denied";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

const APPROVAL_DECISIONS: readonly string[] = ["allow_once", "allow_scope", "deny"];

function approvalProjection(approval: ClientActionApproval): ToolCallApproval {
  // The projection types `decision` as a string; the record keeps only the
  // three the broker writes.
  const decision = APPROVAL_DECISIONS.includes(approval.decision ?? "")
    ? (approval.decision as ToolCallApproval["decision"])
    : null;
  return {
    id: approval.id,
    status: approval.status,
    riskClass: approval.riskClass,
    decision,
    decidedAt: approval.decidedAt ?? null,
    expiresAt: approval.expiresAt,
  };
}

/**
 * The receipt's status as of the call's end (INV-18), read off how the call
 * ended: the typed twin of the §2.5 derivation table, run backwards.
 */
function finalReceiptStatus(record: ToolCallRecord, ranAfterApproval: boolean): ActionReceiptStatus {
  switch (record.status) {
    case "denied":
      return "denied";
    case "expired":
      return "expired";
    case "succeeded":
      return "executed";
    case "cancelled":
      return ranAfterApproval ? "failed" : "superseded";
    case "failed":
      return record.error?.code === "blocked" ? "blocked" : "failed";
    default:
      return record.approval?.status ?? "pending";
  }
}

/** Where a source origin puts a URL on the provenance ledger; null = never (Gemini grounding). */
function ledgerKindFor(origin: ChatSourceOrigin | undefined): UrlLedgerKind | null {
  switch (origin) {
    case "provider_grounding":
      return null;
    case "juno_fetch":
      return "fetched_page";
    case "research":
      return "research_source";
    default:
      return "search_result";
  }
}

/** Sources that keep today's per-result "Visited source" rows: provider search, and producers that predate `origin`. */
function takesLegacyVisitRow(origin: ChatSourceOrigin | undefined): boolean {
  return origin === undefined || origin === "provider_search" || origin === "provider_grounding";
}

function isProviderOrigin(origin: ChatSourceOrigin | undefined): boolean {
  return origin === "provider_search" || origin === "provider_grounding";
}

// ── The stream ───────────────────────────────────────────────────────────────

export class TurnStream {
  private readonly opts: TurnStreamOptions;
  private readonly timeline: boolean;
  private readonly now: () => number;
  private readonly detailBudget = createToolDetailBudget();
  private readonly calls = new Map<string, CallRow>();
  private readonly serverCalls = new Map<string, ServerCallRow>();
  /** Calls per round, for the `index` of an event that does not carry one. */
  private readonly roundCallCounts = new Map<number, number>();
  /** The commentary row written when each round ended in tool calls. */
  private readonly commentaryRows = new Map<number, ClientActivityEvent>();
  private active = 0;
  private lastReasoningKey: string | null = null;
  /** Round of the last text streamed as a `delta`, and whether it ended in a newline. */
  private lastDeltaRound: number | null = null;
  private lastDeltaEndsInNewline = true;
  private result: { answer: string; activity: ClientActivityEvent[] } | null = null;

  constructor(opts: TurnStreamOptions) {
    this.opts = opts;
    this.timeline = opts.features.has("timeline");
    this.now = opts.now ?? Date.now;
  }

  /** The number of Juno and connector calls running or waiting on a person. */
  get activeCalls(): number {
    return this.active;
  }

  /**
   * Records one activity row with the stream's gating: a timeline-only row is
   * recorded for every client and streamed only to a `timeline` one. The route
   * sends its turn-start facts and notices through here (SPEC §2.12).
   */
  emitActivity(row: ActivityRow): ClientActivityEvent {
    return sendRunActivity(this.opts.sender, this.opts.features, row);
  }

  /** Applies one LlmEvent: updates acc, sends frames, returns nothing. Never throws on bad input. */
  apply(ev: LlmEvent): void {
    if (this.result || !ev || typeof ev !== "object") return;
    switch (ev.type) {
      case "text":
        if (typeof ev.text === "string") this.onText(ev);
        return;
      case "reasoning":
        if (typeof ev.text === "string") this.onReasoning(ev);
        return;
      case "round_end":
        if (Number.isInteger(ev.round) && ev.round >= 0) this.onRoundEnd(ev);
        return;
      case "tool":
        if (typeof ev.callId !== "string" || !ev.callId) return;
        if (ev.phase === "call") this.onToolCall(ev);
        else if (ev.phase === "status") this.onToolStatus(ev);
        else if (ev.phase === "result") this.onToolResult(ev);
        return;
      case "server_tool":
        if (typeof ev.callId !== "string" || !ev.callId) return;
        if (ev.phase === "call") this.onServerToolCall(ev);
        else if (ev.phase === "result") this.onServerToolResult(ev);
        return;
      case "sources":
        if (Array.isArray(ev.sources)) this.onSources(ev);
        return;
      case "usage":
        this.opts.acc.apply(ev);
        this.opts.onUsage(ev);
        return;
      case "finish":
        this.opts.acc.apply(ev);
        return;
      default:
        // The dead `approval` member and anything newer: approvals travel as
        // the `tool` status `awaiting_approval` (SPEC §2.9).
        return;
    }
  }

  /** Called once after the provider stream ends (or aborts): closes open calls as cancelled,
   *  emits the final commentary split and returns what persists. */
  finish(_reason: "completed" | "aborted"): { answer: string; activity: ClientActivityEvent[] } {
    if (this.result) return this.result;

    // A persisted turn cannot still be running: whatever never reached its
    // result ended with the turn (SPEC §2.5), and says so now rather than on
    // the next reload.
    const endedAt = new Date(this.now()).toISOString();
    for (const row of this.calls.values()) {
      if (isTerminalToolCallStatus(row.record.status)) continue;
      row.record.status = "cancelled";
      row.record.error = { code: "cancelled" };
      row.record.endedAt = endedAt;
      if (row.record.approval) row.record.approval.status = finalReceiptStatus(row.record, row.ranAfterApproval);
      Object.assign(row.record, settleToolCallRecord(row.record));
      if (row.name === START_TASK_TOOL_ID) row.entry.title = taskActivityTitle("result", false);
      if (row.entry.tool && row.entry.tool.resultNote === "pending") {
        row.entry.tool = { ...row.entry.tool, resultNote: "unfinished" };
      }
      this.resend(row.entry);
    }
    for (const row of this.serverCalls.values()) {
      if (isTerminalToolCallStatus(row.record.status)) continue;
      row.record.status = "cancelled";
      row.record.error = { code: "cancelled" };
      row.record.endedAt = endedAt;
      this.resend(row.entry);
    }
    this.updateActive();

    const split = splitAnswer(this.opts.acc.textSegments);
    const keep = new Set(split.commentary.map((item) => item.round));
    // Rule 4 empties the commentary when the answer fell back to everything:
    // a row already written for such a round would show its text twice.
    const log = this.opts.sender.activityLog;
    for (const [round, entry] of this.commentaryRows) {
      if (keep.has(round)) continue;
      const at = log.indexOf(entry);
      if (at !== -1) log.splice(at, 1);
      this.commentaryRows.delete(round);
    }
    // Commentary no round end reported: a declared `commentary` item in a
    // round that ended with the answer, or a stream that stopped mid-round.
    for (const item of split.commentary) {
      if (this.commentaryRows.has(item.round)) continue;
      this.commentaryRows.set(item.round, this.emitCommentary(item.round, item.text));
    }

    this.result = { answer: split.answer, activity: log };
    return this.result;
  }

  // ── Text and reasoning ─────────────────────────────────────────────────────

  private onText(ev: Extract<LlmEvent, { type: "text" }>): void {
    const { acc } = this.opts;
    const effect = acc.apply(ev);
    if (effect.kind !== "text") return;
    const round = acc.textSegments[acc.textSegments.length - 1]?.round ?? acc.currentRound;
    if (effect.startedWriting) {
      this.emitActivity(legacyWriteRow({ artifactEdit: this.opts.artifactEdit, privateTurn: !!this.opts.privateTurn }));
    }
    // Patch-protocol output is server-internal: the client receives the
    // rebuilt artifact only after every anchor is validated (as today).
    if (this.opts.artifactEdit || !ev.text) return;

    if (this.timeline) {
      this.opts.sender.send({ type: "delta", text: ev.text, round, ...(ev.phase ? { phase: ev.phase } : {}) });
    } else {
      // INV-8: a later step's text never glues onto the earlier one live. The
      // native bubble is replaced by `done.message.content` at the end.
      if (this.lastDeltaRound !== null && round !== this.lastDeltaRound && !this.lastDeltaEndsInNewline) {
        this.opts.sender.send({ type: "delta", text: "\n\n" });
      }
      this.opts.sender.send({ type: "delta", text: ev.text });
    }
    this.lastDeltaRound = round;
    this.lastDeltaEndsInNewline = ev.text.endsWith("\n");
  }

  private onReasoning(ev: Extract<LlmEvent, { type: "reasoning" }>): void {
    const { acc } = this.opts;
    const effect = acc.apply(ev);
    if (effect.kind !== "reasoning") return;
    const round = effect.round;
    const key = `${round}:${ev.part ?? ""}`;
    if (key !== this.lastReasoningKey) {
      this.lastReasoningKey = key;
      // The flat length after any separator the fold inserted: where this
      // segment's text starts in `ClientMessage.reasoning`, byte for byte the
      // same on the client, which folds the frames with the same helper.
      const offset = acc.reasoning.length - ev.text.length;
      this.emitActivity({
        kind: "reasoning",
        title: LEGACY_THINKING_TITLE,
        round,
        segment: ev.part === undefined ? { round, offset } : { round, part: ev.part, offset },
      });
    }
    this.opts.sender.send({
      type: "reasoning",
      text: ev.text,
      ...(ev.part === undefined ? {} : { part: ev.part }),
      ...(this.timeline ? { round } : {}),
    });
  }

  private onRoundEnd(ev: Extract<LlmEvent, { type: "round_end" }>): void {
    this.opts.acc.apply(ev);
    if (ev.tools <= 0 || this.commentaryRows.has(ev.round)) return;
    const found = commentaryForRound(this.opts.acc.textSegments, ev.round);
    if (!found || !found.text) return;
    this.commentaryRows.set(ev.round, this.emitCommentary(ev.round, found.text));
  }

  private emitCommentary(round: number, text: string): ClientActivityEvent {
    // `inline`: the text streamed into the answer area live, which is every
    // undeclared segment; a provider that declared it commentary up front
    // (OpenAI `phase`) never showed it there.
    const inline = this.opts.acc.textSegments
      .filter((segment) => segment.round === round && isCommentarySegment(segment))
      .every((segment) => segment.phase === null);
    return this.emitActivity({
      kind: "reasoning",
      title: LEGACY_COMMENTARY_TITLE,
      detail: line(text, COMMENTARY_DETAIL_CHARS),
      round,
      commentary: { round, text, inline },
    });
  }

  // ── Juno and connector tools ───────────────────────────────────────────────

  private identify(server: string, name: string): TurnToolIdentity {
    const resolved = this.opts.resolveTool?.(name);
    if (resolved) return resolved;
    if (name === START_TASK_TOOL_ID) {
      return { canonical: "start_task", origin: "juno", title: FALLBACK_TOOL_TITLES.start_task };
    }
    const juno = junoToolIdOf(name);
    if (juno) return { canonical: juno, origin: "juno", title: FALLBACK_TOOL_TITLES[juno] };
    const toolTitle = humanizeToolName(name);
    return { canonical: "mcp", origin: "connector", title: toolTitle, connectorLabel: server || undefined, toolTitle };
  }

  private nextIndex(round: number): number {
    const index = this.roundCallCounts.get(round) ?? 0;
    this.roundCallCounts.set(round, index + 1);
    return index;
  }

  private onToolCall(ev: Extract<LlmEvent, { type: "tool"; phase: "call" }>): void {
    if (this.calls.has(ev.callId)) return;
    const server = typeof ev.server === "string" ? ev.server : "";
    const name = typeof ev.name === "string" ? ev.name : "";
    const identity = this.identify(server, name);
    const round = Number.isInteger(ev.round) && (ev.round as number) >= 0 ? (ev.round as number) : this.opts.acc.currentRound;
    const counted = this.nextIndex(round);
    const index = Number.isInteger(ev.index) && (ev.index as number) >= 0 ? (ev.index as number) : counted;

    const canonical: CanonicalToolId = (identity.canonical as CanonicalToolId) ?? "mcp";
    const record: ToolCallRecord = {
      v: 1,
      callId: ev.callId,
      ...(ev.providerCallId ? { providerCallId: ev.providerCallId } : {}),
      tool: canonical,
      origin: identity.origin === "connector" ? "connector" : "juno",
      title: line(identity.title, 200) ?? FALLBACK_TOOL_TITLES[canonical],
      ...(identity.connectorId ? { connectorId: identity.connectorId } : {}),
      ...(identity.connectorLabel ? { connectorLabel: identity.connectorLabel } : {}),
      ...(identity.toolTitle ? { toolTitle: identity.toolTitle } : {}),
      status: "queued",
      round,
      index,
      startedAt: new Date(this.now()).toISOString(),
    };
    const opened = this.opts.toolDetailEnabled ? openToolDetail({ server, name, args: ev.args }, this.detailBudget) : undefined;
    const entry = this.emitActivity({
      ...this.legacyCallRow(record, server, name, ev.args),
      round,
      call: record,
      ...(opened ? { tool: opened } : {}),
    });
    this.calls.set(ev.callId, {
      entry,
      record,
      server,
      name,
      ...(ev.args !== undefined ? { args: ev.args } : {}),
      ...(opened ? { opened } : {}),
      queuedSeen: false,
      approvalRowSent: false,
      ranAfterApproval: false,
    });
  }

  /** The row's legacy `kind`/`title`/`detail` (SPEC §2.4 table). */
  private legacyCallRow(record: ToolCallRecord, server: string, name: string, argsText: string | undefined): Pick<ActivityRow, "kind" | "title" | "detail"> {
    switch (record.tool) {
      case "web_search":
        return { kind: "search", title: LEGACY_SEARCH_TITLE, detail: line(argString(argsText, "query"), 400) };
      case "web_fetch":
        return { kind: "visit", title: LEGACY_VISIT_TITLE, detail: hostOf(argString(argsText, "url")) };
      case "start_task":
        return { kind: "tool", title: taskActivityTitle("call"), detail: line(taskTitleFromArgs(argsText)) ?? name };
      case "mcp":
        return { kind: "tool", title: `Using ${server || record.connectorLabel || record.title}`, detail: name || undefined };
      default:
        return { kind: "tool", title: `Using ${record.title}`, detail: record.tool };
    }
  }

  /** Fills the legacy detail once the arguments are known (Anthropic sends them after the call). */
  private refreshLegacyDetail(row: CallRow): void {
    const { record, entry } = row;
    const present = record.args ?? {};
    if (record.tool === "web_search" && !entry.detail) {
      const query = typeof present.query === "string" ? present.query : argString(row.args, "query");
      const detail = line(query, 400);
      if (detail) entry.detail = detail;
    } else if (record.tool === "web_fetch" && !entry.detail) {
      const url = typeof present.url === "string" ? present.url : argString(row.args, "url");
      const detail = (typeof present.domain === "string" ? line(present.domain) : undefined) ?? hostOf(url);
      if (detail) entry.detail = detail;
    } else if (record.tool === "start_task") {
      const title = line(taskTitleFromArgs(row.args));
      if (title) entry.detail = title;
    }
  }

  private onToolStatus(ev: Extract<LlmEvent, { type: "tool"; phase: "status" }>): void {
    const row = this.calls.get(ev.callId);
    if (!row || isTerminalToolCallStatus(row.record.status)) return;
    const { record, entry } = row;

    if (ev.status === "queued" && !row.queuedSeen) {
      row.queuedSeen = true;
      if (ev.present) {
        const present = readPresentArgs(ev.present);
        if (present && Object.keys(present).length) record.args = present;
      }
      if (typeof ev.argsText === "string") {
        row.args ??= ev.argsText;
        // The call act had no arguments (Anthropic yields it before they
        // stream): open the detail from the dispatcher's copy instead, charged
        // once, so the running row can show them.
        if (this.opts.toolDetailEnabled && row.opened?.argsNote === "unavailable") {
          row.opened = openToolDetail({ server: row.server, name: row.name, args: ev.argsText }, this.detailBudget);
          entry.tool = row.opened;
        }
      }
      this.refreshLegacyDetail(row);
    }

    if (ev.status === "queued" || ev.status === "running" || ev.status === "awaiting_approval") {
      if (ev.status === "running" && record.status === "awaiting_approval") {
        row.ranAfterApproval = true;
        if (record.approval) {
          record.approval.status = "allowed";
          if (record.approval.decision === null) delete record.approval.decision;
          if (record.approval.decidedAt === null) delete record.approval.decidedAt;
        }
      }
      record.status = ev.status;
    }
    if (typeof ev.timeoutMs === "number" && Number.isFinite(ev.timeoutMs) && ev.timeoutMs >= 0) {
      record.timeoutMs = ev.timeoutMs;
    }
    if (ev.status === "awaiting_approval" && ev.approval) record.approval = approvalProjection(ev.approval);
    this.resend(entry);

    if (ev.status === "awaiting_approval" && ev.approval) {
      // INV-7: a native build learns a call is waiting from this row, once per
      // call. A timeline client reads the record's own status instead.
      if (!this.timeline && !row.approvalRowSent) {
        row.approvalRowSent = true;
        const task = isTaskApproval(ev.approval);
        const taskTitle = task && typeof ev.approval.detail?.title === "string" ? ev.approval.detail.title : undefined;
        this.emitActivity({
          kind: "tool",
          title: task ? LEGACY_TASK_APPROVAL_TITLE : `${ev.approval.connectorLabel} needs approval`,
          detail: line(taskTitle ?? ev.approval.preview),
        });
      }
      this.opts.onApproval(ev.approval);
    }
    this.updateActive();
  }

  private onToolResult(ev: Extract<LlmEvent, { type: "tool"; phase: "result" }>): void {
    const row = this.calls.get(ev.callId);
    // An unpaired result is a bug in an adapter; inventing a row for it would
    // hide that bug behind a plausible-looking entry.
    if (!row || isTerminalToolCallStatus(row.record.status)) return;
    const { record, entry } = row;
    const outcomeStatus = ev.status;
    const status: ToolCallStatus =
      outcomeStatus === "outcome_unknown"
        ? "failed"
        : (outcomeStatus as ToolCallStatus) ?? (ev.ok ? "succeeded" : "failed");
    if (typeof ev.args === "string") row.args ??= ev.args;

    record.status = status;
    record.endedAt = new Date(this.now()).toISOString();
    const code = outcomeStatus === "outcome_unknown" ? "outcome_unknown" : ev.error?.code ?? defaultErrorCode(status);
    if (code && status !== "succeeded") record.error = { code };
    else delete record.error;
    if (typeof ev.durationMs === "number" && Number.isFinite(ev.durationMs) && ev.durationMs >= 0) {
      record.durationMs = ev.durationMs;
    }
    const figure = readToolFigure(ev.figure);
    if (figure) record.figure = figure;
    const web = readToolWebDetail(ev.web);
    if (web) record.web = web;
    if (ev.cached === true) record.cached = true;
    if (record.approval) record.approval.status = finalReceiptStatus(record, row.ranAfterApproval);
    if (record.status === "denied" && record.approval && !record.approval.decision) record.approval.decision = "deny";

    this.refreshLegacyDetail(row);
    if (row.name === START_TASK_TOOL_ID) entry.title = taskActivityTitle("result", status === "succeeded");
    if (record.tool === "web_fetch" && status === "succeeded") {
      const url = web?.finalUrl ?? web?.requestedUrl ?? argString(row.args, "url");
      if (url) {
        entry.url = url;
        const known = this.opts.sources.all().find((source) => source.url === url);
        entry.detail = line(known?.title) ?? hostOf(url) ?? entry.detail;
      }
    }
    if (record.tool === "web_search" && !entry.detail && web?.query) entry.detail = line(web.query, 400);

    if (this.opts.toolDetailEnabled) {
      entry.tool = closeToolDetail(
        row.opened,
        {
          server: row.server,
          name: row.name,
          args: ev.args ?? row.args,
          result: typeof ev.result === "string" ? ev.result : "",
          ok: status === "succeeded",
          durationMs: record.durationMs,
        },
        this.detailBudget
      );
    }
    this.markTaint(record);
    this.resend(entry);
    this.updateActive();
  }

  /** SPEC §6.5: outside content that actually reached the model this turn. */
  private markTaint(record: ToolCallRecord): void {
    const severity = record.web?.injection;
    const mark = (source: TaintSource) => {
      if (severity) this.opts.taint.mark(source, severity);
      else this.opts.taint.mark(source);
    };
    const succeeded = record.status === "succeeded";
    const hits = record.figure?.n ?? record.web?.results?.length ?? 0;
    switch (record.tool) {
      case "web_fetch":
        if (succeeded) mark("web_fetch");
        return;
      case "web_search":
        if (succeeded && hits > 0) mark("web_search");
        return;
      case "search_chats":
        if (succeeded && hits > 0) mark("search_chats");
        return;
      case "read_document":
        if (succeeded) mark("read_document");
        return;
      case "mcp":
        // A connector's error text is its own words too.
        if (succeeded || record.error?.code === "tool_error") mark("connector");
        return;
      default:
        return;
    }
  }

  // ── Provider-run tools ─────────────────────────────────────────────────────

  private openServerCall(ev: Extract<LlmEvent, { type: "server_tool" }>): ServerCallRow {
    const round = Number.isInteger(ev.round) && ev.round >= 0 ? ev.round : this.opts.acc.currentRound;
    const query = line(ev.query, 400);
    const record: ToolCallRecord = {
      v: 1,
      callId: ev.callId,
      tool: ev.tool === "provider_x_search" ? "provider_x_search" : "provider_web_search",
      origin: "provider",
      title: FALLBACK_TOOL_TITLES[ev.tool === "provider_x_search" ? "provider_x_search" : "provider_web_search"],
      status: "running",
      round,
      index: this.nextIndex(round),
      startedAt: new Date(this.now()).toISOString(),
      ...(query ? { args: { query }, web: { query } } : {}),
    };
    const entry = this.emitActivity({
      kind: "search",
      title: LEGACY_SEARCH_TITLE,
      ...(query ? { detail: query } : {}),
      round,
      call: record,
    });
    const row = { entry, record };
    this.serverCalls.set(ev.callId, row);
    return row;
  }

  private onServerToolCall(ev: Extract<LlmEvent, { type: "server_tool" }>): void {
    const existing = this.serverCalls.get(ev.callId);
    if (!existing) {
      this.openServerCall(ev);
      return;
    }
    // The query can arrive after the call opened (Anthropic streams it).
    const query = line(ev.query, 400);
    if (query && !existing.record.web?.query) {
      existing.record.args = { query };
      existing.record.web = { ...(existing.record.web ?? {}), query };
      existing.entry.detail = query;
      this.resend(existing.entry);
    }
  }

  private onServerToolResult(ev: Extract<LlmEvent, { type: "server_tool" }>): void {
    const row = this.serverCalls.get(ev.callId) ?? this.openServerCall(ev);
    if (!isTerminalToolCallStatus(row.record.status)) {
      const ok = ev.ok !== false;
      row.record.status = ok ? "succeeded" : "failed";
      if (!ok) row.record.error = { code: "provider_error" };
      row.record.endedAt = new Date(this.now()).toISOString();
      if (typeof ev.results === "number" && Number.isInteger(ev.results) && ev.results >= 0) {
        row.record.figure = { kind: "results", n: ev.results };
      }
      this.resend(row.entry);
    }
    // A provider search can reach the model without any `sources` event
    // (SPEC §6.5), so the result itself taints the turn.
    this.opts.taint.mark("provider_search");
    this.opts.onProviderSearch();
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  private onSources(ev: Extract<LlmEvent, { type: "sources" }>): void {
    const { acc, sources } = this.opts;
    const before = sources.all().length;
    acc.apply(ev);
    // The accumulator registers into this same registry when the route shares
    // it (SPEC §2.11); registering again is a no-op then, and keeps the turn's
    // list whole when it does not.
    sources.register(ev.sources, { cited: false, ...(ev.origin ? { origin: ev.origin } : {}) });
    const added: ClientSource[] = sources.all().slice(before);

    for (const source of added) {
      if (!takesLegacyVisitRow(source.origin)) continue;
      this.emitActivity({
        kind: "visit",
        title: LEGACY_VISIT_TITLE,
        detail: line(source.title && source.title !== source.url ? source.title : hostOf(source.url), 96),
        url: source.url,
      });
    }
    const all = sources.all();
    if (all.length) this.opts.sender.send({ type: "sources", sources: all.slice(0, 100) as ClientSource[] });

    const kind = ledgerKindFor(ev.origin);
    if (kind && this.opts.ledger) {
      for (const source of added) {
        try {
          this.opts.ledger.add(source.url, kind);
        } catch {
          // A ledger that cannot take a URL only means one fewer page may be
          // opened later: the safe direction to fail in.
        }
      }
    }
    if (isProviderOrigin(ev.origin)) this.opts.taint.mark("provider_search");
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  /** Re-sends a row in place (same id, same seq), with the same gating it was recorded under. */
  private resend(entry: ClientActivityEvent): void {
    if (!this.timeline && isTimelineOnlyActivity(entry)) return;
    this.opts.sender.send({ type: "activity", event: entry });
  }

  private updateActive(): void {
    let active = 0;
    for (const row of this.calls.values()) {
      if (row.record.status === "running" || row.record.status === "awaiting_approval") active += 1;
    }
    // Provider-run searches are the provider's own work: the watchdog that
    // measures provider silence keeps measuring through them, and nothing
    // else would bound one that never answered.
    if (active === this.active) return;
    this.active = active;
    this.opts.onToolActivityChange(active);
  }
}

/**
 * Records one activity row, streaming it only when the client renders it
 * (SPEC §2.4): timeline-only rows persist for every client and stream only to
 * a `timeline` one.
 */
export function sendRunActivity(sender: SseSender, features: ClientFeatureSet, row: ActivityRow): ClientActivityEvent {
  const stream = features.has("timeline") || !isTimelineOnlyActivity(row);
  return sender.sendActivity(row, { stream });
}
