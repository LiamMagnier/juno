/**
 * run_code: run a program in Alevr's hosted sandbox and get its real output
 * (TOOL_RUNTIME_DESIGN.md §6.5). Replaces `code_interpreter`, which stays an
 * alias (`TOOL_ID_ALIASES`).
 *
 * Risk `read`: the program runs in a fresh container with no network, no
 * credentials and only this conversation's files, and what it produces comes
 * back to this conversation only (chat-rework DECISIONS §4b). The broker has
 * the exact rule `juno_runtime:run_code` → read_only. Not parallel-safe: calls
 * in one reply share a workspace and run in order.
 *
 * NO STATIC SERVER IMPORTS: the registry builds specs at module load, so the
 * runtime (Prisma, storage, the host client) is reached through `import()`.
 */
import { defineTool, RUN_CODE_TOOL_ID, type PortableSchema, type ToolSpec } from "@/lib/tools/types";
import { execContextFrom, toToolOutcome, type ExecTurnOptions } from "@/lib/exec/contract";
import { oneLine, stringArg } from "@/lib/tools/specs/shared";
import type { ToolPresentArgs } from "@/types/run";

/**
 * The dispatcher's bound on one call. Longer than the chat inline wait (90 s)
 * plus file capture, so the runtime always answers ("finished" or "still
 * running, run id …") before the dispatcher would abort it — an abort is read
 * as Stop and cancels the run.
 */
export const RUN_CODE_TIMEOUT_MS = 180_000;

export const RUN_CODE_INPUT: PortableSchema = {
  type: "object",
  properties: {
    language: {
      type: "string",
      enum: ["python", "javascript", "bash"],
      description: "python (default), javascript (Node) or bash.",
    },
    code: {
      type: "string",
      description:
        "The whole program (or, for bash, the commands). Print what you need to see. Save charts and other files in the working directory; they are attached to the conversation.",
    },
    files: {
      type: "array",
      items: { type: "string", description: "An attached file's name." },
      description: "Attached files to make available in inputs/. Omit to include every file attached to this conversation.",
    },
    timeout_seconds: {
      type: "integer",
      description: "Stop the program after this many seconds. Default 120, at most 600.",
    },
    reason: { type: "string", description: "What this run is for, in a few words; shown to the user." },
  },
  required: ["code"],
};

export function runCodeDescription(manifestLine?: string | null, checkRunAvailable = true): string {
  return [
    "Run a program in Alevr's sandbox and get its real output: exit code, stdout, stderr and the files it wrote.",
    `Available: ${manifestLine ?? "Python 3.12 (pandas, numpy, scipy, matplotlib, seaborn, openpyxl, reportlab), Node 22, bash"}.`,
    "Files attached to this conversation are in inputs/ (read-only), under their own names. The working directory is shared by every run in this reply, so a file one run writes is there for the next.",
    "Every file a run writes outside inputs/ is attached to the conversation automatically and shown to the user: save charts as PNG files and refer to them by name. Images you save are shown back to you.",
    "The sandbox has no internet access, cannot install packages and cannot reach the user's computer.",
    "Use it to compute over data, transform or read files, make charts, spreadsheets, documents or slides, or check a calculation. Do not use it for simple arithmetic.",
    "Read the result before answering. When a run fails, read stderr, fix the program and run it again. State only results a run actually returned, and say plainly when something could not be done.",
    checkRunAvailable
      ? "A run that takes longer than about 90 seconds keeps going: you get its run_id, and check_run waits for it."
      : "A run that takes longer than about 90 seconds keeps going and its files are attached when it finishes.",
  ].join(" ");
}

export interface RunCodeSpecOptions extends Partial<ExecTurnOptions> {
  manifestLine?: string | null;
  checkRunAvailable?: boolean;
}

export interface RunCodeCallable {
  (options?: RunCodeSpecOptions): ToolSpec;
}

export function createRunCodeSpec(options: RunCodeSpecOptions = {}): ToolSpec {
  const checkRunAvailable = options.checkRunAvailable ?? true;
  const execOptions: ExecTurnOptions = {
    vision: options.vision ?? false,
    ...options,
  };
  return defineTool({
    id: RUN_CODE_TOOL_ID,
    title: "Run code",
    description: runCodeDescription(options.manifestLine, checkRunAvailable),
    input: RUN_CODE_INPUT,
    risk: "read",
    parallelSafe: false,
    timeoutMs: RUN_CODE_TIMEOUT_MS,
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
      const { executeRunCode } = await import("@/lib/exec/runtime");
      return toToolOutcome(await executeRunCode(args, execContextFrom(ctx, execOptions), { checkRunAvailable }));
    },
  });
}

export const runCodeSpec: ToolSpec & RunCodeCallable = Object.assign(
  function (options?: RunCodeSpecOptions): ToolSpec {
    return createRunCodeSpec(options);
  },
  createRunCodeSpec()
) as unknown as ToolSpec & RunCodeCallable;
