/**
 * The tool contract's fields on the chat wire (`ClientToolDetail`'s additions
 * in src/types/chat.ts): written by the route as a call moves through the
 * dispatcher, read back tolerantly from persisted activity.
 *
 * Pure, and kept apart from `chat/tool-detail.ts` (the panel's redaction and
 * budget rules) so the contract's fields have one owner.
 */

import type { ToolRunRecord } from "@/lib/tools/types";
import type { ClientToolDetail, ClientToolProgress, ClientToolRun } from "@/types/chat";

const OUTCOMES = ["succeeded", "failed", "denied", "expired", "cancelled", "outcome_unknown"] as const;
const MAX_FILES = 20;
const MAX_TEXT = 200;

function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The wire projection of a run record. */
export function clientToolRun(run: ToolRunRecord): ClientToolRun {
  return {
    runId: run.runId,
    context: run.context,
    ...(run.language ? { language: run.language } : {}),
    status: run.status,
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(run.stdoutBytes === undefined ? {} : { stdoutBytes: run.stdoutBytes }),
    ...(run.stderrBytes === undefined ? {} : { stderrBytes: run.stderrBytes }),
    files: run.files.slice(0, MAX_FILES).map((file) => ({
      attachmentId: file.attachmentId,
      name: file.name,
      mime: file.mime,
      bytes: file.bytes,
    })),
  };
}

function readRun(raw: unknown): ClientToolRun | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const runId = text(record.runId);
  const context = text(record.context, 40);
  const status = text(record.status, 40);
  if (!runId || !context || !status) return undefined;
  const files = Array.isArray(record.files)
    ? record.files.slice(0, MAX_FILES).flatMap((file) => {
        if (!file || typeof file !== "object") return [];
        const entry = file as Record<string, unknown>;
        const attachmentId = text(entry.attachmentId);
        const name = text(entry.name);
        const mime = text(entry.mime, 120);
        const bytes = count(entry.bytes);
        return attachmentId && name && mime && bytes !== undefined ? [{ attachmentId, name, mime, bytes }] : [];
      })
    : [];
  const exitCode = record.exitCode === null ? null : typeof record.exitCode === "number" && Number.isInteger(record.exitCode) ? record.exitCode : undefined;
  return {
    runId,
    context,
    ...(text(record.language, 40) ? { language: text(record.language, 40) } : {}),
    status,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(count(record.durationMs) === undefined ? {} : { durationMs: count(record.durationMs) }),
    ...(count(record.stdoutBytes) === undefined ? {} : { stdoutBytes: count(record.stdoutBytes) }),
    ...(count(record.stderrBytes) === undefined ? {} : { stderrBytes: count(record.stderrBytes) }),
    files,
  };
}

/**
 * The contract's fields from a persisted `tool` detail, as tolerant as the
 * rest of `readToolDetail`: an unknown value drops that field, never the row.
 * `phase` and `progress` are NOT read back — they are claims about a call in
 * progress, and a persisted row's call is over by definition (the same reason
 * a stored `pending` reads as `unfinished`).
 */
export function readToolContractFields(record: Record<string, unknown>): Partial<ClientToolDetail> {
  const out: Partial<ClientToolDetail> = {};
  const callId = text(record.callId);
  if (callId) out.callId = callId;
  const outcome = typeof record.outcome === "string" && (OUTCOMES as readonly string[]).includes(record.outcome) ? (record.outcome as ClientToolDetail["outcome"]) : undefined;
  if (outcome) out.outcome = outcome;
  const errorCode = typeof record.errorCode === "string" && /^[a-z_]{1,40}$/.test(record.errorCode) ? record.errorCode : undefined;
  if (errorCode) out.errorCode = errorCode;
  const timeoutMs = count(record.timeoutMs);
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  const run = readRun(record.run);
  if (run) out.run = run;
  if (record.cached === true) out.cached = true;
  return out;
}

/** A progress frame as the row carries it. */
export function clientToolProgress(progress: ClientToolProgress): ClientToolProgress {
  return {
    lines: progress.lines.map((line) => ({ stream: line.stream, text: line.text })),
    ...(progress.stdoutBytes === undefined ? {} : { stdoutBytes: progress.stdoutBytes }),
    ...(progress.stderrBytes === undefined ? {} : { stderrBytes: progress.stderrBytes }),
  };
}
