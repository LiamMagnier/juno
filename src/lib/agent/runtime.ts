/**
 * Juno Unified Agent Runtime
 *
 * The central orchestration engine for tools, permissions, approvals,
 * streaming events, and automatic escalation across Chat, Work, Code, Research, and Voice.
 */

import type {
  ToolDefinition,
  AgentExecutionContext,
  ToolExecutionResult,
  AgentMode,
} from "@/lib/agent/types";
import { browserTool } from "@/lib/agent/browser";
import { runCodeTool } from "@/lib/agent/code";
import { readDocumentTool } from "@/lib/agent/document";
import { inspectImageTool } from "@/lib/agent/image";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { composeApprovalCallbacks } from "@/lib/tools/approval";
import {
  portableSchemaProblem,
  type ChatToolset,
  type PortableSchema,
  type ResolvedTool,
  type ToolExecuteOptions,
  type ToolOutcome,
  type ToolRisk,
  type ToolSpec,
} from "@/lib/tools/types";
import type { ClientActionApproval } from "@/lib/action-approval";

/**
 * What a registry dispatch knows about the call it serves.
 *
 * `callId` is REQUIRED, and it is the Alevr call id the dispatcher fixed
 * (src/lib/tools/call-ids.ts). This used to be `crypto.randomUUID()` minted
 * here, per attempt — which made the broker's idempotency key (`sessionId` +
 * `callId`) different on every replay of the same call, so a reconnected
 * stream asked again and could execute twice. The key is only worth having if
 * it is stable.
 */
export interface RegistryCall {
  callId: string;
  /** Called once after authorisation, before the tool runs (the dispatcher starts its timer here). */
  onAuthorized?: () => void;
  /** Per-call approval callback, composed with the context's own. */
  onApprovalRequest?: (approval: ClientActionApproval) => void;
  /** Forward a running call's output (provider specs only). */
  reportProgress?: ToolExecuteOptions["reportProgress"];
  round?: number;
}

/**
 * The bound on one registry dispatch once it is authorised, per tool. Generous
 * on purpose: these tools had no bound at all before the dispatcher, and a
 * budget tighter than their own internal limits would turn a slow success into
 * a timeout. `code_interpreter` is its 120 s run plus transport.
 */
const REGISTRY_TIMEOUT_MS: Readonly<Record<string, number>> = {
  browser_agent: 30_000,
  read_document: 120_000,
  inspect_image: 60_000,
  code_interpreter: 135_000,
};
const DEFAULT_REGISTRY_TIMEOUT_MS = 60_000;
/** Connector calls: the SPEC's 60 s, started after any approval. */
const CONNECTOR_TIMEOUT_MS = 60_000;

function riskOf(riskClass: string): ToolRisk {
  switch (riskClass) {
    case "read_only":
      return "read";
    case "reversible_write":
      return "write";
    case "external_write":
      return "external";
    default:
      return "destructive";
  }
}

/** A registry tool as the dispatcher sees it. Its schema is validated strictly when it is portable. */
export function resolvedRegistryTool(tool: ToolDefinition<unknown, unknown>): ResolvedTool {
  const portable = portableSchemaProblem(tool.parameters) === null;
  const risk = riskOf(tool.riskClass);
  return {
    name: tool.id,
    origin: "alevr",
    title: tool.name,
    risk,
    parallelSafe: risk === "read",
    timeoutMs: REGISTRY_TIMEOUT_MS[tool.id] ?? DEFAULT_REGISTRY_TIMEOUT_MS,
    dedupe: true,
    ...(portable
      ? { input: tool.parameters as unknown as PortableSchema }
      : { inputSchema: tool.parameters as unknown as Record<string, unknown> }),
  };
}

/** A provider spec (run_code, use_skill…) as the dispatcher sees it. */
export function resolvedSpecTool(spec: ToolSpec): ResolvedTool {
  return {
    name: spec.id,
    origin: "alevr",
    title: spec.title,
    risk: spec.risk,
    parallelSafe: spec.parallelSafe && spec.risk === "read",
    timeoutMs: spec.timeoutMs,
    dedupe: spec.dedupe,
    input: spec.input,
  };
}


export class UnifiedAgentRegistry {
  private tools = new Map<string, ToolDefinition<unknown, unknown>>();

  constructor() {
    // Deliberately no host-Python registration here. `sandbox/python.ts` uses a
    // child process and is retained only for local migration/tests; it is not a
    // tenant isolation boundary and must never be exposed by the hosted toolset.
    this.registerTool(browserTool as unknown as ToolDefinition<unknown, unknown>);
    // Both read-only and both scoped to what the person attached to the
    // conversation they are running in (`agent/attachments.ts`). Registering
    // them here does not attach them to anything: `chatRuntimeToolAllowlist`
    // decides that per turn, and it only ever names a tool the turn has a use
    // for — see the header of `chat/tool-policy.ts` for why an absent
    // allowlist is the dangerous case.
    this.registerTool(readDocumentTool as unknown as ToolDefinition<unknown, unknown>);
    this.registerTool(inspectImageTool as unknown as ToolDefinition<unknown, unknown>);
    // Registered always, ATTACHED only when a remote sandbox exists and the
    // turn carries a file — see `chatRuntimeToolAllowlist`. Registration is
    // not exposure; the allowlist is the gate.
    this.registerTool(runCodeTool as unknown as ToolDefinition<unknown, unknown>);
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
    context: AgentExecutionContext,
    call: RegistryCall
  ): Promise<ToolExecutionResult<unknown>> {
    const tool = this.getTool(toolId);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${toolId}`,
        summary: `Error: Tool '${toolId}' is not registered in the ${PRODUCT_NAME} Agent Runtime.`,
      };
    }

    const callId = call.callId;
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
        connectorLabel: `${PRODUCT_NAME} Runtime`,
        toolName: tool.id,
        functionName: tool.id,
        args: params,
        callId,
        // Without this a call the broker asks about waits for a card nobody
        // is shown, until the stall watchdog kills the turn. The route's
        // callback sends the card and pauses the watchdog.
        onApprovalRequest: composeApprovalCallbacks(context.onApprovalRequest, call.onApprovalRequest),
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

    // Authorised: the dispatcher's timer starts now, never during an approval.
    call.onAuthorized?.();
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

  /**
   * Run a provider spec (`run_code`, `use_skill`…) behind the same broker the
   * registry tools pass: `authorizeExternalAction` first (refusals and replays
   * answered without running), `onAuthorized`, the spec, then the receipt
   * settled on success and on failure. `broker: "none"` specs are pure and go
   * straight to the run. Infrastructure failure fails closed.
   */
  public async executeSpec(
    spec: ToolSpec,
    params: Record<string, unknown>,
    context: AgentExecutionContext,
    call: RegistryCall
  ): Promise<ToolOutcome> {
    const signal = context.abortSignal ?? new AbortController().signal;
    let receiptId: string | null = null;
    if (spec.broker === "juno_runtime") {
      try {
        const { authorizeExternalAction } = await import("@/lib/action-approval-store");
        const authorization = await authorizeExternalAction({
          userId: context.userId,
          surface: context.mode || "chat",
          sessionId: context.sessionId,
          conversationId: context.conversationId || null,
          projectId: context.projectId || null,
          connectorId: "juno_runtime",
          connectorLabel: `${PRODUCT_NAME} Runtime`,
          toolName: spec.id,
          functionName: spec.id,
          args: params,
          callId: call.callId,
          onApprovalRequest: composeApprovalCallbacks(context.onApprovalRequest, call.onApprovalRequest),
          provenance: { source: "agent_runtime", sourceKind: "runtime_tool", derivedFromUntrusted: true },
          signal,
        });
        if (authorization.kind === "refused") {
          const text = `Action not permitted: ${authorization.reason}`;
          return { status: "failed", text, body: text, error: { code: "not_permitted" } };
        }
        if (authorization.kind === "replay") {
          return {
            status: authorization.failed ? "failed" : "succeeded",
            text: authorization.result,
            body: authorization.result,
            ...(authorization.failed ? { error: { code: "tool_error" as const } } : {}),
          };
        }
        receiptId = authorization.receiptId;
      } catch {
        const text = "Could not safely verify permissions for this action, so it was not run.";
        return { status: "failed", text, body: text, error: { code: "not_permitted" } };
      }
    }

    call.onAuthorized?.();
    try {
      const outcome = await spec.execute(params, {
        userId: context.userId,
        surface: context.mode === "work" || context.mode === "voice" ? context.mode : "chat",
        sessionId: context.sessionId,
        conversationId: context.conversationId ?? null,
        projectId: context.projectId ?? null,
        callId: call.callId,
        round: call.round ?? 0,
        signal,
        reportProgress: call.reportProgress ?? (() => {}),
        onApprovalRequest: composeApprovalCallbacks(context.onApprovalRequest, call.onApprovalRequest),
      });
      // Settle the receipt (when the broker issued one) with what the model
      // was given, so a replay of this call returns the same text.
      if (receiptId) {
        const { completeExternalAction } = await import("@/lib/action-approval-store");
        await completeExternalAction({
          userId: context.userId,
          receiptId,
          ok: outcome.status === "succeeded",
          result: outcome.text.slice(0, 30_000),
        });
      }
      return outcome;
    } catch (err: unknown) {
      if (receiptId) {
        const { completeExternalAction } = await import("@/lib/action-approval-store");
        await completeExternalAction({
          userId: context.userId,
          receiptId,
          ok: false,
          result: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }
}

import type { ActiveConnector, McpFunctionTool, McpToolsetContext, ToolExecution } from "@/lib/mcp";

/**
 * Open a unified toolset containing both Native Unified Agent Tools (Python, Browser, Computer)
 * and active user MCP connectors.
 */
export async function openUnifiedAgentToolset(
  activeConnectors: ActiveConnector[] = [],
  context: AgentExecutionContext,
  options?: {
    allowedToolIds?: string[];
    /**
     * Provider specs this turn carries (the execution and skill lanes'), already
     * granted by the entitlement rows. Offered after the registry tools and run
     * behind the same broker (`executeSpec`).
     */
    specs?: readonly ToolSpec[];
  }
): Promise<ChatToolset> {
  const mcpContext: McpToolsetContext = {
    userId: context.userId,
    conversationId: context.conversationId,
    surface: context.mode || "chat",
    sessionId: context.sessionId,
    projectId: context.projectId,
    onApprovalRequest: context.onApprovalRequest,
  };

  // The MCP module is loaded only when there is a connector to open. It is
  // `server-only` and pulls in the whole connector stack; a plain chat turn
  // has no reason to pay for it, and a test of the empty toolset must be
  // able to run without a server runtime.
  const baseMcpToolset = activeConnectors.length > 0
    ? await (await import("@/lib/mcp")).openMcpToolset(activeConnectors, mcpContext)
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
  const specMap = new Map<string, ToolSpec>();
  const resolved = new Map<string, ResolvedTool>();
  // Connector tools first, as before; their names are `<connector>__<tool>`,
  // so they can never collide with a registry id or a spec id.
  for (const t of baseMcpToolset.tools) {
    const name = t.function.name;
    resolved.set(name, {
      name,
      origin: "connector",
      title: baseMcpToolset.labelFor(name),
      risk: baseMcpToolset.accessFor(name) === "read" ? "read" : "external",
      // Serialised: a connector read may still ask under a strict policy, and
      // two approval cards at once is not a shape the clients were built for.
      parallelSafe: false,
      timeoutMs: CONNECTOR_TIMEOUT_MS,
      dedupe: true,
      inputSchema: t.function.parameters,
    });
  }

  for (const t of registryTools) {
    registryMap.set(t.id, t);
    resolved.set(t.id, resolvedRegistryTool(t));
    functionTools.push({
      type: "function",
      function: {
        name: t.id,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    });
  }

  for (const spec of options?.specs ?? []) {
    // A spec never shadows a registry tool or a connector tool.
    if (resolved.has(spec.id)) continue;
    specMap.set(spec.id, spec);
    resolved.set(spec.id, resolvedSpecTool(spec));
    functionTools.push({
      type: "function",
      function: { name: spec.id, description: spec.description, parameters: spec.input as unknown as Record<string, unknown> },
    });
  }

  // Fallback call ids for a caller that supplies none: per toolset and
  // ordinal, never random, so a replay of the same sequence keys the same
  // receipts (the dispatcher always supplies the real one).
  let fallbackOrdinal = 0;
  const callIdFor = (toolName: string, callId?: string) => callId ?? `${context.sessionId}:${toolName}:${++fallbackOrdinal}`;

  return {
    tools: functionTools,
    resolve: (toolName: string) => resolved.get(toolName),
    labelFor: (toolName: string) => {
      const reg = registryMap.get(toolName);
      if (reg) return reg.name;
      const spec = specMap.get(toolName);
      if (spec) return spec.title;
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
      const spec = specMap.get(toolName);
      if (spec) return spec.risk === "read" ? "read" : "write";
      return baseMcpToolset.accessFor(toolName);
    },
    execute: async (
      toolName: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      callId?: string,
      opts?: ToolExecuteOptions
    ): Promise<ToolExecution> => {
      const spec = specMap.get(toolName);
      if (spec) {
        const outcome = await defaultAgentRegistry.executeSpec(
          spec,
          args,
          { ...context, abortSignal: signal || context.abortSignal },
          {
            callId: callIdFor(toolName, callId),
            onAuthorized: opts?.onAuthorized,
            onApprovalRequest: opts?.onApprovalRequest,
            reportProgress: opts?.reportProgress,
            round: opts?.round,
          }
        );
        return {
          text: outcome.text,
          body: outcome.body,
          ok: outcome.status === "succeeded",
          status: outcome.status,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
          ...(outcome.images?.length ? { images: outcome.images } : {}),
          ...(outcome.run ? { run: outcome.run } : {}),
        };
      }
      const reg = registryMap.get(toolName);
      if (reg) {
        const result = await defaultAgentRegistry.executeToolCall(
          toolName,
          args,
          {
            ...context,
            abortSignal: signal || context.abortSignal,
          },
          {
            callId: callIdFor(toolName, callId),
            onAuthorized: opts?.onAuthorized,
            onApprovalRequest: opts?.onApprovalRequest,
          }
        );

        // `stdout` is the full model-facing payload (for the browser tool, the
        // whole page inside its untrusted envelope). Never slice it here: a cut
        // inside the envelope drops the closing marker.
        const body = result.stdout || result.summary || JSON.stringify(result.data || {});
        return {
          text: body,
          body,
          ok: result.success,
          ...(result.durationMs != null ? { durationMs: result.durationMs } : {}),
          // Pixels ride alongside the text, not instead of it: a model without
          // vision, or an adapter that cannot carry an image into a tool
          // round, still gets a usable answer from `body` alone.
          ...(result.images?.length ? { images: result.images } : {}),
        };
      }
      return baseMcpToolset.execute(toolName, args, signal, callId, opts);
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
