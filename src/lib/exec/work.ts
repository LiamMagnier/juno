import "server-only";
/**
 * run_code / check_run for Work and Orbit runs (scripts/work-runner.ts).
 *
 * The agent-core tool shapes (`execTools` in runner/agent-core/src/work/tools.ts)
 * take their effect from here: one sandbox workspace per Work run (the run id
 * is the session), Work's longer limits (30 min), the run's attached files as
 * inputs plus what earlier runs of the same task produced, the skill bundles
 * armed for the run, and outputs that become attachments with a WorkRunIO
 * output row. The ToolRun is keyed by the provider's call id, which the Work
 * session now passes in `ToolContext.callId`.
 */
import { prisma } from "@/lib/prisma";
import { isExecConfigured } from "@/lib/exec/config";
import { skillMountsFor } from "@/lib/exec/mounts";
import type { ExecInputFile, ExecToolOutcome } from "@/lib/exec/types";

/** The shape agent-core's `ExecToolResult` expects (kept structural: agent-core is vendored). */
export interface WorkExecResult {
  output: string;
  isError: boolean;
  exitCode?: number;
  images?: Array<{ mediaType: "image/jpeg" | "image/png"; data: string }>;
}

export function toWorkExecResult(outcome: ExecToolOutcome): WorkExecResult {
  const images = (outcome.images ?? [])
    .filter((image) => image.mimeType === "image/png" || image.mimeType === "image/jpeg")
    .map((image) => ({ mediaType: image.mimeType as "image/png" | "image/jpeg", data: image.base64 }));
  const stillRunning = outcome.run?.status === "running" || outcome.run?.status === "queued";
  return {
    output: outcome.text,
    isError: outcome.status !== "succeeded" && !stillRunning,
    ...(outcome.run?.exitCode != null ? { exitCode: outcome.run.exitCode } : {}),
    ...(images.length ? { images } : {}),
  };
}

/** The files a Work run's programs may read: its attachments, then earlier runs' outputs. */
export async function workExecInputs(input: { runId: string; userId: string; sessionId: string }): Promise<ExecInputFile[]> {
  const references = await prisma.workRunIO.findMany({
    where: {
      refKind: "attachment",
      OR: [
        { runId: input.runId, direction: "input" },
        { direction: "output", run: { sessionId: input.sessionId, userId: input.userId } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { refId: true },
    take: 200,
  });
  const ids = [...new Set(references.map((reference) => reference.refId))];
  if (ids.length === 0) return [];
  const rows = await prisma.attachment.findMany({
    // `userId` is the boundary: a manifest row can name any id.
    where: { id: { in: ids }, userId: input.userId, deletedAt: null },
    select: { id: true, fileName: true, mimeType: true, size: true, storageKey: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

export interface WorkExecDepsInput {
  runId: string;
  userId: string;
  sessionId: string;
  projectId: string | null;
  vision: boolean;
}

/** The effect behind agent-core's `execTools`, or null when hosted execution is off. */
export function workExecDeps(input: WorkExecDepsInput): {
  runCode(args: Record<string, unknown>, call: { callId: string; signal?: AbortSignal }): Promise<WorkExecResult>;
  checkRun(args: Record<string, unknown>, call: { callId: string; signal?: AbortSignal }): Promise<WorkExecResult>;
} | null {
  if (!isExecConfigured()) return null;
  const context = (call: { callId: string; signal?: AbortSignal }) => ({
    surface: "work" as const,
    userId: input.userId,
    sessionId: input.runId,
    callId: call.callId,
    conversationId: null,
    projectId: input.projectId,
    workRunId: input.runId,
    ...(call.signal ? { signal: call.signal } : {}),
    vision: input.vision,
    inputs: () => workExecInputs({ runId: input.runId, userId: input.userId, sessionId: input.sessionId }),
    skills: skillMountsFor("work", input.userId, input.runId),
  });
  return {
    async runCode(args, call) {
      const { executeRunCode } = await import("@/lib/exec/runtime");
      return toWorkExecResult(await executeRunCode(args, context(call), { checkRunAvailable: true }));
    },
    async checkRun(args, call) {
      const { executeCheckRun } = await import("@/lib/exec/runtime");
      return toWorkExecResult(await executeCheckRun(args, context(call)));
    },
  };
}
