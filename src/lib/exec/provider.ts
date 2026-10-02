/**
 * The `exec` ToolProvider (L1's contract, `src/lib/tools/types.ts`): what the
 * execution lane contributes to a turn — run_code and check_run — and whether
 * it can right now.
 *
 * L1's entitlement table decides WHETHER a turn may carry these (verified
 * model, paid plan, not private, not lockdown, workspace policy; see
 * `execEntitlement` in config.ts for this lane's half). This provider says
 * whether it CAN: configured, the host answers, and the host reports no
 * egress. An unhealthy host is `{ available: false }`, which the route turns
 * into a capability note instead of a tool that would fail.
 *
 * No static server-only imports; the runtime is loaded on first use.
 */
import { CHECK_RUN_TOOL_ID, RUN_CODE_TOOL_ID, type ToolProvider } from "@/lib/tools/types";
import { isExecConfigured } from "@/lib/exec/config";
import { skillMountsFor } from "@/lib/exec/mounts";
import { runCodeSpec } from "@/lib/tools/specs/run-code";
import { checkRunSpec } from "@/lib/tools/specs/check-run";

export const EXEC_PROMPT_SECTION = [
  "## Running code",
  "You can run Python, JavaScript (Node) and bash with run_code in Alevr's sandbox (no internet, no access to the user's computer).",
  "When a task needs computing, reading a file's contents, transforming data or producing a file, run code instead of estimating. Read the output. When a run fails, read stderr, fix the program and run it again.",
  "Files a run writes are attached to the conversation automatically: refer to them by name instead of describing a download.",
  "Only state results a run actually returned. If a run failed, timed out, was stopped or has an unknown outcome, say so; never present it as having worked.",
].join("\n");

export const execToolProvider: ToolProvider = {
  id: "exec",
  tools: [RUN_CODE_TOOL_ID, CHECK_RUN_TOOL_ID],
  async availability() {
    if (!isExecConfigured()) return { available: false, reason: "not_configured" };
    try {
      const { execHealthy } = await import("@/lib/exec/runtime");
      return (await execHealthy()) ? { available: true } : { available: false, reason: "unhealthy" };
    } catch {
      return { available: false, reason: "unhealthy" };
    }
  },
  async open(turn, granted) {
    const { runtimeManifestSummary } = await import("@/lib/exec/runtime");
    const manifestLine = await runtimeManifestSummary().catch(() => null);
    const checkRunAvailable = granted.includes(CHECK_RUN_TOOL_ID);
    const options = {
      vision: turn.vision,
      skills: () => skillMountsFor(turn.surface, turn.sessionId),
    };
    const specs = [
      ...(granted.includes(RUN_CODE_TOOL_ID) ? [runCodeSpec({ ...options, manifestLine, checkRunAvailable })] : []),
      ...(checkRunAvailable ? [checkRunSpec(options)] : []),
    ];
    return { specs, promptSection: specs.length ? EXEC_PROMPT_SECTION : undefined };
  },
};
