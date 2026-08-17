/**
 * Juno Unified Agent Runtime
 *
 * The central orchestration engine for tools, permissions, approvals,
 * streaming events, and automatic escalation across Chat, Work, Code, Research, and Voice.
 */

import crypto from "node:crypto";
import type {
  ToolDefinition,
  AgentExecutionContext,
  ToolExecutionResult,
  AgentMode,
} from "@/lib/agent/types";
import { pythonTool } from "@/lib/sandbox/python";
import { browserTool } from "@/lib/agent/browser";
import { computerTool } from "@/lib/agent/computer";
import type { ActionRiskClass } from "@/lib/action-approval";

export class UnifiedAgentRegistry {
  private tools = new Map<string, ToolDefinition<unknown, unknown>>();

  constructor() {
    this.registerTool(pythonTool as unknown as ToolDefinition<unknown, unknown>);
    this.registerTool(browserTool as unknown as ToolDefinition<unknown, unknown>);
    this.registerTool(computerTool as unknown as ToolDefinition<unknown, unknown>);
  }

  public registerTool(tool: ToolDefinition<unknown, unknown>): void {
    this.tools.set(tool.id, tool);
  }

  public getTool(id: string): ToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(id);
  }

  public listTools(): ToolDefinition<unknown, unknown>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Format tools for provider API schemas (OpenAI / Anthropic standard)
   */
  public toProviderToolSchemas(): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    return this.listTools().map((t) => ({
      type: "function",
      function: {
        name: t.id,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Execute a tool call through the unified runtime with Action Approval gating
   */
  public async executeToolCall(
    toolId: string,
    params: Record<string, unknown>,
    context: AgentExecutionContext
  ): Promise<ToolExecutionResult<unknown>> {
    const tool = this.getTool(toolId);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${toolId}`,
        summary: `Error: Tool '${toolId}' is not registered in the Juno Agent Runtime.`,
      };
    }

    const callId = crypto.randomUUID();
    const actionRisk: ActionRiskClass = tool.riskClass;

    // Pass through the Universal Action Approval Broker
    let receiptId: string | null = null;
    try {
      const { authorizeExternalAction } = await import("@/lib/action-approval-store");
      const authorization = await authorizeExternalAction({
        userId: context.userId,
        surface: context.mode || "chat",
        sessionId: context.sessionId,
        conversationId: context.conversationId || null,
        projectId: context.projectId || null,
        connectorId: "juno_runtime",
        connectorLabel: "Juno Runtime",
        toolName: tool.id,
        functionName: tool.id,
        args: params,
        callId,
        provenance: {
          source: "agent_runtime",
          sourceKind: "runtime_tool",
          derivedFromUntrusted: true,
        },
        signal: context.abortSignal,
      });

      if (authorization.kind === "refused") {
        if (context.onEvent) {
          await context.onEvent({
            id: callId,
            type: "error",
            timestamp: Date.now(),
            title: `Action Blocked: ${tool.name}`,
            detail: `Authorization was refused by policy (${authorization.reason})`,
            status: "failed",
            source: tool.id,
          });
        }
        return {
          success: false,
          error: `Action refused by policy: ${authorization.reason}`,
          summary: `Action '${tool.name}' was declined by security policy.`,
        };
      }

      if (authorization.kind === "replay") {
        return {
          success: !authorization.failed,
          summary: authorization.result,
        };
      }

      receiptId = authorization.receiptId;
    } catch {
      // If broker authorization throws, fail-closed for mutation tools
      if (actionRisk !== "read_only") {
        return {
          success: false,
          error: "Approval broker unavailable for mutating action",
          summary: "Could not safely verify permissions for this action.",
        };
      }
    }

    // Execute the tool
    const startTime = Date.now();
    try {
      const result = await tool.execute(params, context);
      
      // Settle receipt with broker
      if (receiptId) {
        const { completeExternalAction } = await import("@/lib/action-approval-store");
        await completeExternalAction({
          userId: context.userId,
          receiptId,
          ok: result.success,
          result: result.summary || (result.success ? "Success" : "Failed"),
        });
      }

      return result;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      
      if (receiptId) {
        const { completeExternalAction } = await import("@/lib/action-approval-store");
        await completeExternalAction({
          userId: context.userId,
          receiptId,
          ok: false,
          result: errorMsg,
        });
      }

      return {
        success: false,
        error: errorMsg,
        summary: `Execution of ${tool.name} failed: ${errorMsg}`,
        durationMs: Date.now() - startTime,
      };
    }
  }
}

/** Global singleton instance of the agent registry */
export const defaultAgentRegistry = new UnifiedAgentRegistry();

/**
 * Heuristic detector for automatic escalation from standard chat
 */
export function detectAutomaticEscalation(prompt: string): {
  recommendedMode?: AgentMode;
  suggestedTools: string[];
  reason: string;
} {
  const p = prompt.toLowerCase();

  // Python / Data Analysis signals
  if (
    p.includes("calculate") ||
    p.includes("dataframe") ||
    p.includes("pandas") ||
    p.includes("matplotlib") ||
    p.includes("chart") ||
    p.includes("plot") ||
    p.includes("statistics") ||
    p.includes("csv") ||
    p.includes("spreadsheet") ||
    p.includes("simulation")
  ) {
    return {
      recommendedMode: "data",
      suggestedTools: ["python_interpreter"],
      reason: "Prompt requests quantitative analysis or plotting best solved with Python execution.",
    };
  }

  // Deep Research signals
  if (
    p.includes("deep research") ||
    p.includes("comprehensive report") ||
    p.includes("literature review") ||
    p.includes("compare all options") ||
    p.includes("investigate thoroughly")
  ) {
    return {
      recommendedMode: "research",
      suggestedTools: ["browser_agent"],
      reason: "Prompt requests exhaustive multi-source research and synthesis.",
    };
  }

  // Work signals
  if (
    p.includes("create a plan") ||
    p.includes("step by step task") ||
    p.includes("generate deliverable") ||
    p.includes("prepare presentation") ||
    p.includes("build spreadsheet")
  ) {
    return {
      recommendedMode: "work",
      suggestedTools: ["work_plan", "python_interpreter"],
      reason: "Prompt requests a multi-step project with structured deliverables.",
    };
  }

  return {
    suggestedTools: [],
    reason: "Standard conversation prompt.",
  };
}
