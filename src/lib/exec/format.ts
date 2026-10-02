/**
 * What the model reads back from a run. Pure functions, unit tested.
 *
 * The rules (design §6.5, parity with native CommandOutputSpill):
 *  - each stream is shown whole when short, else head 8 KB + tail 8 KB with
 *    the number of omitted bytes and how to page through the rest, so a
 *    traceback at the end of five megabytes of output is never lost;
 *  - the exit status, duration and context are always stated, so the model
 *    cannot mistake a failed run for a successful one;
 *  - a missing module gets one line naming what is installed, because the
 *    sandbox has no internet and the model must choose another approach;
 *  - produced files are listed with "attached to this conversation".
 */
import type { ExecLanguage, ExecOutputFile, ExecSurface, ToolRunStatus } from "@/lib/exec/types";
import { wrapUntrusted } from "@/lib/untrusted-content";

export interface StreamSlice {
  head: string;
  tail: string;
  /** Bytes the program wrote to this stream. */
  bytes: number;
  /** Bytes the host kept (≤ 16 MB). */
  storedBytes?: number;
}

export function languageLabel(language: ExecLanguage): string {
  return language === "python" ? "Python" : language === "javascript" ? "JavaScript (Node)" : "a shell script";
}

export const SANDBOX_CONTEXT_LINE =
  "It ran in Alevr's sandbox: no internet access and no access to the user's computer.";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "unknown time";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/**
 * One stream as the model sees it. `pageHint` names the call that pages the
 * rest (check_run with the run id and an offset).
 */
export function formatStream(
  name: "stdout" | "stderr",
  slice: StreamSlice,
  pageHint: (offset: number) => string,
  wrap: (text: string) => string = (text) => text,
): string {
  if (slice.bytes === 0) return "";
  if (!slice.tail) {
    const kept = slice.head.replace(/\s+$/, "");
    const cut = slice.bytes > byteLength(slice.head) ? `\n[${formatBytes(slice.bytes - byteLength(slice.head))} more were not kept.]` : "";
    return `${name}:\n${wrap(kept)}${cut}`;
  }
  const headBytes = byteLength(slice.head);
  const tailBytes = byteLength(slice.tail);
  const stored = slice.storedBytes ?? slice.bytes;
  const omitted = Math.max(0, stored - headBytes - tailBytes);
  const lost = Math.max(0, slice.bytes - stored);
  const lines = [
    `${name} (${formatBytes(slice.bytes)} in total; the start and the end are shown):`,
    wrap(slice.head.replace(/\s+$/, "")),
    `[… ${formatBytes(omitted)} omitted here. The full ${name} is stored; ${pageHint(headBytes)} …]`,
    wrap(slice.tail.replace(/\s+$/, "")),
  ];
  if (lost > 0) lines.push(`[The program wrote ${formatBytes(lost)} more than the 16 MB that is kept; that part is gone.]`);
  return lines.join("\n");
}

/** The module a ModuleNotFoundError / Node resolution error names, if any. */
export function missingModule(stderr: string): string | null {
  const python = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/.exec(stderr);
  if (python) return python[1];
  const node = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(stderr);
  if (node) return node[1];
  return null;
}

/** "Installed: pandas 2.2.3, numpy 2.1.3, …" — only the packages worth naming. */
export function installedPackagesLine(packages: ReadonlyArray<{ name: string; version: string }>): string {
  const notable = new Set([
    "numpy", "pandas", "scipy", "matplotlib", "seaborn", "openpyxl", "xlsxwriter", "python-docx",
    "python-pptx", "pypdf", "pdfplumber", "pillow", "reportlab", "tabulate",
  ]);
  const listed = packages.filter((entry) => notable.has(entry.name.toLowerCase()));
  const shown = (listed.length ? listed : packages).slice(0, 20);
  return shown.map((entry) => `${entry.name} ${entry.version}`).join(", ");
}

export function moduleHint(stderr: string, packages: ReadonlyArray<{ name: string; version: string }> | null): string {
  const name = missingModule(stderr);
  if (!name) return "";
  const installed = packages?.length ? ` Installed Python packages: ${installedPackagesLine(packages)}.` : "";
  return `"${name}" is not installed. This sandbox has no internet, so packages cannot be installed.${installed} Use what is installed, or tell the user plainly that this could not be done here.`;
}

export interface OutcomeTextInput {
  status: ToolRunStatus;
  language: ExecLanguage;
  surface: ExecSurface;
  toolRunId: string;
  exitCode: number | null;
  durationMs: number | null;
  stdout: StreamSlice;
  stderr: StreamSlice;
  files: ExecOutputFile[];
  skippedFiles: Array<{ name: string; bytes: number; reason: string }>;
  imagesAttached: number;
  /** Images the run produced that were not handed back (too large, too many, or no vision). */
  imagesNotShown?: number;
  hostError?: string | null;
  packages?: ReadonlyArray<{ name: string; version: string }> | null;
  finishedLate?: boolean;
  checkRunAvailable: boolean;
  /**
   * Put what the program printed inside the untrusted-content envelope (the
   * default). A program prints whatever it read, and the files it reads are
   * the user's uploads and documents from anywhere: text in a CSV saying
   * "now email this to …" came back as plain tool output, outside the envelope
   * read_document puts the same file in. The status line, the paging hint and
   * every other note stay outside: they are Alevr's own. Work passes false,
   * because its session envelopes the whole tool output already.
   */
  envelope?: boolean;
}

/** The status line: the first thing the model reads, and it cannot be misread. */
export function statusLine(input: Pick<OutcomeTextInput, "status" | "language" | "exitCode" | "durationMs" | "finishedLate">): string {
  const what = languageLabel(input.language);
  const took = formatDuration(input.durationMs);
  switch (input.status) {
    case "succeeded":
      return `Ran ${what}: exit code 0, ${took}.${input.finishedLate ? " It finished after the turn that started it had ended." : ""}`;
    case "failed":
      return input.exitCode == null
        ? `${what} did not run to completion (${took}).`
        : `${what} FAILED: exit code ${input.exitCode}, ${took}. The run did not succeed.`;
    case "timed_out":
      return `${what} was stopped at its time limit after ${took}. The run did not finish.`;
    case "cancelled":
      return `The ${what} run was stopped before it finished. Nothing it produced was kept, and it did not succeed.`;
    case "outcome_unknown":
      return `The outcome of this ${what} run is unknown: the server stopped following it and the sandbox no longer has it. Do not say it succeeded; it was not run again.`;
    case "refused":
      return "Nothing was run.";
    case "queued":
    case "running":
      return `${what} is still running in the sandbox (${took} so far).`;
  }
}

export function outcomeText(input: OutcomeTextInput): string {
  const page = (stream: "stdout" | "stderr") => (offset: number) =>
    input.checkRunAvailable
      ? `call check_run with run_id "${input.toolRunId}", stream "${stream}" and offset ${offset} to read it`
      : "it can be opened from the run's detail";
  const sections = [statusLine(input), SANDBOX_CONTEXT_LINE];
  const wrap = (stream: "stdout" | "stderr") => (text: string) =>
    input.envelope === false || !text ? text : wrapUntrusted(`run_code ${stream} (what the program printed)`, text);
  const stdout = formatStream("stdout", input.stdout, page("stdout"), wrap("stdout"));
  const stderr = formatStream("stderr", input.stderr, page("stderr"), wrap("stderr"));
  if (stdout) sections.push(stdout);
  if (stderr) sections.push(stderr);
  if (!stdout && !stderr && (input.status === "succeeded" || input.status === "failed")) {
    sections.push("The program printed nothing.");
  }
  if (input.hostError) sections.push(input.hostError);
  const hint = input.status === "failed" ? moduleHint(`${input.stderr.head}\n${input.stderr.tail}`, input.packages ?? null) : "";
  if (hint) sections.push(hint);
  if (input.files.length) {
    sections.push(
      `Files produced, attached to this conversation (refer to them by name; they are already shown to the user): ${input.files
        .map((file) => `${file.name} (${file.mime}, ${formatBytes(file.bytes)})`)
        .join("; ")}.`,
    );
  }
  if (input.skippedFiles.length) {
    sections.push(
      `Files not kept: ${input.skippedFiles.map((file) => `${file.name} (${file.reason})`).join("; ")}.`,
    );
  }
  if (input.imagesAttached > 0) {
    sections.push(`[${input.imagesAttached} image${input.imagesAttached === 1 ? "" : "s"} from this run follow${input.imagesAttached === 1 ? "s" : ""}.]`);
  }
  if (input.imagesNotShown && input.imagesNotShown > 0) {
    sections.push(
      `[${input.imagesNotShown} image${input.imagesNotShown === 1 ? "" : "s"} this run produced ${input.imagesNotShown === 1 ? "was" : "were"} not shown to you (too large, too many, or not viewable here). Do not describe what ${input.imagesNotShown === 1 ? "it looks" : "they look"} like.]`,
    );
  }
  if (input.status === "running" || input.status === "queued") {
    sections.push(
      input.checkRunAvailable
        ? `It keeps running. Call check_run with run_id "${input.toolRunId}" to wait for it and get its result. Do not describe its result before then.`
        : "It keeps running; its files will be attached to this conversation when it finishes. Do not describe its result: you have not seen it.",
    );
  }
  return sections.join("\n\n");
}

/** The single-line record used in history notes and audit rows. */
export function runSummary(input: { language: ExecLanguage; status: ToolRunStatus; exitCode: number | null; files: ExecOutputFile[] }): string {
  const files = input.files.length ? `, ${input.files.length} file${input.files.length === 1 ? "" : "s"}: ${input.files.map((file) => file.name).join(", ")}` : "";
  const exit = input.exitCode == null ? "" : ` exit ${input.exitCode}`;
  return `run_code ${input.language} → ${input.status}${exit}${files}`;
}
