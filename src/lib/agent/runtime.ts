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
import { browserTool } from "@/lib/agent/browser";

export class UnifiedAgentRegistry {
  private tools = new Map<string, ToolDefinition<unknown, unknown>>();

  constructor() {
    // Deliberately no host-Python registration here. `sandbox/python.ts` uses a
    // child process and is retained only for local migration/tests; it is not a
    // tenant isolation boundary and must never be exposed by the hosted toolset.
    this.registerTool(browserTool as unknown as ToolDefinition<unknown, unknown>);
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
      // Authorization infrastructure is part of the trust boundary even for a
      // nominally read-only tool: reads can disclose private data or reach an
      // attacker-selected network target. Never execute when it is unavailable.
      return {
        success: false,
        error: "Approval broker unavailable",
        summary: "Could not safely verify permissions for this action.",
      };
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

import type { ActiveConnector, McpToolset, McpFunctionTool, McpToolsetContext, ToolExecution } from "@/lib/mcp";

/**
 * Open a unified toolset containing both Native Unified Agent Tools (Python, Browser, Computer)
 * and active user MCP connectors.
 */
export async function openUnifiedAgentToolset(
  activeConnectors: ActiveConnector[] = [],
  context: AgentExecutionContext,
  options?: {
    allowedToolIds?: string[];
  }
): Promise<McpToolset> {
  const mcpContext: McpToolsetContext = {
    userId: context.userId,
    conversationId: context.conversationId,
    surface: context.mode || "chat",
    sessionId: context.sessionId,
    projectId: context.projectId,
    onApprovalRequest: context.onApprovalRequest,
  };

  const { openMcpToolset } = await import("@/lib/mcp");
  const baseMcpToolset = activeConnectors.length > 0
    ? await openMcpToolset(activeConnectors, mcpContext)
    : {
        tools: [],
        labelFor: (n: string) => n,
        accessFor: () => "unknown" as const,
        execute: async (n: string) => ({ text: `Unknown tool: ${n}`, body: `Unknown tool: ${n}`, ok: false }),
        close: async () => {},
      };

  // Register registry tools (python, browser, computer, etc.)
  const registryTools = defaultAgentRegistry.listTools().filter((t) => {
    if (Array.isArray(options?.allowedToolIds)) {
      return options.allowedToolIds.includes(t.id);
    }
    return true;
  });

  const functionTools: McpFunctionTool[] = [...baseMcpToolset.tools];
  const registryMap = new Map<string, ToolDefinition<unknown, unknown>>();

  for (const t of registryTools) {
    registryMap.set(t.id, t);
    functionTools.push({
      type: "function",
      function: {
        name: t.id,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    });
  }

  return {
    tools: functionTools,
    labelFor: (toolName: string) => {
      const reg = registryMap.get(toolName);
      if (reg) return reg.name;
      return baseMcpToolset.labelFor(toolName);
    },
    accessFor: (toolName: string) => {
      const reg = registryMap.get(toolName);
      if (reg) {
        if (reg.riskClass === "read_only") return "read";
        // "destructive_or_sensitive" and "external_write" both map to "write"
        // since ToolAccess only has "read" | "write" | "unknown"
        return "write";
      }
      return baseMcpToolset.accessFor(toolName);
    },
    execute: async (toolName: string, args: Record<string, unknown>, signal?: AbortSignal, callId?: string): Promise<ToolExecution> => {
      const reg = registryMap.get(toolName);
      if (reg) {
        const result = await defaultAgentRegistry.executeToolCall(toolName, args, {
          ...context,
          abortSignal: signal || context.abortSignal,
        });

        const body = result.stdout || result.summary || JSON.stringify(result.data || {});
        return {
          text: body,
          body,
          ok: result.success,
          ...(result.durationMs != null ? { durationMs: result.durationMs } : {}),
        };
      }
      return baseMcpToolset.execute(toolName, args, signal, callId);
    },
    close: async () => {
      await baseMcpToolset.close();
    },
  };
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
      suggestedTools: ["browser_agent"],
      reason: "Prompt requests quantitative analysis or plotting best solved with Python execution.",
    };
  }

  // Deep Research signals
  if (
    p.includes("deep research") ||
    p.includes("comprehensive research") ||
    p.includes("research on") ||
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
      suggestedTools: ["work_plan"],
      reason: "Prompt requests a multi-step project with structured deliverables.",
    };
  }

  return {
    suggestedTools: [],
    reason: "Standard conversation prompt.",
  };
}
