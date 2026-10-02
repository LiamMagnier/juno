/**
 * check_run: wait for a run that run_code reported as still running, or page
 * through a run's full output (TOOL_RUNTIME_DESIGN.md §6.5). Read-only: it
 * never starts anything. It reaches only runs of this conversation (or Work
 * run); any other id is "not found".
 */
import { CHECK_RUN_TOOL_ID, defineTool, type PortableSchema, type ToolSpec } from "@/lib/tools/types";
import { execContextFrom, toToolOutcome, type ExecTurnOptions } from "@/lib/exec/contract";

/** wait_seconds ≤ 60 plus collecting a finished run's files. */
export const CHECK_RUN_TIMEOUT_MS = 120_000;

export const CHECK_RUN_INPUT: PortableSchema = {
  type: "object",
  properties: {
    run_id: { type: "string", description: "The run_id run_code returned." },
    wait_seconds: {
      type: "integer",
      description: "How long to wait for a running run to finish, 0 to 60. Default 30.",
    },
    stream: {
      type: "string",
      enum: ["stdout", "stderr"],
      description: "Read this stream of the run's full output instead of waiting.",
    },
    offset: { type: "integer", description: "Byte offset to read the stream from (with stream)." },
  },
  required: ["run_id"],
};

export const CHECK_RUN_DESCRIPTION =
  "Wait for a run_code run that is still running and get its result, or read more of a run's output when run_code said it was cut (pass stream and offset). It never starts or re-runs anything. Only runs from this conversation can be checked.";

export function checkRunSpec(options: ExecTurnOptions): ToolSpec {
  return defineTool({
    id: CHECK_RUN_TOOL_ID,
    title: "Check a run",
    description: CHECK_RUN_DESCRIPTION,
    input: CHECK_RUN_INPUT,
    risk: "read",
    parallelSafe: false,
    timeoutMs: CHECK_RUN_TIMEOUT_MS,
    broker: "juno_runtime",
    dedupe: false,
    async execute(args, ctx) {
      const { executeCheckRun } = await import("@/lib/exec/runtime");
      return toToolOutcome(await executeCheckRun(args, execContextFrom(ctx, options)));
    },
  });
}
