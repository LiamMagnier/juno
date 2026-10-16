/**
 * Risk words for a desktop action, kept for the domain checks
 * (scripts/domain-checks.ts, tool-04).
 *
 * This file used to export `computerTool`, a "GUI automation" tool that drove
 * nothing: on any macOS process it reported "Executed OS action … on native
 * host" without doing anything, and no registry registered it. It is gone.
 * Real computer use is the cloud computer's tools
 * (runner/agent-core/src/work/computer-tools.ts) and the Mac's own screen
 * control (native/Packages/JunoScreenControl).
 */

import type { ActionRiskClass } from "@/lib/action-approval";

export interface ComputerActionParams {
  action: "screenshot" | "click" | "double_click" | "move" | "type" | "key" | "scroll" | "focus_app" | "stop";
  coordinate?: [number, number];
  text?: string;
  key?: string;
  appName?: string;
  scrollDelta?: [number, number];
  reason?: string;
}

/**
 * Classify the risk of a specific computer action
 */
export function classifyComputerActionRisk(params: ComputerActionParams): ActionRiskClass {
  if (params.action === "screenshot" || params.action === "move" || params.action === "stop") {
    return "read_only";
  }

  // Check for sensitive keywords in text input or app targets
  const sensitiveContext = `${params.text || ""} ${params.appName || ""} ${params.reason || ""}`.toLowerCase();

  if (
    sensitiveContext.includes("password") ||
    sensitiveContext.includes("credit card") ||
    sensitiveContext.includes("payment") ||
    sensitiveContext.includes("checkout") ||
    sensitiveContext.includes("buy") ||
    sensitiveContext.includes("purchase") ||
    sensitiveContext.includes("delete") ||
    sensitiveContext.includes("remove") ||
    sensitiveContext.includes("terminal") ||
    sensitiveContext.includes("sudo")
  ) {
    return "destructive_or_sensitive";
  }

  return "external_write";
}
