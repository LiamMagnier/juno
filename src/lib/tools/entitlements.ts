/**
 * Which execution and skill tools a chat turn may carry (TOOL_RUNTIME_DESIGN
 * §6.9, §6.11; chat-rework DECISIONS §4c).
 *
 * One row per tool, keyed to the provider that serves it: the execution lane
 * (`exec`: `run_code`, `check_run`) and the skill lane (`skills`: `use_skill`,
 * `read_skill_file`). A row grants its tool only when EVERY condition holds:
 *
 *   - the turn is saved (a private chat persists nothing, and these tools
 *     produce records and files),
 *   - lockdown is off and this is not a canvas edit,
 *   - the plan allows it (`run_code` is paid plans only),
 *   - the workspace does not restrict tools (there is no "code" key to allow
 *     it, so a restricted workspace keeps it off),
 *   - function tools reach the model this turn (Gemini before 3 cannot carry
 *     functions beside its search),
 *   - the model's tool calling is VERIFIED by the round-trip probe — an
 *     untested model is never treated as compatible,
 *   - and the provider says it can serve the turn (a configured, healthy,
 *     network-isolated sandbox; enabled, clean skills).
 *
 * The same reading decides what the model is TOLD (`codeExecution`): the tool
 * and its instructions when it is attached, and otherwise a plain-language
 * note, so a model never writes code and implies it ran.
 *
 * Pure: the route supplies the facts.
 */

import type { ToolCallingVerdict } from "@/lib/model-tool-probe";
import {
  CHECK_RUN_TOOL_ID,
  READ_SKILL_FILE_TOOL_ID,
  RUN_CODE_TOOL_ID,
  USE_SKILL_TOOL_ID,
  type ToolProvider,
  type ToolProviderAvailability,
} from "@/lib/tools/types";

export type ToolProviderId = ToolProvider["id"];

export interface EntitlementRow {
  tool: string;
  provider: ToolProviderId;
  /** Paid plans only (DECISIONS §4c, metered per sandbox-second). */
  paidOnly: boolean;
}

export const EXECUTION_ENTITLEMENT_ROWS: readonly EntitlementRow[] = Object.freeze([
  { tool: RUN_CODE_TOOL_ID, provider: "exec", paidOnly: true },
  { tool: CHECK_RUN_TOOL_ID, provider: "exec", paidOnly: true },
  { tool: USE_SKILL_TOOL_ID, provider: "skills", paidOnly: false },
  { tool: READ_SKILL_FILE_TOOL_ID, provider: "skills", paidOnly: false },
]);

export type WithheldReason =
  | "private"
  | "lockdown"
  | "artifact_edit"
  | "plan"
  | "workspace"
  | "tools_cannot_reach_model"
  | "model_unverified"
  | "provider_unavailable";

export interface ExecutionEntitlementInput {
  plan: string;
  private: boolean;
  lockdown: boolean;
  artifactEdit: boolean;
  /** `workspaceConfig.allowedTools !== undefined`. */
  workspaceRestrictsTools: boolean;
  toolsReachModel: boolean;
  modelVerdict: ToolCallingVerdict;
  /** Each provider's answer for this turn; absent = no such provider is installed. */
  providers: Partial<Record<ToolProviderId, ToolProviderAvailability>>;
  /**
   * The legacy `code_interpreter` registry tool's own sandbox check
   * (`isCodeInterpreterConfigured()`), until the execution lane retires it.
   */
  legacySandboxConfigured?: boolean;
}

/**
 * What the model is told about running code this turn:
 *   available        — an execution tool is attached;
 *   unverified_model — execution exists here, but this model is not verified;
 *   unavailable      — no execution tool can be attached on this turn;
 *   off              — say nothing (a private or canvas-edit turn).
 */
export type CodeExecutionState = "available" | "unverified_model" | "unavailable" | "off";

export interface ExecutionEntitlements {
  /** Granted tool ids per provider, in row order. Open a provider only for a non-empty list. */
  granted: Record<ToolProviderId, string[]>;
  /** The legacy registry `code_interpreter` may be attached (when a file is in the turn). */
  legacyCodeInterpreter: boolean;
  codeExecution: CodeExecutionState;
  withheld: Array<{ tool: string; reason: WithheldReason }>;
}

function turnReason(input: ExecutionEntitlementInput, paidOnly: boolean): WithheldReason | null {
  if (input.private) return "private";
  if (input.lockdown) return "lockdown";
  if (input.artifactEdit) return "artifact_edit";
  if (paidOnly && input.plan === "FREE") return "plan";
  if (paidOnly && input.workspaceRestrictsTools) return "workspace";
  if (!input.toolsReachModel) return "tools_cannot_reach_model";
  return null;
}

export function executionEntitlements(input: ExecutionEntitlementInput): ExecutionEntitlements {
  const granted: Record<ToolProviderId, string[]> = { exec: [], skills: [] };
  const withheld: ExecutionEntitlements["withheld"] = [];
  for (const row of EXECUTION_ENTITLEMENT_ROWS) {
    const availability = input.providers[row.provider];
    const reason =
      turnReason(input, row.paidOnly) ??
      (!availability || !availability.available ? "provider_unavailable" : null) ??
      (input.modelVerdict !== "verified" ? "model_unverified" : null);
    if (reason) withheld.push({ tool: row.tool, reason });
    else granted[row.provider].push(row.tool);
  }

  const legacyReason = input.legacySandboxConfigured
    ? (turnReason(input, true) ?? (input.modelVerdict !== "verified" ? "model_unverified" : null))
    : "provider_unavailable";
  const legacyCodeInterpreter = legacyReason === null;

  let codeExecution: CodeExecutionState;
  const runCode = withheld.find((entry) => entry.tool === RUN_CODE_TOOL_ID)?.reason ?? null;
  if (input.private || input.artifactEdit) codeExecution = "off";
  else if (granted.exec.includes(RUN_CODE_TOOL_ID) || legacyCodeInterpreter) codeExecution = "available";
  else if (runCode === "model_unverified" || legacyReason === "model_unverified") codeExecution = "unverified_model";
  else codeExecution = "unavailable";

  return { granted, legacyCodeInterpreter, codeExecution, withheld };
}
