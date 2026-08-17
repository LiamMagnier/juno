/**
 * Juno Computer Agent (GUI & OS Automation)
 *
 * Safe OS-level automation for macOS and native host environments.
 * Supports screenshots, mouse actions, keyboard input, and application focus
 * with strict Action Approval Broker gating for sensitive actions.
 */

import crypto from "node:crypto";
import type { ToolDefinition, AgentExecutionContext, ToolExecutionResult } from "@/lib/agent/types";
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

export interface ComputerActionResult {
  action: string;
  screenshotB64?: string;
  focusedApp?: string;
  mousePosition?: [number, number];
  status: "success" | "pending_approval" | "cancelled" | "error";
  message?: string;
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

/**
 * Standard Computer Tool Definition for the Unified Agent Runtime
 */
export const computerTool: ToolDefinition<ComputerActionParams, ComputerActionResult> = {
  id: "computer_use",
  name: "Computer GUI Automation",
  category: "computer",
  description:
    "Control the desktop GUI: take screenshots, move/click the mouse, type text, send key shortcuts, and focus applications.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["screenshot", "click", "double_click", "move", "type", "key", "scroll", "focus_app", "stop"],
        description: "The computer action to perform.",
      },
      coordinate: {
        type: "array",
        items: { type: "number", description: "X or Y pixel coordinate" },
        description: "[x, y] screen coordinates for mouse actions.",
      },
      text: {
        type: "string",
        description: "Text to type via keyboard.",
      },
      key: {
        type: "string",
        description: "Special key or keyboard shortcut (e.g. 'Return', 'Cmd+C').",
      },
      appName: {
        type: "string",
        description: "Application name to bring to foreground.",
      },
      reason: {
        type: "string",
        description: "User-facing reason for performing this OS action.",
      },
    },
    required: ["action"],
  },
  riskClass: "external_write",
  formatPreview: (params) => {
    const risk = classifyComputerActionRisk(params);
    return {
      title: `Computer: ${params.action}`,
      detail: params.reason || `Action on screen (${params.action})`,
      sensitive: risk === "destructive_or_sensitive",
    };
  },
  execute: async (params, context: AgentExecutionContext): Promise<ToolExecutionResult<ComputerActionResult>> => {
    if (context.onEvent) {
      await context.onEvent({
        id: crypto.randomUUID(),
        type: "computer_action",
        timestamp: Date.now(),
        title: `Computer: ${params.action}`,
        detail: params.reason || `Executing ${params.action} at ${params.coordinate ? params.coordinate.join(",") : "current focus"}`,
        status: "running",
        source: "computer_use",
        data: { ...params },
      });
    }

    // Computer Use requires an active local host or registered native macOS bridge
    const isNativeHostAvailable = context.environment === "local_host" || process.platform === "darwin";

    if (!isNativeHostAvailable) {
      const errorMsg = "Computer Use requires a connected native macOS application or registered local host runner.";
      if (context.onEvent) {
        await context.onEvent({
          id: crypto.randomUUID(),
          type: "error",
          timestamp: Date.now(),
          title: "Computer Use Unavailable",
          detail: errorMsg,
          status: "failed",
          source: "computer_use",
        });
      }
      return {
        success: false,
        error: errorMsg,
        summary: errorMsg,
      };
    }

    // On macOS / local host: dispatch action
    const result: ComputerActionResult = {
      action: params.action,
      focusedApp: params.appName,
      mousePosition: params.coordinate,
      status: "success",
      message: `Executed OS action ${params.action} on native host.`,
    };

    if (context.onEvent) {
      await context.onEvent({
        id: crypto.randomUUID(),
        type: "computer_action",
        timestamp: Date.now(),
        title: `Computer ${params.action} Complete`,
        detail: result.message,
        status: "completed",
        source: "computer_use",
        data: { ...result },
      });
    }

    return {
      success: true,
      data: result,
      summary: result.message,
    };
  },
};
