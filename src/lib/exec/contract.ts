/**
 * The runtime's outcomes in L1's tool contract (`src/lib/tools/types.ts`).
 * Pure mapping, no server-only imports: the specs, the agent-core wiring and
 * the unit tests all use it.
 *
 * A run still going after the inline wait is a call that DID what it said (it
 * started the run and reported it running), so the call's status is
 * `succeeded` while `run.status` is `running` and the text says not to
 * describe a result. Receipts must read `run.status`, never the call status,
 * to say whether code ran (L4).
 */
import type { ToolContext, ToolErrorCode, ToolOutcome, ToolProgress, ToolRunRecord } from "@/lib/tools/types";
import { TOOL_PROGRESS_MAX_LINE_CHARS, TOOL_PROGRESS_MAX_LINES } from "@/lib/tools/types";
import type {
  ExecCallContext,
  ExecErrorCode,
  ExecProgress,
  ExecRunFacts,
  ExecToolOutcome,
  SkillMount,
} from "@/lib/exec/types";

const ERROR_CODES: Record<ExecErrorCode, ToolErrorCode> = {
  invalid_arguments: "invalid_args",
  capability_unavailable: "unavailable",
  sandbox_error: "tool_error",
  outcome_unknown: "outcome_unknown",
  not_found: "tool_error",
  cancelled: "cancelled",
  timed_out: "timeout",
  program_failed: "tool_error",
};

export function toRunRecord(facts: ExecRunFacts): ToolRunRecord {
  return {
    runId: facts.toolRunId,
    context: facts.context,
    language: facts.language,
    status: facts.status === "refused" ? "failed" : facts.status,
    exitCode: facts.exitCode,
    ...(facts.durationMs != null ? { durationMs: facts.durationMs } : {}),
    stdoutBytes: facts.stdoutBytes,
    stderrBytes: facts.stderrBytes,
    files: facts.files.map((file) => ({ attachmentId: file.attachmentId, name: file.name, mime: file.mime, bytes: file.bytes })),
    ...(facts.skillSlug
      ? {
          skill: {
            slug: facts.skillSlug,
            ...(facts.skillVersionId ? { versionId: facts.skillVersionId } : {}),
            ...(facts.skillBundleDigest ? { bundleDigest: facts.skillBundleDigest } : {}),
          },
        }
      : {}),
  };
}

export function toToolOutcome(outcome: ExecToolOutcome): ToolOutcome {
  const status: ToolOutcome["status"] =
    outcome.status === "running" ? "succeeded" : outcome.status === "outcome_unknown" ? "outcome_unknown" : outcome.status;
  return {
    status,
    text: outcome.text,
    body: outcome.body,
    ...(outcome.images?.length ? { images: outcome.images } : {}),
    ...(outcome.error ? { error: { code: ERROR_CODES[outcome.error.code] } } : {}),
    ...(outcome.durationMs != null ? { durationMs: outcome.durationMs } : {}),
    ...(outcome.run ? { run: toRunRecord(outcome.run) } : {}),
  };
}

/** The last lines of each stream, in the dispatcher's progress shape. */
export function toToolProgress(progress: ExecProgress): ToolProgress {
  const lines: ToolProgress["lines"] = [];
  const add = (stream: "stdout" | "stderr", text: string) => {
    for (const line of text.split("\n").filter((entry) => entry.length > 0)) {
      lines.push({ stream, text: line.slice(0, TOOL_PROGRESS_MAX_LINE_CHARS) });
    }
  };
  add("stdout", progress.stdoutTail);
  add("stderr", progress.stderrTail);
  return {
    lines: lines.slice(-TOOL_PROGRESS_MAX_LINES),
    stdoutBytes: progress.stdoutBytes,
    stderrBytes: progress.stderrBytes,
  };
}

export interface ExecTurnOptions {
  vision: boolean;
  workRunId?: string | null;
  /** The skill bundles armed in this session (L3 registers them with `mountSkill`). */
  skills?: () => readonly SkillMount[];
  lockdown?: boolean;
}

/** L1's ToolContext → the runtime's call context. */
export function execContextFrom(ctx: ToolContext, options: ExecTurnOptions): ExecCallContext {
  return {
    surface: ctx.surface,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    callId: ctx.callId,
    conversationId: ctx.conversationId,
    projectId: ctx.projectId,
    workRunId: options.workRunId ?? null,
    signal: ctx.signal,
    vision: options.vision,
    ...(options.lockdown !== undefined ? { lockdown: options.lockdown } : {}),
    skills: options.skills?.() ?? [],
    onProgress: (progress) => ctx.reportProgress(toToolProgress(progress)),
  };
}
