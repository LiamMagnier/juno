/**
 * A REAL RUN, AS EVERY SURFACE SAYS IT.
 *
 * `run_code`, `check_run`, `use_skill` and `read_skill_file` are the tools whose
 * calls do something a person needs to see the evidence of: a program ran
 * somewhere, it printed, it exited, it made files (TOOL_RUNTIME_DESIGN.md §6.5,
 * §6.12). This module turns one activity row into a `ToolRunView` and says it:
 * the live phase ("Running Python"), the settled receipt ("Ran Python", "2
 * files", "2.4s"), the reason a run did not finish, where it ran, what the
 * live region announces, what the ThinkingMark does, and what Run again seeds.
 *
 * Web Chat, the Thought process panel, web Code, Orbit and voice all read from
 * here, and the Swift twin is `NativeToolRunPresentation` (JunoChatKit). Keep
 * the two in step: one run, one set of words.
 *
 * TOLERANT BY CONSTRUCTION. The wire is produced by the tool-contract and
 * execution lanes, and this module must keep working across their releases:
 *
 *   - the typed record `event.call` (chat-rework SPEC §2.4 `ToolCallRecord`),
 *     with the design's additions `call.run` (the client projection of
 *     `ToolOutcome.run`), `call.progress` and the status `outcome_unknown`;
 *   - the same `run` / `progress` objects on the row itself or on `event.tool`;
 *   - and the legacy row (`kind: "tool"`, `title: "Using X"`, `tool:
 *     ClientToolDetail`) that every message persisted before the rework carries.
 *
 * Nothing here throws, and a field this build does not know costs that one
 * field, never the row. The one thing it never does is invent: no row, no
 * claim. A run with no evidence of having finished is never said to have
 * succeeded, and an unknown outcome is said as unknown.
 *
 * Pure: no React, no DOM, no server imports. NEVER AN EM-DASH in any string.
 */

import { PRODUCT_NAME } from "@/lib/brand/names";
import { formatSpan } from "@/lib/run-receipt";
import type { ClientActivityEvent, ClientToolDetail } from "@/types/chat";

/* ── Vocabulary ─────────────────────────────────────────────────────────── */

/** The tools this module speaks for, by canonical id. */
export const TOOL_RUN_TOOLS = ["run_code", "check_run", "use_skill", "read_skill_file"] as const;
export type ToolRunTool = (typeof TOOL_RUN_TOOLS)[number];

/** Stored skill grants and native builds still say `code_interpreter` (SPEC §3.5). */
const TOOL_ALIASES: Record<string, ToolRunTool> = {
  code_interpreter: "run_code",
  run_code: "run_code",
  check_run: "check_run",
  use_skill: "use_skill",
  read_skill_file: "read_skill_file",
};

/** The canonical id of a tool this module speaks for, or null. */
export function canonicalRunTool(name: string | null | undefined): ToolRunTool | null {
  if (!name) return null;
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return TOOL_ALIASES[bare] ?? null;
}

export type ToolRunLanguage = "python" | "javascript" | "bash";
export type ToolRunContext = "hosted_sandbox" | "agent_computer" | "task_container" | "local_host";

/**
 * Where a run is in its life. One list for chat, Orbit and native.
 *
 * `succeeded` is only ever reached from evidence (a typed `succeeded`, a run
 * record that exited 0, or a legacy `ok`). `outcome_unknown` is the honest
 * state for a run whose end nobody saw: never re-run, never called a success.
 */
export type ToolRunPhase =
  | "queued"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "outcome_unknown"
  | "denied"
  | "expired"
  | "unavailable";

export const TERMINAL_RUN_PHASES: readonly ToolRunPhase[] = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "outcome_unknown",
  "denied",
  "expired",
  "unavailable",
];

export function isTerminalRunPhase(phase: ToolRunPhase): boolean {
  return TERMINAL_RUN_PHASES.includes(phase);
}

/** One file a run produced, as the conversation now holds it. */
export interface ToolRunFile {
  /** The `Attachment` id (`origin: "tool_output"`), when the server sent one. */
  attachmentId: string | null;
  name: string;
  mime: string;
  bytes: number | null;
  /** Where the reader opens it. Absent means "attached, but this row has no link". */
  url: string | null;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
}

/** One output stream, as the server cut it: head and tail with what was left out. */
export interface ToolRunStream {
  head: string;
  tail: string | null;
  /** Bytes between head and tail that the row does not carry. */
  omittedBytes: number;
  /** The stream's full size, when the server measured it. */
  totalBytes: number | null;
}

export interface ToolRunProgress {
  /** Increments with each progress frame; drives the ThinkingMark's event key. */
  seq: number;
  /** The last lines of output so far (the server sends at most 20). */
  lines: string[];
  stdoutBytes: number | null;
  stderrBytes: number | null;
}

export interface ToolRunView {
  /** The activity row's id. */
  id: string;
  callId: string | null;
  tool: ToolRunTool;
  phase: ToolRunPhase;
  language: ToolRunLanguage | null;
  context: ToolRunContext | null;
  /** The agent whose computer ran it (`agent_computer` only). */
  agentName: string | null;
  runId: string | null;
  exitCode: number | null;
  /** Measured run time; absent, never zero, when nothing measured it. */
  durationMs: number | null;
  timeoutMs: number | null;
  startedAt: string | null;
  files: ToolRunFile[];
  /** Files a cancelled run made and the conversation did not keep. */
  filesDiscarded: number;
  stdout: ToolRunStream | null;
  stderr: ToolRunStream | null;
  progress: ToolRunProgress | null;
  /** The program (redacted, possibly cut), for the collapsed code block. */
  code: string | null;
  codeTruncated: boolean;
  /** The model's one-line reason for the run, when it gave one. */
  reason: string | null;
  skill: { name: string; slug: string | null } | null;
  /** A skill file path (`read_skill_file`). */
  skillPath: string | null;
  /** The run this `check_run` looked at. */
  checkedRunId: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  /** "Show full output" target, readable by the conversation's owner only. */
  logUrl: string | null;
  /** The run finished after the reply was interrupted and was collected later. */
  finishedLater: boolean;
  /** Where the evidence came from; the legacy row is the least specific. */
  source: "typed" | "legacy";
  /** The redacted call detail, when the row carried one. */
  detail: ClientToolDetail | null;
}

/* ── Reading the wire ───────────────────────────────────────────────────── */

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown, max = 4_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function raw(value: unknown, max = 64_000): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function oneLine(value: string | null, max = 300): string | null {
  if (!value) return null;
  const line = value.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, max) : null;
}

const LANGUAGES: Record<string, ToolRunLanguage> = {
  python: "python",
  python3: "python",
  py: "python",
  javascript: "javascript",
  js: "javascript",
  node: "javascript",
  nodejs: "javascript",
  bash: "bash",
  sh: "bash",
  shell: "bash",
};

function language(value: unknown): ToolRunLanguage | null {
  return typeof value === "string" ? (LANGUAGES[value.trim().toLowerCase()] ?? null) : null;
}

const CONTEXTS: readonly ToolRunContext[] = ["hosted_sandbox", "agent_computer", "task_container", "local_host"];

function context(value: unknown): ToolRunContext | null {
  return typeof value === "string" && (CONTEXTS as readonly string[]).includes(value)
    ? (value as ToolRunContext)
    : null;
}

function stream(value: unknown): ToolRunStream | null {
  if (typeof value === "string") {
    return value.length ? { head: value.slice(0, 64_000), tail: null, omittedBytes: 0, totalBytes: null } : null;
  }
  const r = rec(value);
  if (!r) return null;
  const head = raw(r.head) ?? raw(r.text) ?? "";
  const tail = raw(r.tail);
  if (!head && !tail) return null;
  return {
    head,
    tail,
    omittedBytes: count(r.omittedBytes) ?? 0,
    totalBytes: count(r.totalBytes) ?? count(r.bytes),
  };
}

const MAX_FILES = 50;

function files(value: unknown): ToolRunFile[] {
  if (!Array.isArray(value)) return [];
  const out: ToolRunFile[] = [];
  for (const entry of value) {
    const r = rec(entry);
    if (!r) continue;
    const name = str(r.name, 255) ?? str(r.fileName, 255);
    if (!name) continue;
    const mime = str(r.mime, 160) ?? str(r.mimeType, 160) ?? "application/octet-stream";
    const attachmentId = str(r.attachmentId, 200) ?? str(r.id, 200);
    const kind: ToolRunFile["kind"] = mime.toLowerCase().startsWith("image/") ? "image" : "file";
    const given = str(r.url, 2_000);
    // Only same-origin paths are links. A run's manifest is server-written,
    // but a link that leaves the app from a file card is never the right
    // default, and an `/api/...` path is the only shape the server sends.
    const safeUrl = given && given.startsWith("/") && !given.startsWith("//") ? given : null;
    const url = safeUrl ?? (kind === "image" && attachmentId ? `/api/attachments/${encodeURIComponent(attachmentId)}` : null);
    out.push({
      attachmentId,
      name,
      mime,
      bytes: count(r.bytes) ?? count(r.size),
      url,
      kind,
      width: count(r.width),
      height: count(r.height),
    });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function progress(value: unknown): ToolRunProgress | null {
  const r = rec(value);
  if (!r) return null;
  // Lines arrive as strings, or as `{ stream, text }` (the tool contract's
  // `ToolProgress`); stderr lines keep their stream so the reader can tell.
  const lines = Array.isArray(r.lines)
    ? r.lines
        .flatMap((line): string[] => {
          if (typeof line === "string") return [line];
          const entry = rec(line);
          return typeof entry?.text === "string" ? [entry.text] : [];
        })
        .slice(-20)
        .map((line) => line.slice(0, 400))
    : typeof r.text === "string"
      ? r.text.split("\n").slice(-20).map((line) => line.slice(0, 400))
      : [];
  return {
    seq: int(r.seq) ?? 0,
    lines,
    stdoutBytes: count(r.stdoutBytes),
    stderrBytes: count(r.stderrBytes),
  };
}

/** `ToolCallStatus` + the design's additions, onto the one phase list. */
function phaseFromStatus(status: string | null, errorCode: string | null): ToolRunPhase | null {
  switch (status) {
    case "queued":
      return "queued";
    case "awaiting_approval":
      return "awaiting_approval";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      if (errorCode === "timeout") return "timed_out";
      if (errorCode === "cancelled") return "cancelled";
      if (errorCode === "unavailable" || errorCode === "not_permitted" || errorCode === "blocked") return "unavailable";
      return "failed";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    case "outcome_unknown":
      return "outcome_unknown";
    case "denied":
      return "denied";
    case "expired":
      return "expired";
    case "refused":
    case "unavailable":
      return "unavailable";
    default:
      return null;
  }
}

/** Parse the redacted argument JSON of a legacy row, when it is whole. */
function legacyArgs(detail: ClientToolDetail | null): Rec | null {
  if (!detail?.args || detail.argsTruncated) return null;
  try {
    return rec(JSON.parse(detail.args));
  } catch {
    return null;
  }
}

/**
 * The run behind one activity row, or null when the row is not a run.
 *
 * The typed record wins over the legacy detail for every field it carries;
 * the legacy detail fills what the record left out (the program text on a
 * pre-rework row, for one).
 */
export function readToolRun(event: ClientActivityEvent, opts: { live?: boolean } = {}): ToolRunView | null {
  const ev = event as unknown as Rec;
  const call = rec(ev.call);
  const detail = event.tool ?? null;
  const detailRec = detail as unknown as Rec | null;

  const tool =
    canonicalRunTool(str(call?.tool)) ??
    canonicalRunTool(detail?.name) ??
    (event.kind === "tool" ? canonicalRunTool(event.detail) : null);
  if (!tool) return null;

  const run = rec(call?.run) ?? rec(ev.run) ?? rec(detailRec?.run);
  const prog = progress(call?.progress ?? run?.progress ?? ev.progress ?? detailRec?.progress);
  const error = rec(call?.error);
  const errorCode = str(error?.code, 80) ?? str(detailRec?.errorCode, 80) ?? str(run?.errorCode, 80);
  const args = rec(call?.args);
  const legacy = legacyArgs(detail);

  // The run record's own status is the most specific witness (a host that
  // said `timed_out`), then the typed record's, then the tool contract's
  // fields on the detail (`outcome`, then the live `phase`), then the legacy
  // detail. `outcome_unknown` also travels as a failure with that error code,
  // because shipped native builds read an unknown status as running.
  let phase =
    (errorCode === "outcome_unknown" ? ("outcome_unknown" as const) : null) ??
    phaseFromStatus(str(run?.status, 40), errorCode) ??
    phaseFromStatus(str(call?.status, 40), errorCode) ??
    phaseFromStatus(str(detailRec?.outcome, 40), errorCode) ??
    phaseFromStatus(str(detailRec?.phase, 40), errorCode);
  const typed = phase !== null || !!run;
  if (phase === null) {
    if (detail?.status === "ok") phase = "succeeded";
    else if (detail?.status === "failed") phase = "failed";
    else if (detail?.resultNote === "pending") phase = "running";
    // A stored row whose call never returned: the reply ended before the run
    // reported back. Nobody saw the end, so the end is unknown.
    else if (detail?.resultNote === "unfinished") phase = "outcome_unknown";
    // No evidence either way: a name-only row (tool detail off) is never
    // updated when its call returns. Live, it is the call in flight; stored,
    // its end is simply not known.
    else phase = opts.live === false ? "outcome_unknown" : "running";
  }
  // A stored row that never reached an end: the stream is over, so the run is
  // not "still running", and whether it finished on the host is not known
  // here. Only when the caller says the turn is over (`live: false`).
  // An approval nobody answered never let the run start: that is an expiry.
  if (opts.live === false && !isTerminalRunPhase(phase)) {
    phase = phase === "awaiting_approval" ? "expired" : "outcome_unknown";
  }

  const exitCode = int(run?.exitCode);
  // An exit code is evidence. A record that says `succeeded` with a non-zero
  // exit is believed as failed: the program said so, and a receipt that reads
  // "Ran Python" over a traceback is the lie this module exists to prevent.
  if (phase === "succeeded" && exitCode !== null && exitCode !== 0) phase = "failed";

  const skillRec = rec(run?.skill) ?? rec(call?.skill);
  const skillName =
    str(skillRec?.name, 120) ?? str(skillRec?.slug, 120) ?? str(args?.skill, 120) ?? str(args?.name, 120) ?? str(legacy?.skill, 120) ?? str(legacy?.name, 120);
  const skillSlug = str(skillRec?.slug, 120);

  return {
    id: event.id,
    callId: str(call?.callId, 200) ?? str(detailRec?.callId, 200),
    tool,
    phase,
    language:
      language(run?.language) ??
      language(args?.language) ??
      language(legacy?.language) ??
      // The old tool had one language. A pre-rework `code_interpreter` row ran
      // Python or nothing.
      (detail?.name === "code_interpreter" || str(call?.tool) === "code_interpreter" ? "python" : null) ??
      (tool === "run_code" && (str(legacy?.code) || str(args?.code)) ? "python" : null),
    context: context(run?.context) ?? context(call?.context),
    agentName: str(run?.agentName, 120),
    runId: str(run?.runId, 200) ?? str(run?.id, 200),
    exitCode,
    durationMs: count(run?.durationMs) ?? count(call?.durationMs) ?? (detail ? (count(detail.durationMs) ?? null) : null),
    timeoutMs: count(call?.timeoutMs) ?? count(detailRec?.timeoutMs) ?? count(run?.timeoutMs),
    startedAt: str(call?.startedAt, 40) ?? str(run?.startedAt, 40) ?? event.createdAt ?? null,
    files: files(run?.files),
    filesDiscarded: count(run?.filesDiscarded) ?? 0,
    stdout: stream(run?.stdout ?? run?.stdoutTail),
    stderr: stream(run?.stderr ?? run?.stderrTail),
    progress: prog,
    code: raw(run?.code) ?? raw(legacy?.code) ?? raw(legacy?.command),
    codeTruncated: run?.codeTruncated === true || (!run?.code && !!detail?.argsTruncated),
    reason: oneLine(str(args?.reason, 300) ?? str(legacy?.reason, 300)),
    skill: skillName ? { name: skillName, slug: skillSlug } : null,
    skillPath: str(args?.path, 400) ?? str(legacy?.path, 400),
    checkedRunId: str(args?.run_id, 200) ?? str(legacy?.run_id, 200),
    errorCode,
    errorDetail: oneLine(str(error?.detail, 300) ?? str(run?.errorDetail, 300)),
    logUrl: (() => {
      const url = str(run?.logUrl, 2_000);
      return url && url.startsWith("/") && !url.startsWith("//") ? url : null;
    })(),
    finishedLater: run?.finishedLater === true,
    source: typed ? "typed" : "legacy",
    detail,
  };
}

/** Every run in a turn's activity, in emission order. */
export function readToolRuns(
  events: readonly ClientActivityEvent[] | null | undefined,
  opts: { live?: boolean } = {},
): ToolRunView[] {
  const out: ToolRunView[] = [];
  for (const event of events ?? []) {
    const view = readToolRun(event, opts);
    if (view) out.push(view);
  }
  return out;
}

/* ── Words ──────────────────────────────────────────────────────────────── */

/** What the program is, as a noun phrase: running, settled and failed forms. */
export const RUN_LANGUAGE_LABEL = {
  python: { running: "Running Python", queued: "Starting Python", done: "Ran Python", failed: "Python failed", noun: "Python", cannot: "Couldn't run Python" },
  javascript: { running: "Running JavaScript", queued: "Starting JavaScript", done: "Ran JavaScript", failed: "JavaScript failed", noun: "JavaScript", cannot: "Couldn't run JavaScript" },
  bash: { running: "Running a shell script", queued: "Starting a shell script", done: "Ran a shell script", failed: "Shell script failed", noun: "Shell script", cannot: "Couldn't run the shell script" },
  unknown: { running: "Running code", queued: "Starting the run", done: "Ran code", failed: "Code failed", noun: "Code", cannot: "Couldn't run the code" },
} as const;

/** The phase words that do not depend on the language. */
export const RUN_PHASE_LABEL = {
  waiting: "Waiting for your answer",
  stopped: "Stopped",
  unknown: "Outcome unknown",
  declined: "You declined this run",
  expired: "Approval expired",
  checking: "Checking on a run",
  checked: "Checked on a run",
} as const;

/** Where it ran, as the run detail's context line (§6.1). */
export const RUN_CONTEXT_LABEL = {
  hosted_sandbox: `Ran in ${PRODUCT_NAME}'s sandbox: no internet, no access to your Mac`,
  hosted_sandbox_live: `Running in ${PRODUCT_NAME}'s sandbox: no internet, no access to your Mac`,
  agent_computer: "Ran on the agent's computer",
  task_container: "Ran in the task's container",
  local_host: "Ran on your Mac",
} as const;

/** Why a run did not finish, one sentence each. */
export const RUN_REASON_LABEL = {
  restarted: `The server restarted while this ran, so ${PRODUCT_NAME} can't tell whether it finished. It was not run again.`,
  replyEnded: `The reply ended before this run reported back, so ${PRODUCT_NAME} can't tell whether it finished. It was not run again.`,
  stopped: "You stopped this run before it finished.",
  stoppedDiscarded: "You stopped this run. Files it made were not kept.",
  timedOut: "It was stopped at its time limit.",
  unavailable: "The sandbox isn't available right now, so nothing ran.",
  blocked: "Blocked by your settings, so nothing ran.",
  notPermitted: "Running code isn't available for this chat, so nothing ran.",
  invalidArgs: "The model sent a request this tool can't use, so nothing ran.",
  declined: "You declined this run, so nothing ran.",
  expired: "Nobody answered in time, so nothing ran.",
  finishedLater: "It finished after the reply was interrupted.",
} as const;

function langKey(view: Pick<ToolRunView, "language">): keyof typeof RUN_LANGUAGE_LABEL {
  return view.language ?? "unknown";
}

/** "2 files", "1 file", or null for none. */
export function runFilesFigure(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 file" : `${n} files`;
}

/** A time limit as people say it: "90s", "2 min", "10 min". */
export function formatRunLimit(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes} min` : `${minutes.toFixed(1)} min`;
}

/** Byte counts as the run detail prints them. */
export function formatRunBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function skillLabel(view: ToolRunView, running: boolean): string {
  const name = view.skill?.name;
  if (view.tool === "read_skill_file") {
    const path = view.skillPath;
    if (path && name) return running ? `Reading ${path} from the ${name} skill` : `Read ${path} from the ${name} skill`;
    if (path) return running ? `Reading ${path}` : `Read ${path}`;
    return running ? "Reading a skill file" : "Read a skill file";
  }
  if (name) return running ? `Reading the ${name} skill` : `Read the ${name} skill`;
  return running ? "Reading a skill" : "Read a skill";
}

/** The receipt status the shared row wears for a phase. */
export type RunReceiptStatus = "running" | "ok" | "failed" | "denied" | "waiting" | "stopped" | "unknown";

/** One receipt row's worth of words, for `ToolReceiptRow`. */
export interface RunReceiptParts {
  label: string;
  /** Second clause on the line ("Python"), or null. */
  object: string | null;
  status: RunReceiptStatus;
  /** "2 files", "exit 1". Only what the run measured. */
  figure: string | null;
  durationMs: number | null;
  /** One sentence under the row for anything that did not simply finish. */
  reason: string | null;
}

function failureReason(view: ToolRunView): string | null {
  if (view.errorDetail) return view.errorDetail;
  const stderrLine = (view.stderr?.tail ?? view.stderr?.head ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (stderrLine) return stderrLine.slice(0, 200);
  switch (view.errorCode) {
    case "invalid_args":
      return RUN_REASON_LABEL.invalidArgs;
    case "unavailable":
      return RUN_REASON_LABEL.unavailable;
    case "blocked":
      return RUN_REASON_LABEL.blocked;
    case "not_permitted":
      return RUN_REASON_LABEL.notPermitted;
    default:
      break;
  }
  if (view.exitCode !== null && view.exitCode !== 0) return `It exited with code ${view.exitCode}.`;
  if (view.detail?.result) {
    const first = view.detail.result.trim().split("\n").find((line) => line.trim());
    if (first) return first.slice(0, 200);
  }
  return null;
}

/** How the run is said on a receipt row, for its current phase. */
export function runReceiptParts(view: ToolRunView): RunReceiptParts {
  const lang = RUN_LANGUAGE_LABEL[langKey(view)];
  const skillTool = view.tool === "use_skill" || view.tool === "read_skill_file";
  const base: RunReceiptParts = {
    label: "",
    object: null,
    status: "running",
    figure: null,
    durationMs: view.durationMs,
    reason: null,
  };

  switch (view.phase) {
    case "queued":
      return {
        ...base,
        label: skillTool ? skillLabel(view, true) : view.tool === "check_run" ? RUN_PHASE_LABEL.checking : lang.queued,
        durationMs: null,
      };
    case "running":
      return {
        ...base,
        label: skillTool ? skillLabel(view, true) : view.tool === "check_run" ? RUN_PHASE_LABEL.checking : lang.running,
        durationMs: null,
      };
    case "awaiting_approval":
      return {
        ...base,
        label: RUN_PHASE_LABEL.waiting,
        object: skillTool ? skillLabel(view, true) : lang.noun,
        status: "waiting",
        durationMs: null,
      };
    case "succeeded": {
      if (skillTool) return { ...base, label: skillLabel(view, false), status: "ok" };
      const label = view.tool === "check_run" && view.language === null ? RUN_PHASE_LABEL.checked : lang.done;
      return {
        ...base,
        label,
        status: "ok",
        figure: runFilesFigure(view.files.length),
        reason: view.finishedLater ? RUN_REASON_LABEL.finishedLater : null,
      };
    }
    case "failed": {
      if (skillTool) {
        return {
          ...base,
          label: view.skill?.name ? `Couldn't read the ${view.skill.name} skill` : "Couldn't read the skill",
          status: "failed",
          reason: failureReason(view),
        };
      }
      const exited = view.exitCode !== null && view.exitCode !== 0;
      return {
        ...base,
        label: exited ? lang.failed : view.errorCode === "invalid_args" ? lang.cannot : lang.failed,
        status: "failed",
        figure: exited ? `exit ${view.exitCode}` : null,
        reason: failureReason(view),
      };
    }
    case "timed_out": {
      const limit = view.timeoutMs ?? view.durationMs;
      return {
        ...base,
        label: limit ? `Timed out after ${formatRunLimit(limit)}` : "Timed out",
        object: skillTool ? null : lang.noun,
        status: "failed",
        // The limit is in the label; a duration beside it would say it twice.
        durationMs: limit ? null : view.durationMs,
        reason: RUN_REASON_LABEL.timedOut,
      };
    }
    case "cancelled":
      return {
        ...base,
        label: RUN_PHASE_LABEL.stopped,
        object: skillTool ? null : lang.noun,
        status: "stopped",
        reason: view.filesDiscarded > 0 ? RUN_REASON_LABEL.stoppedDiscarded : RUN_REASON_LABEL.stopped,
      };
    case "outcome_unknown":
      return {
        ...base,
        label: RUN_PHASE_LABEL.unknown,
        object: skillTool ? null : lang.noun,
        status: "unknown",
        durationMs: null,
        reason: view.source === "typed" ? RUN_REASON_LABEL.restarted : RUN_REASON_LABEL.replyEnded,
      };
    case "denied":
      return { ...base, label: RUN_PHASE_LABEL.declined, status: "denied", durationMs: null };
    case "expired":
      return { ...base, label: RUN_PHASE_LABEL.expired, status: "failed", durationMs: null, reason: RUN_REASON_LABEL.expired };
    case "unavailable":
      return {
        ...base,
        label: skillTool ? "Couldn't use the skill" : lang.cannot,
        status: "failed",
        durationMs: null,
        reason: failureReason(view) ?? RUN_REASON_LABEL.unavailable,
      };
  }
}

/**
 * The whole run in one line: what the strip says at rest, what Orbit's feed
 * says, what the live region announces. "Ran Python · 2.4s · 2 files",
 * "Python failed · exit 1", "Stopped", "Timed out after 2 min",
 * "Outcome unknown, the server restarted while this ran".
 */
export function runSummaryLine(view: ToolRunView): string {
  const parts = runReceiptParts(view);
  switch (view.phase) {
    case "succeeded":
      return [parts.label, parts.durationMs !== null ? formatSpan(parts.durationMs) : null, parts.figure]
        .filter(Boolean)
        .join(" · ");
    case "failed":
      return [parts.label, parts.figure].filter(Boolean).join(" · ");
    case "outcome_unknown":
      return view.source === "typed"
        ? `${RUN_PHASE_LABEL.unknown}, the server restarted while this ran`
        : `${RUN_PHASE_LABEL.unknown}, the reply ended before this run reported back`;
    case "awaiting_approval":
      return RUN_PHASE_LABEL.waiting;
    default:
      return parts.label;
  }
}

/** The run detail's context line, or null when the producer did not say. */
export function runContextLine(view: Pick<ToolRunView, "context" | "phase" | "agentName">): string | null {
  switch (view.context) {
    case "hosted_sandbox":
      return isTerminalRunPhase(view.phase) ? RUN_CONTEXT_LABEL.hosted_sandbox : RUN_CONTEXT_LABEL.hosted_sandbox_live;
    case "agent_computer":
      return view.agentName ? `Ran on ${view.agentName}'s computer` : RUN_CONTEXT_LABEL.agent_computer;
    case "task_container":
      return RUN_CONTEXT_LABEL.task_container;
    case "local_host":
      return RUN_CONTEXT_LABEL.local_host;
    default:
      return null;
  }
}

/** What the exit line in the run detail says: "Exit code 0 · 2.4s". */
export function runExitLine(view: ToolRunView): string | null {
  const parts = [
    view.exitCode !== null ? `Exit code ${view.exitCode}` : null,
    view.durationMs !== null ? formatSpan(view.durationMs) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The note under a cut stream: "12.4 KB not shown". */
export function runOmittedNote(stream: ToolRunStream): string | null {
  return stream.omittedBytes > 0 ? `${formatRunBytes(stream.omittedBytes)} not shown` : null;
}

/** "3.2 KB of output so far", while a run streams. */
export function runProgressNote(progress: ToolRunProgress | null): string | null {
  if (!progress) return null;
  const total = (progress.stdoutBytes ?? 0) + (progress.stderrBytes ?? 0);
  if (total <= 0) return null;
  return `${formatRunBytes(total)} of output so far`;
}

/**
 * Whether a settled run may offer "Run again".
 *
 * Run again is always a NEW call the person sends, never a replay: an unknown
 * outcome is not retried behind anyone's back (§6.6). A success has nothing to
 * retry, and a refusal is not fixed by asking twice.
 */
export function runCanRunAgain(view: ToolRunView): boolean {
  if (view.tool !== "run_code") return false;
  return view.phase === "failed" || view.phase === "timed_out" || view.phase === "cancelled" || view.phase === "outcome_unknown";
}

/** The composer draft Run again seeds. The person reads it and presses send. */
export function runAgainDraft(view: ToolRunView): string {
  const noun = view.language === "bash" ? "shell script" : view.language === "javascript" ? "JavaScript" : view.language === "python" ? "Python" : "code";
  if (view.phase === "outcome_unknown") {
    return `The last ${noun} run's outcome is unknown. Run it again as a new run and tell me what it returns.`;
  }
  if (view.phase === "timed_out") {
    return `The last ${noun} run timed out. Try again with a faster approach and tell me what it returns.`;
  }
  return `Run the ${noun} again and tell me what it returns.`;
}

/* ── Live behaviour ─────────────────────────────────────────────────────── */

/**
 * The phase the ThinkingMark (MOTION_AND_THINKING.md) wears beside a run row.
 *
 * `working` for real work, `waiting` (still) while a person is asked,
 * `finished` (one settle) for a verified success, `error` (still) for every
 * end that was not one. A stop is `idle`: nothing to celebrate, nothing wrong.
 */
export type RunMarkPhase = "working" | "waiting" | "finished" | "error" | "idle";

export function runMarkPhase(phase: ToolRunPhase): RunMarkPhase {
  switch (phase) {
    case "queued":
    case "running":
      return "working";
    case "awaiting_approval":
      return "waiting";
    case "succeeded":
      return "finished";
    case "cancelled":
      return "idle";
    default:
      return "error";
  }
}

/**
 * Which run, if any, is THE active row: the mark sits on one row only.
 *
 * The latest run that has not ended, so a parallel batch shows one live mark
 * rather than several competing ones. Null when every run has ended, or when
 * the turn is no longer streaming (a stored row is over by definition).
 */
export function activeRunId(views: readonly ToolRunView[], streaming: boolean): string | null {
  if (!streaming) return null;
  for (let i = views.length - 1; i >= 0; i--) {
    if (!isTerminalRunPhase(views[i].phase)) return views[i].id;
  }
  return null;
}

/**
 * The mark's event key: changes when a real batch of activity arrives (a new
 * phase, a new progress frame), so the mark may ask for a pass. The mark
 * itself coalesces passes to one per 1.6 s.
 */
export function runMarkEventKey(view: ToolRunView): string {
  return `${view.phase}:${view.progress?.seq ?? 0}`;
}

/**
 * The sentence the live region announces for a run's phase, once.
 * Phase changes only: never a progress line, never a clock tick.
 */
export function runAnnouncement(view: ToolRunView): string {
  const parts = runReceiptParts(view);
  switch (view.phase) {
    case "succeeded":
      return `${parts.label}${parts.figure ? `, ${parts.figure}` : ""}.`;
    case "failed":
      return view.exitCode !== null && view.exitCode !== 0 ? `${parts.label}, exit code ${view.exitCode}.` : `${parts.label}.`;
    case "timed_out":
    case "cancelled":
      return `${parts.object ? `${parts.object}: ` : ""}${parts.label}.`;
    case "outcome_unknown":
      return `${runSummaryLine(view)}.`;
    case "awaiting_approval":
      return `${RUN_PHASE_LABEL.waiting}.`;
    default:
      return `${parts.label}.`;
  }
}

/**
 * The announcements a new snapshot of runs owes the live region.
 *
 * `seen` maps a row id to the last phase announced for it; the caller keeps it
 * between renders. A phase is announced once, a stored conversation announces
 * nothing (`initial` seeds `seen` silently; with `live`, a run still working
 * at that first look is announced), and a progress frame never counts.
 */
export function pendingRunAnnouncements(
  views: readonly ToolRunView[],
  seen: Map<string, ToolRunPhase>,
  opts: { initial?: boolean; live?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const view of views) {
    const last = seen.get(view.id);
    if (last === view.phase) continue;
    seen.set(view.id, view.phase);
    // The first look: what already ended is history, never announced. A run
    // still working when a live turn mounts (a reconnect) is announced once.
    if (opts.initial && (!opts.live || isTerminalRunPhase(view.phase))) continue;
    // Queued is a moment, not a phase worth a sentence: the next one says it.
    if (view.phase === "queued") continue;
    out.push(runAnnouncement(view));
  }
  return out;
}

/* ── Sanitising a stored record ─────────────────────────────────────────── */

/**
 * The persistable client projection of a run (`call.run`), rebuilt from
 * stored JSON with every field bounded, for `serializeActivity`.
 *
 * Exported for the serializer so a reloaded conversation keeps its files and
 * exit codes; returns undefined for anything that is not a run record.
 */
export function sanitizeToolRunRecord(value: unknown): Rec | undefined {
  const r = rec(value);
  if (!r) return undefined;
  const out: Rec = {};
  const runId = str(r.runId, 200);
  if (runId) out.runId = runId;
  const status = str(r.status, 40);
  if (status && phaseFromStatus(status, null)) out.status = status;
  const ctx = context(r.context);
  if (ctx) out.context = ctx;
  const lang = language(r.language);
  if (lang) out.language = lang;
  const exit = int(r.exitCode);
  if (exit !== null) out.exitCode = exit;
  for (const key of ["durationMs", "timeoutMs", "stdoutBytes", "stderrBytes", "filesDiscarded"] as const) {
    const n = count(r[key]);
    if (n !== null) out[key] = n;
  }
  for (const key of ["stdout", "stderr"] as const) {
    const s = stream(r[key]);
    if (s) out[key] = { head: s.head.slice(0, 8_192), ...(s.tail ? { tail: s.tail.slice(0, 8_192) } : {}), omittedBytes: s.omittedBytes, ...(s.totalBytes !== null ? { totalBytes: s.totalBytes } : {}) };
  }
  const list = files(r.files);
  if (list.length) {
    out.files = list.map((f) => ({
      ...(f.attachmentId ? { attachmentId: f.attachmentId } : {}),
      name: f.name,
      mime: f.mime,
      ...(f.bytes !== null ? { bytes: f.bytes } : {}),
      ...(f.url ? { url: f.url } : {}),
      ...(f.width !== null ? { width: f.width } : {}),
      ...(f.height !== null ? { height: f.height } : {}),
    }));
  }
  const skill = rec(r.skill);
  const skillName = str(skill?.name, 120);
  if (skillName) out.skill = { name: skillName, ...(str(skill?.slug, 120) ? { slug: str(skill?.slug, 120) } : {}) };
  const agentName = str(r.agentName, 120);
  if (agentName) out.agentName = agentName;
  const logUrl = str(r.logUrl, 2_000);
  if (logUrl && logUrl.startsWith("/") && !logUrl.startsWith("//")) out.logUrl = logUrl;
  if (r.finishedLater === true) out.finishedLater = true;
  const code = raw(r.code, 16_000);
  if (code) out.code = code;
  if (r.codeTruncated === true || (typeof r.code === "string" && r.code.length > 16_000)) out.codeTruncated = true;
  return Object.keys(out).length ? out : undefined;
}
