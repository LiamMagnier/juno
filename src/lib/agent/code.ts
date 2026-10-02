import { createHash } from "node:crypto";
import type { ToolDefinition, ToolExecutionResult } from "@/lib/agent/types";
import { isExecConfigured } from "@/lib/exec/config";
import { RUN_CODE_INPUT, runCodeDescription } from "@/lib/tools/specs/run-code";

/*
 * The registry's code tool, now a thin bridge onto the hosted execution
 * runtime (src/lib/exec, deploy/exec-host). It exists only until L1's
 * dispatcher takes over tool execution and registers `run_code` from
 * `src/lib/tools/specs/run-code.ts` through the `exec` ToolProvider; the
 * registry id stays `code_interpreter` because that is the id the turn's
 * allowlist (`chat/tool-policy.ts`) names, and `TOOL_ID_ALIASES` maps it to
 * `run_code`. Every run it starts is a `ToolRun` with tool "run_code".
 *
 * What was here before is gone: the 30,000-character head-only output, the
 * four images and nothing else, the synchronous base64 client, and the
 * module whose fallback was a child process on this host
 * (`code-interpreter.ts`, `sandbox/python.ts`). The safety rule is unchanged
 * and now has one home, `exec/config.ts`: model-written code runs only on the
 * remote execution host, and with none configured the tool is not offered.
 *
 * NO `server-only` AND NO STATIC RUNTIME IMPORT: the registry builds every
 * tool at module load, so the runtime is reached through `await import()`.
 */

/** Whether a sandbox exists to run in (the route's attach check). */
export function isCodeInterpreterConfigured(): boolean {
  return isExecConfigured();
}

/**
 * The call id when the caller has none to give. The registry path drops the
 * provider's id today (L1 restores it), so the arguments stand in: identical
 * code in one reply is one run (the SPEC's dedupe rule for run_code), and a
 * replayed call finds its stored result instead of running twice.
 */
function fallbackCallId(params: Record<string, unknown>): string {
  return `fp_${createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 32)}`;
}

export const runCodeTool: ToolDefinition<Record<string, unknown>, unknown> = {
  id: "code_interpreter",
  name: "Run code",
  category: "python",
  description: runCodeDescription(null, false),
  parameters: RUN_CODE_INPUT as unknown as ToolDefinition["parameters"],
  // A read (chat-rework DECISIONS §4b): a fresh container with no network, no
  // credentials and only this conversation's files. Exact broker rules:
  // `juno_runtime:code_interpreter` and `juno_runtime:run_code`.
  riskClass: "read_only",
  formatPreview: (params) => ({
    title: "Run code",
    detail: typeof params.reason === "string" && params.reason ? params.reason : "Running a program in Alevr's sandbox",
    sensitive: false,
  }),
  execute: async (params, context): Promise<ToolExecutionResult<unknown>> => {
    const { executeRunCode } = await import("@/lib/exec/runtime");
    const outcome = await executeRunCode(
      params,
      {
        surface: context.mode === "voice" ? "voice" : context.mode === "work" ? "work" : "chat",
        userId: context.userId,
        sessionId: context.sessionId,
        callId: context.callId ?? fallbackCallId(params),
        conversationId: context.conversationId ?? null,
        projectId: context.projectId ?? null,
        signal: context.abortSignal,
        // The adapters drop images for models without vision (tool-result-images.ts).
        vision: true,
      },
      { checkRunAvailable: false },
    );
    return {
      success: outcome.status === "succeeded" && outcome.run?.status !== "running",
      summary: outcome.text.split("\n")[0],
      stdout: outcome.text,
      ...(outcome.images?.length ? { images: outcome.images } : {}),
      ...(outcome.durationMs != null ? { durationMs: outcome.durationMs } : {}),
      ...(outcome.run?.exitCode != null ? { exitCode: outcome.run.exitCode } : {}),
      ...(outcome.run ? { data: { run: outcome.run } } : {}),
    };
  },
};

/** Registry id, so the allowlist and the registration cannot drift apart. */
export const CODE_INTERPRETER_TOOL_ID = runCodeTool.id;
