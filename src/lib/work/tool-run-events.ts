/**
 * A real run in an Orbit agent's task, as Work events.
 *
 * TOOL_RUNTIME_DESIGN.md §6.12: Orbit reuses the Work event kinds it already
 * has (`tool_started`, `tool_finished`, `artifact_created`, `degraded` with
 * `capability_unavailable`) and adds none, so every shipped web and native
 * build keeps decoding a task that ran code. What is new travels as additive
 * payload keys: `run` on the tool events (the same bounded client projection
 * chat persists, `sanitizeToolRunRecord`) and a sentence in `summary` that
 * every reader already prints.
 *
 * The execution lane's Work runner calls these when its `run_code` /
 * `check_run` / skill tools start and finish; the web feed
 * (work-timeline.tsx) and native (`NativeWorkToolRun`) read them back. Pure:
 * no Prisma, no runner imports.
 */

import {
  canonicalRunTool,
  readToolRun,
  runReceiptParts,
  runSummaryLine,
  sanitizeToolRunRecord,
  type ToolRunView,
} from "@/lib/chat/tool-run";
import type { ClientActivityEvent } from "@/types/chat";

/** The Work artifact kind a produced file is filed under (juno-work-v1 `artifactKinds`). */
export type WorkRunArtifactKind = "document" | "spreadsheet" | "presentation" | "pdf" | "image" | "archive" | "report";

export function workArtifactKindFor(mime: string, name: string): WorkRunArtifactKind {
  const m = mime.toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.includes("spreadsheet") || m.includes("excel") || m === "text/csv" || ["xlsx", "xls", "csv", "tsv"].includes(ext)) return "spreadsheet";
  if (m.includes("presentation") || ["pptx", "ppt", "key"].includes(ext)) return "presentation";
  if (m.includes("zip") || m.includes("tar") || m.includes("gzip") || ["zip", "tgz", "gz", "tar"].includes(ext)) return "archive";
  if (m === "text/html" || ext === "html") return "report";
  return "document";
}

/** What a run tool call carries into the runner: the facts, not the bytes. */
export interface WorkToolRunInput {
  callId: string;
  /** The tool id as the model called it (`run_code`, `code_interpreter`, `check_run`, `use_skill`, `read_skill_file`). */
  tool: string;
  /** The client projection of the run (`ToolOutcome.run`), sanitised here. */
  run?: Record<string, unknown> | null;
  /** The call's status (`ToolCallStatus` or a run status). */
  status: string;
  durationMs?: number;
  timeoutMs?: number;
  args?: Record<string, unknown>;
  error?: { code: string; detail?: string } | null;
}

function asRow(input: WorkToolRunInput): ClientActivityEvent {
  return {
    id: input.callId,
    kind: "tool",
    title: "Using Code",
    detail: input.tool,
    createdAt: new Date(0).toISOString(),
    call: {
      callId: input.callId,
      tool: input.tool,
      status: input.status,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.args ? { args: input.args } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.run ? { run: input.run } : {}),
    },
  } as ClientActivityEvent;
}

/** The run as the shared reader sees it, or null when the tool is not a run tool. */
export function viewWorkToolRun(input: WorkToolRunInput): ToolRunView | null {
  if (!canonicalRunTool(input.tool)) return null;
  return readToolRun(asRow(input), { live: true });
}

export interface WorkEventDraft {
  kind: "tool_started" | "tool_finished" | "artifact_created" | "degraded";
  payload: Record<string, unknown>;
}

/**
 * `tool_started` for a run: the phase sentence every reader prints as the
 * current action ("Running Python"), the run's language and context.
 */
export function workToolStartedPayload(input: WorkToolRunInput): Record<string, unknown> | null {
  const view = viewWorkToolRun({ ...input, status: input.status || "running" });
  if (!view) return null;
  const run = sanitizeToolRunRecord(input.run);
  return {
    callId: input.callId,
    tool: view.tool,
    summary: runReceiptParts({ ...view, phase: view.phase === "queued" ? "queued" : "running" }).label,
    ...(run ? { run: { ...(run.language ? { language: run.language } : {}), ...(run.context ? { context: run.context } : {}), ...(run.skill ? { skill: run.skill } : {}) } } : {}),
  };
}

/**
 * The events a finished run owes the task's feed: `tool_finished` with the
 * outcome sentence and the bounded run record, then one `artifact_created` per
 * file the run kept. A run that did not succeed creates no artifact rows for
 * files it did not keep; a failed run's kept files (a partial CSV) still do.
 */
export function workToolFinishedEvents(input: WorkToolRunInput): WorkEventDraft[] {
  const view = viewWorkToolRun(input);
  if (!view) return [];
  const run = sanitizeToolRunRecord(input.run);
  const parts = runReceiptParts(view);
  const isError = view.phase !== "succeeded";
  const events: WorkEventDraft[] = [
    {
      kind: "tool_finished",
      payload: {
        callId: input.callId,
        tool: view.tool,
        isError,
        ...(view.durationMs !== null ? { durationMs: view.durationMs } : {}),
        summary: runSummaryLine(view),
        ...(parts.reason ? { detail: { summary: parts.reason } } : {}),
        // The phase, so a reader that knows runs can tell stopped from failed
        // from unknown without re-deriving it; older readers ignore it.
        runPhase: view.phase,
        ...(run ? { run } : {}),
      },
    },
  ];
  if (view.phase === "succeeded" || view.phase === "failed") {
    for (const file of view.files) {
      events.push({
        kind: "artifact_created",
        payload: {
          artifact: {
            id: file.attachmentId ?? `${input.callId}:${file.name}`,
            kind: workArtifactKindFor(file.mime, file.name),
            title: file.name,
            version: 1,
            byteSize: file.bytes ?? 0,
            ...(file.attachmentId ? { attachmentId: file.attachmentId } : {}),
            mime: file.mime,
            origin: "tool_output",
            callId: input.callId,
          },
        },
      });
    }
  }
  return events;
}

/** Why a task's run tools were not offered, as the existing degradation. */
export type WorkRunCapabilityGap = "code_execution_unavailable" | "tool_calling_unverified";

export const WORK_RUN_GAP_LABEL: Record<WorkRunCapabilityGap, string> = {
  code_execution_unavailable: "The sandbox isn't available right now, so this task can't run code. It worked without it.",
  tool_calling_unverified:
    "Running code needs a model whose tool calling has been verified, and this one hasn't been yet, so this task worked without it.",
};

/**
 * `degraded` with `capability_unavailable`: the task will not run code, and
 * says why in a sentence (`explanation`) every reader already prints.
 */
export function workRunCapabilityDegraded(gap: WorkRunCapabilityGap, opts: { modelLabel?: string } = {}): WorkEventDraft {
  const explanation =
    gap === "tool_calling_unverified" && opts.modelLabel
      ? `Running code needs a model whose tool calling has been verified, and ${opts.modelLabel} hasn't been yet, so this task worked without it.`
      : WORK_RUN_GAP_LABEL[gap];
  return {
    kind: "degraded",
    payload: { kind: "capability_unavailable", subject: "run_code", capability: "codeExecution", reason: gap, explanation },
  };
}

/* ── Reading back ───────────────────────────────────────────────────────── */

/**
 * A run tool event's facts for the feed, from either event: the outcome
 * sentence, the exit code, where it ran, the files. Null for any other tool.
 *
 * `kind` is the Work event the payload came from. A `tool_denied` is not a
 * run at all (the runner refused it before it started: a person declined, an
 * approval expired, the loop detector stopped the task, the tier forbade it)
 * and carries no `isError`, so it is null here and the feed's own refusal
 * wording stands; read as a run it would say "Running code" over a refusal.
 */
export function readWorkToolRun(
  payload: Record<string, unknown>,
  kind?: "tool_started" | "tool_finished" | "tool_denied" | string,
): ToolRunView | null {
  if (kind === "tool_denied") return null;
  const tool = typeof payload.tool === "string" ? payload.tool : typeof payload.name === "string" ? payload.name : null;
  if (!canonicalRunTool(tool)) return null;
  const run = payload.run && typeof payload.run === "object" && !Array.isArray(payload.run) ? (payload.run as Record<string, unknown>) : null;
  const phase = typeof payload.runPhase === "string" ? payload.runPhase : null;
  const isError = payload.isError === true;
  // An older runner sends no phase; `isError` is then the only witness. A
  // `tool_finished` without it finished without an error (the feed already
  // says done); a `tool_started` is still running.
  const status =
    phase ??
    (payload.isError === undefined ? (kind === "tool_finished" ? "succeeded" : "running") : isError ? "failed" : "succeeded");
  return viewWorkToolRun({
    callId: typeof payload.callId === "string" ? payload.callId : "work-run",
    tool: tool!,
    status: phase === "timed_out" ? "failed" : status,
    ...(phase === "timed_out" ? { error: { code: "timeout" } } : {}),
    ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
    run: run ?? undefined,
  });
}
