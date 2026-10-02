/**
 * What an earlier tool-using turn tells the model on the next one
 * (chat-rework SPEC §4.9, T7; TOOL_RUNTIME_DESIGN §6.10).
 *
 * The model's history used to be text and attachments only, so "now plot it by
 * month" could not build on the run that produced the numbers, and "what did
 * the issue tracker say?" fetched again. Each earlier assistant row that used
 * tools now carries a short note — one line per call, what was called and
 * what came back — inside the untrusted envelope, ahead of the persisted
 * answer:
 *
 *   - read_document {"action":"read","file":"report.pdf"} → ok
 *   - GitHub: create_issue {"title":"…"} → failed (not_permitted)
 *   - run_code python → exit 0, 2 files: chart.png, summary.csv
 *
 * PREFIX STABILITY. Each row's note is a function of THAT ROW ONLY: no
 * cross-turn budget, no turn count, no clock, no locale. A new turn never
 * changes an earlier row's bytes, so the provider's cached prompt prefix holds.
 * The history window already bounds the total.
 *
 * INSIDE THE ENVELOPE, because argument heads and connector names are outside
 * content; a history that carries a note therefore needs the untrusted-content
 * rule (`historyCarriesToolNotes`).
 *
 * Values come only from the persisted, already-redacted activity row
 * (`readToolDetail`). Private turns carry no activity, so no notes.
 */

import { readToolDetail } from "@/lib/chat/tool-detail";
import { canonicalToolId } from "@/lib/tools/types";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { ClientToolDetail } from "@/types/chat";

export const HISTORY_NOTE_MAX_CHARS_PER_TURN = 1_200;
export const HISTORY_NOTE_LABEL = "tools used in this earlier turn";

const MAX_LINE_CHARS = 300;
const MAX_ARGS_CHARS = 160;
const MAX_FILES_NAMED = 4;
/** Room kept at the end of a full note for the "more calls" line. */
const MORE_LINE_RESERVE = 40;
const EXECUTION_TOOLS = new Set(["run_code", "check_run"]);

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The redacted, pretty-printed args as one compact line. */
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
  return clip(singleLine(line), MAX_ARGS_CHARS);
}

function nameOf(tool: ClientToolDetail): string {
  // A connector tool is `<connector>__<tool>`: read it as "GitHub: create_issue".
  const split = tool.name.indexOf("__");
  if (split > 0) return `${singleLine(tool.server)}: ${tool.name.slice(split + 2)}`;
  return canonicalToolId(tool.name);
}

function runOutcome(tool: ClientToolDetail): string | null {
  const run = tool.run;
  if (!run) return null;
  if (run.status === "outcome_unknown" || tool.outcome === "outcome_unknown") return "outcome unknown (the run was interrupted; it was not re-run)";
  if (run.status === "cancelled") return "stopped before it finished";
  if (run.status === "timed_out") return "timed out";
  if (run.status === "running" || run.status === "queued") return `still running (run ${run.runId})`;
  const exit = run.exitCode === undefined || run.exitCode === null ? "" : `exit ${run.exitCode}`;
  const files = run.files.length
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

function lineFor(tool: ClientToolDetail): string {
  const name = nameOf(tool);
  const canonical = canonicalToolId(tool.name);
  // An execution call's subject is its language, never a head of its code.
  const subject = EXECUTION_TOOLS.has(canonical)
    ? (tool.run?.language ?? "")
    : argsHead(tool.args);
  return clip(`- ${name}${subject ? ` ${subject}` : ""} → ${outcomeOf(tool)}`, MAX_LINE_CHARS);
}

/** The note of one assistant row's persisted activity, or null when it used no tool. */
export function historyNoteFor(activity: readonly unknown[] | undefined | null): string | null {
  if (!activity?.length) return null;
  const lines: string[] = [];
  for (const raw of activity) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as { kind?: unknown; tool?: unknown };
    if (event.kind !== "tool") continue;
    const tool = readToolDetail(event.tool);
    if (tool) lines.push(lineFor(tool));
  }
  if (!lines.length) return null;

  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = (kept.length ? 1 : 0) + lines[i].length;
    const budget = HISTORY_NOTE_MAX_CHARS_PER_TURN - (i < lines.length - 1 ? MORE_LINE_RESERVE : 0);
    if (used + cost > budget) break;
    kept.push(lines[i]);
    used += cost;
  }
  const omitted = lines.length - kept.length;
  if (omitted > 0) kept.push(`- …and ${omitted} more call${omitted === 1 ? "" : "s"}`);
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
