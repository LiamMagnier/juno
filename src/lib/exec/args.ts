/**
 * Argument validation for run_code and check_run. Pure: unit tested, and used
 * by the runtime before anything is recorded or run. A call that fails here is
 * answered with what was wrong and "Nothing was run."
 */
import { EXEC_LIMITS, surfaceLimits } from "@/lib/exec/config";
import { EXEC_LANGUAGES, type CheckRunArgs, type ExecLanguage, type ExecSurface } from "@/lib/exec/types";

export interface ParsedRunCode {
  language: ExecLanguage;
  code: string;
  files: string[] | null;
  timeoutMs: number;
}

export function parseRunCodeArgs(raw: Record<string, unknown>, surface: ExecSurface): ParsedRunCode | { error: string } {
  const limits = surfaceLimits(surface);
  const allowed = new Set(["language", "code", "files", "timeout_seconds", "reason"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.` };
  const language = (raw.language ?? "python") as ExecLanguage;
  if (!EXEC_LANGUAGES.includes(language)) return { error: `language must be one of ${EXEC_LANGUAGES.join(", ")}.` };
  if (typeof raw.code !== "string" || !raw.code.trim()) return { error: "code is required and must be a non-empty string." };
  if (Buffer.byteLength(raw.code, "utf8") > EXEC_LIMITS.maxCodeBytes) return { error: "code is longer than 256 KB." };
  let files: string[] | null = null;
  if (raw.files !== undefined && raw.files !== null) {
    if (!Array.isArray(raw.files) || !raw.files.every((entry) => typeof entry === "string")) {
      return { error: "files must be an array of attachment names." };
    }
    files = raw.files as string[];
  }
  let timeoutMs = limits.defaultTimeoutMs;
  if (raw.timeout_seconds !== undefined && raw.timeout_seconds !== null) {
    const seconds = raw.timeout_seconds;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1) {
      return { error: "timeout_seconds must be a whole number of seconds, at least 1." };
    }
    timeoutMs = Math.min(seconds * 1000, limits.maxTimeoutMs);
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") return { error: "reason must be a string." };
  return { language, code: raw.code, files, timeoutMs };
}

export function parseCheckRunArgs(raw: Record<string, unknown>): Required<Pick<CheckRunArgs, "run_id" | "wait_seconds">> & Pick<CheckRunArgs, "stream" | "offset"> | { error: string } {
  const allowed = new Set(["run_id", "wait_seconds", "stream", "offset"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.` };
  if (typeof raw.run_id !== "string" || !/^[a-z0-9]{10,40}$/.test(raw.run_id)) return { error: "run_id must be the run id run_code returned." };
  let wait = 30;
  if (raw.wait_seconds !== undefined) {
    if (typeof raw.wait_seconds !== "number" || !Number.isInteger(raw.wait_seconds) || raw.wait_seconds < 0) {
      return { error: "wait_seconds must be a whole number between 0 and 60." };
    }
    wait = Math.min(60, raw.wait_seconds);
  }
  if (raw.stream !== undefined && raw.stream !== "stdout" && raw.stream !== "stderr") return { error: 'stream must be "stdout" or "stderr".' };
  if (raw.offset !== undefined && (typeof raw.offset !== "number" || !Number.isInteger(raw.offset) || raw.offset < 0)) {
    return { error: "offset must be a whole number of bytes, at least 0." };
  }
  return { run_id: raw.run_id, wait_seconds: wait, stream: raw.stream as CheckRunArgs["stream"], offset: raw.offset as number | undefined };
}
