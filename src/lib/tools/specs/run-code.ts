/**
 * `run_code` (SPEC §3.8.5, was `code_interpreter`): Python in the remote
 * sandbox, as a Juno spec.
 *
 * The execution is the agent tool's (`src/lib/agent/code.ts`): microVM only,
 * never a host process, network `"none"`, attached files copied in, charts and
 * image files returned as pixels, and output built from attached files inside
 * the untrusted envelope. It is a `read` (DECISIONS §4b) only because the
 * sandbox has no way out, so it is attached only when that is confirmed
 * (`runCodeSandboxReady`) and the tool checks it again before running.
 *
 * Metered per call: the sandbox's own wall time, at least one second, at
 * `RUN_CODE_MICRO_USD_PER_SECOND` (SPEC §3.9). A call that never reached the
 * sandbox costs nothing.
 */

import { runCodeTool, type RunCodeData, type RunCodeParams } from "@/lib/agent/code";
import type { AgentExecutionContext, ToolExecutionResult } from "@/lib/agent/types";
import { runCodeFeeMicroUsd } from "@/lib/tools/metering";
import { agentContextFor, oneLine, outcomeFromAgentResult, stringArg } from "@/lib/tools/specs/shared";
import { defineTool, type ToolSpec } from "@/lib/tools/types";
import type { ToolFigure, ToolPresentArgs } from "@/types/run";

export interface RunCodeArgs extends Record<string, unknown> {
  code?: unknown;
  files?: unknown;
  reason?: unknown;
}

type Run = (params: RunCodeParams, context: AgentExecutionContext) => Promise<ToolExecutionResult<unknown>>;

function figureFor(data: RunCodeData | undefined): ToolFigure | undefined {
  if (!data) return undefined;
  if (data.files > 0) return { kind: "files", n: data.files };
  return { kind: "exit", value: data.errorName ?? String(data.exitCode) };
}

export function createRunCodeSpec(deps: { run?: Run } = {}): ToolSpec<RunCodeArgs> {
  const run: Run = deps.run ?? ((params, context) => runCodeTool.execute(params, context));

  return defineTool<RunCodeArgs>({
    id: "run_code",
    title: "Run code",
    description:
      "Runs Python in an isolated remote sandbox with no network, for analysis, calculations over data, charts and files. Files attached to this conversation are placed in the working directory under their own names. Use it to compute over a spreadsheet or CSV, parse a file format nothing else reads, plot a chart, simulate, or check a calculation too complex for calculate. Do not use it for simple arithmetic (use calculate) or to read a document's text (use read_document). Print what you want to see; save images or files to the working directory to have them returned. Each call starts a fresh sandbox, so re-load files and re-define variables every time. Output is cut at 30,000 characters and a run stops after 120 seconds.",
    input: {
      type: "object",
      properties: {
        code: { type: "string", description: "The Python to run. Required." },
        files: {
          type: "array",
          items: { type: "string", description: "An attached file's name." },
          description: "Attached files to copy in. Omit to include all attached files.",
        },
        reason: { type: "string", description: "What you are trying to find out, in a few words." },
      },
      required: ["code"],
    },
    risk: "read",
    parallelSafe: false,
    timeoutMs: 130_000,
    icon: "code",
    broker: "juno_runtime",
    dedupe: true,
    present(args) {
      const out: ToolPresentArgs = { language: "python" };
      const reason = stringArg(args.reason);
      if (reason) out.reason = oneLine(reason);
      const code = typeof args.code === "string" ? args.code.replace(/\s+$/, "") : "";
      out.lines = code ? code.split("\n").length : 0;
      return out;
    },
    async execute(args, ctx) {
      const params: RunCodeParams = {
        code: typeof args.code === "string" ? args.code : "",
        ...(Array.isArray(args.files)
          ? { files: args.files.filter((file): file is string => typeof file === "string" && file.trim() !== "") }
          : {}),
        ...(stringArg(args.reason) ? { reason: stringArg(args.reason)! } : {}),
      };
      const result = await run(params, agentContextFor(ctx));
      const data = result.data as RunCodeData | undefined;
      return outcomeFromAgentResult(result, {
        figure: figureFor(data),
        ...(typeof data?.sandboxMs === "number" ? { feeMicroUsd: runCodeFeeMicroUsd(data.sandboxMs) } : {}),
      });
    },
  });
}

export const runCodeSpec = createRunCodeSpec();
