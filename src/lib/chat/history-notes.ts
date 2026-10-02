/**
 * What an earlier tool-using turn tells the model on the next one (SPEC §4.9,
 * DECISIONS T7): a short, capped note of what was called and what came back,
 * inside the untrusted envelope, ahead of the persisted answer. A follow-up
 * such as "what did page 3 say?" then works without fetching again.
 *
 * PREFIX STABILITY (INV-24). Each row's note is a function of that row only:
 * no cross-turn budget, no turn count, no "newest first", no clock and no
 * locale. A new turn therefore never changes an earlier row's bytes, and the
 * provider's cached prompt prefix holds. The history window already bounds the
 * total.
 *
 * Values come only from the persisted row: the typed record's tool, present
 * args, status, figure, `web.results` (at most 3, `Title — URL` only: no `[n]`,
 * which would clash with the new turn's numbering) and `web.finalUrl`; a row
 * from before the rework gives its tool name, argument head and status.
 *
 * Private turns carry no notes: the client-sent `privateHistory` has no
 * activity (`request.ts`), so no row has anything to note.
 */

import { HISTORY_NOTE_ENVELOPE, HISTORY_NOTE_TEXT } from "@/lib/chat/history-notes.prompt";
import { readToolDetail } from "@/lib/chat/tool-detail";
import { humanizeToolName, junoToolIdOf } from "@/lib/chat/run-record";
import { clampChars, singleLine } from "@/lib/chat/source-registry";
import { canonicalToolId } from "@/lib/tools/types";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { ClientActivityEvent, ClientToolDetail } from "@/types/chat";
import type { ToolCallRecord, ToolFigure } from "@/types/run";

export interface HistoryRow {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  /** Decrypted and serialized (serializeActivity). */
  activity: ClientActivityEvent[] | undefined;
}

export const HISTORY_NOTE_MAX_CHARS_PER_TURN = 1_200;
export const HISTORY_NOTE_LABEL = HISTORY_NOTE_ENVELOPE;

/** One note line at most this long, so a single huge call cannot crowd out the rest. */
const MAX_LINE_CHARS = 400;
/** Arguments of a connector call or a legacy row: at most this much of their JSON. */
const MAX_ARGS_CHARS = 160;
const MAX_QUERY_CHARS = 200;
const MAX_TITLE_CHARS = 120;
const MAX_RESULTS_SHOWN = 3;
/** Room kept at the end of a full note for the "more calls" line. */
const MORE_LINE_RESERVE = 32;

/** A bracketed number in outside text reads as a citation of the new turn: it never reaches the note. */
const CITATION_MARK = /\[\s*\d{1,4}\s*\]/g;

function clean(value: string, max: number): string {
  return clampChars(singleLine(value.replace(CITATION_MARK, " ")), max);
}

function quote(value: string, max: number): string {
  const text = clean(value, max);
  return text ? `"${text}"` : "";
}

function presentString(record: ToolCallRecord, key: string): string | undefined {
  const value = record.args?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function compactArgs(raw: string | Record<string, unknown> | undefined): string {
  if (raw === undefined) return "";
  let text: string;
  if (typeof raw === "string") {
    try {
      text = JSON.stringify(JSON.parse(raw));
    } catch {
      text = raw;
    }
  } else {
    text = Object.keys(raw).length ? JSON.stringify(raw) : "";
  }
  const line = singleLine(text);
  return line.length > MAX_ARGS_CHARS ? `${clampChars(line, MAX_ARGS_CHARS - 1)}…` : line;
}

function figureText(figure: ToolFigure | undefined): string | undefined {
  if (!figure) return undefined;
  const n = figure.n;
  switch (figure.kind) {
    case "value":
      return figure.value ? clean(figure.value, MAX_QUERY_CHARS) : undefined;
    case "exit":
      return figure.value !== undefined ? HISTORY_NOTE_TEXT.figure.exit(clean(figure.value, 20)) : undefined;
    default:
      return typeof n === "number" ? HISTORY_NOTE_TEXT.figure[figure.kind](n) : undefined;
  }
}

/** What the call was asked, as the note names it. */
function subject(record: ToolCallRecord): string {
  switch (record.tool) {
    case "web_search":
    case "search_chats":
    case "provider_web_search":
    case "provider_x_search": {
      const query = presentString(record, "query") ?? record.web?.query;
      return query ? quote(query, MAX_QUERY_CHARS) : "";
    }
    case "web_fetch": {
      const requested = record.web?.requestedUrl ?? presentString(record, "url");
      const final = record.web?.finalUrl;
      if (!requested) return final ?? "";
      return final && final !== requested ? `${requested} ${HISTORY_NOTE_TEXT.finalUrl(final)}` : requested;
    }
    case "read_document":
    case "inspect_image": {
      const file = presentString(record, "file");
      const pages = presentString(record, "pages");
      return [file ? clean(file, MAX_TITLE_CHARS) : "", pages ? HISTORY_NOTE_TEXT.pages(clean(pages, 40)) : ""]
        .filter(Boolean)
        .join(" ");
    }
    case "calculate": {
      const expression = presentString(record, "expression");
      return expression ? clean(expression, MAX_QUERY_CHARS) : "";
    }
    case "mcp":
      return compactArgs(record.args);
    default:
      return "";
  }
}

function toolName(record: ToolCallRecord): string {
  switch (record.tool) {
    case "provider_web_search":
      return HISTORY_NOTE_TEXT.providerSearch;
    case "provider_x_search":
      return HISTORY_NOTE_TEXT.providerXSearch;
    case "mcp": {
      const connector = clean(record.connectorLabel ?? HISTORY_NOTE_TEXT.connector, 60);
      const tool = clean(record.toolTitle ?? record.title, 80);
      return `${connector}: ${tool}`;
    }
    default:
      return record.tool;
  }
}

/** What came back. */
function outcome(record: ToolCallRecord): string {
  if (record.status !== "succeeded") return HISTORY_NOTE_TEXT.failed(record.error?.code ?? record.status);
  const searchLike =
    record.tool === "web_search" || record.tool === "provider_web_search" || record.tool === "provider_x_search";
  if (searchLike) {
    const results = record.web?.results ?? [];
    const n = record.figure?.n ?? results.length;
    const shown = results
      .slice(0, MAX_RESULTS_SHOWN)
      .map((result) => `${clean(result.title, MAX_TITLE_CHARS)} — ${result.url}`)
      .join(" ; ");
    return shown ? `${HISTORY_NOTE_TEXT.results(n)}: ${shown}` : HISTORY_NOTE_TEXT.results(n);
  }
  if (record.tool === "web_fetch") {
    const chars = record.web?.chars ?? (record.figure?.kind === "chars" ? record.figure.n : undefined);
    const pages = record.web?.pages ?? (record.figure?.kind === "pages" ? record.figure.n : undefined);
    const parts = [
      typeof pages === "number" ? HISTORY_NOTE_TEXT.figure.pages(pages) : "",
      typeof chars === "number" ? HISTORY_NOTE_TEXT.figure.chars(chars) : "",
    ].filter(Boolean);
    return parts.length ? parts.join(", ") : HISTORY_NOTE_TEXT.ok;
  }
  const figure = figureText(record.figure);
  return figure ? `${HISTORY_NOTE_TEXT.ok}, ${figure}` : HISTORY_NOTE_TEXT.ok;
}

function recordLine(record: ToolCallRecord): string {
  const what = subject(record);
  return `- ${toolName(record)}${what ? ` ${what}` : ""} → ${outcome(record)}`;
}

const MAX_FILES_NAMED = 4;
const EXECUTION_TOOLS = new Set(["run_code", "check_run"]);

function runOutcome(tool: ClientToolDetail): string | null {
  const run = tool.run;
  if (!run) return null;
  if (run.status === "outcome_unknown" || tool.outcome === "outcome_unknown") return "outcome unknown (the run was interrupted; it was not re-run)";
  if (run.status === "cancelled") return "stopped before it finished";
  if (run.status === "timed_out") return "timed out";
  if (run.status === "running" || run.status === "queued") return `still running (run ${run.runId})`;
  const exit = run.exitCode === undefined || run.exitCode === null ? "" : `exit ${run.exitCode}`;
  const files = run.files?.length
    ? `${run.files.length} file${run.files.length === 1 ? "" : "s"}: ${run.files
        .slice(0, MAX_FILES_NAMED)
        .map((file) => singleLine(file.name))
        .join(", ")}${run.files.length > MAX_FILES_NAMED ? ", …" : ""}`
    : "";
  return [exit, files].filter(Boolean).join(", ") || (run.status === "succeeded" ? "ok" : "failed");
}

function outcomeOf(tool: ClientToolDetail): string {
  const run = runOutcome(tool);
  if (run) return run;
  const outcome = tool.outcome ?? (tool.status === "ok" ? "succeeded" : tool.status === "failed" ? "failed" : undefined);
  if (outcome === "succeeded") return tool.cached ? "ok (repeat)" : "ok";
  if (outcome === "outcome_unknown") return "outcome unknown";
  if (outcome === "cancelled") return "cancelled";
  if (outcome) return tool.errorCode ? `${outcome} (${tool.errorCode})` : outcome;
  return "unfinished";
}

function nameOf(tool: ClientToolDetail): string {
  const split = tool.name.indexOf("__");
  if (split > 0) return `${singleLine(tool.server)}: ${tool.name.slice(split + 2)}`;
  return canonicalToolId(tool.name);
}

function argsHead(args: string | undefined): string {
  if (!args) return "";
  let line: string;
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return "";
    line = JSON.stringify(parsed);
  } catch {
    line = singleLine(args);
  }
  return clampChars(singleLine(line), MAX_ARGS_CHARS);
}

function lineFor(tool: ClientToolDetail): string {
  const name = nameOf(tool);
  const canonical = canonicalToolId(tool.name);
  const subject = EXECUTION_TOOLS.has(canonical)
    ? (tool.run?.language ?? "")
    : argsHead(tool.args);
  return limitLine(`- ${name}${subject ? ` ${subject}` : ""} → ${outcomeOf(tool)}`);
}

/** A row persisted before the rework: its tool name, argument head and status (SPEC §4.9). */
function legacyLine(tool: ClientToolDetail): string {
  const name = junoToolIdOf(tool.name) ?? (tool.name.includes("__") ? `${clean(tool.server, 60)}: ${humanizeToolName(tool.name)}` : tool.name);
  const args = tool.args ? compactArgs(tool.args) : "";
  const status =
    tool.status === "ok"
      ? HISTORY_NOTE_TEXT.ok
      : tool.status === "failed"
        ? HISTORY_NOTE_TEXT.failedLegacy
        : HISTORY_NOTE_TEXT.failed("unfinished");
  return `- ${clean(name, 120)}${args ? ` ${args}` : ""} → ${status}`;
}

function limitLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${clampChars(line, MAX_LINE_CHARS - 1)}…` : line;
}

/** The note of one assistant row, or `null` when it used no tool. */
export function historyNoteFor(activity: readonly unknown[] | undefined | null): string | null {
  if (!activity?.length) return null;
  const lines: string[] = [];
  const seen = new Set<string>();
  let hasCallOrDetail = false;
  for (const raw of activity) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as {
      call?: ToolCallRecord;
      kind?: string;
      tool?: ClientToolDetail;
      detail?: unknown;
    };
    if (event.call) {
      hasCallOrDetail = true;
      if (seen.has(event.call.callId)) continue;
      seen.add(event.call.callId);
      lines.push(limitLine(recordLine(event.call)));
    } else if (event.kind === "tool" && event.tool) {
      if (event.detail) {
        hasCallOrDetail = true;
        lines.push(limitLine(legacyLine(event.tool)));
      } else {
        const tool = readToolDetail(event.tool);
        if (tool) lines.push(lineFor(tool));
      }
    }
  }
  if (!lines.length) return null;

  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = (kept.length ? 1 : 0) + lines[i].length;
    const remaining = lines.length - i - 1;
    const budget = HISTORY_NOTE_MAX_CHARS_PER_TURN - (remaining > 0 ? MORE_LINE_RESERVE : 0);
    if (used + cost > budget) break;
    kept.push(lines[i]);
    used += cost;
  }
  if (!kept.length) kept.push(`${clampChars(lines[0], HISTORY_NOTE_MAX_CHARS_PER_TURN - MORE_LINE_RESERVE - 1)}…`);
  const omitted = lines.length - kept.length;
  if (omitted > 0) {
    if (hasCallOrDetail) {
      kept.push(HISTORY_NOTE_TEXT.more(omitted));
    } else {
      kept.push(`- …and ${omitted} more call${omitted === 1 ? "" : "s"}`);
    }
  }
  return kept.join("\n");
}

/** The model-facing content of an assistant row: its note (enveloped) ahead of the answer. */
export function withHistoryNote(content: string, activity: readonly unknown[] | undefined | null): string {
  const note = historyNoteFor(activity);
  if (!note) return content;
  return `${wrapUntrusted(HISTORY_NOTE_LABEL, note)}\n\n${content}`;
}

/** Whether any assistant row in this history will carry a note (so the untrusted-content rule is needed). */
export function historyCarriesToolNotes(rows: ReadonlyArray<{ role: string; activity?: readonly unknown[] | null }>): boolean {
  return rows.some((row) => row.role === "ASSISTANT" && historyNoteFor(row.activity) !== null);
}

/**
 * What the notes in a history window mean for the turn (SPEC §4.9, §6.5):
 * any note puts the untrusted-content rule in the system prompt, and a note
 * that carries web titles or URLs starts the dynamic taint as observed
 * (owner item O-24). Read off the same notes `withHistoryNotes` writes.
 */
export function historyNoteSignals(rows: readonly HistoryRow[]): { notes: boolean; webContent: boolean } {
  let notes = false;
  let webContent = false;
  for (const row of rows) {
    if (row.role !== "ASSISTANT") continue;
    const note = historyNoteFor(row.activity);
    if (!note) continue;
    notes = true;
    // Result titles only ever appear beside their URL ("Title — URL").
    if (/https?:\/\//i.test(note)) webContent = true;
  }
  return { notes, webContent };
}

/** Returns the assistant content to send to the model for each row (same order, same length). */
export function withHistoryNotes(rows: readonly HistoryRow[]): string[] {
  return rows.map((row) => {
    if (row.role !== "ASSISTANT") return row.content;
    const note = historyNoteFor(row.activity);
    if (!note) return row.content;
    // Inside the envelope: its titles and URLs are outside content (INV-30).
    return `${wrapUntrusted(HISTORY_NOTE_ENVELOPE, note)}\n\n${row.content}`;
  });
}
