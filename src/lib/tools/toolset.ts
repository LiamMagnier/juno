/**
 * Opening the toolset a chat turn runs with (SPEC §3.7): Juno's specs in
 * registry order, then the ready connectors' tools (sorted), then the route's
 * native tools, cut at `MAX_CHAT_FUNCTION_TOOLS`. A connector that fails to
 * open fails alone; it never takes Juno's or the native tools with it (RC-3).
 *
 * The toolset is what the dispatcher resolves names against. A Juno spec it
 * runs itself (brokered through its ports); a connector tool and `start_task`
 * go through `execute` here, which authorises inside and signals running with
 * `onAuthorized`. Within a turn the tools array never changes (SPEC §4.1).
 *
 * `src/lib/mcp.ts` is `server-only`, so it is loaded only when a connector is
 * to be opened; a turn with none, and every test, never loads it.
 */

import type {
  ActiveConnector,
  McpFunctionTool,
  McpToolset,
  McpToolsetContext,
  OpenMcpToolsetOptions,
  ToolExecution,
} from "@/lib/mcp";
import { CHAT_CONNECT_TIMEOUT_MS, resolvedConnectorTool } from "@/lib/tools/connector-tools";
import type { ChatToolPlan } from "@/lib/tools/entitlements";
import { junoToolSpec } from "@/lib/tools/registry";
import { NOT_DISPATCHED_TEXT, unknownToolText } from "@/lib/tools/toolset.prompt";
import type { ChatToolset, NativeChatTool, ResolvedTool, ToolContext, ToolSpec } from "@/lib/tools/types";
import type { ConnectorFailure, RunNotice } from "@/types/run";

export type { NativeChatTool };

/** The most function tools one chat turn offers, Juno's first (SPEC §3.4 item 3). */
export const MAX_CHAT_FUNCTION_TOOLS = 64;

type OpenMcp = (active: ActiveConnector[], ctx: McpToolsetContext, opts?: OpenMcpToolsetOptions) => Promise<McpToolset>;

/** A Juno spec as the provider sees it; `annotations` never reach the wire (`toWireTools`). */
function junoFunctionTool(spec: ToolSpec): McpFunctionTool {
  return {
    type: "function",
    function: {
      name: spec.id,
      description: spec.description,
      parameters: spec.input as unknown as Record<string, unknown>,
    },
    annotations: { junoCanonical: spec.id, ...(spec.risk === "read" ? { readOnlyHint: true } : {}) },
  };
}

function resolvedJunoTool(spec: ToolSpec): ResolvedTool {
  return {
    name: spec.id,
    canonical: spec.id,
    origin: "juno",
    title: spec.title,
    risk: spec.risk,
    parallelSafe: spec.parallelSafe,
    timeoutMs: spec.timeoutMs,
    dedupe: Boolean(spec.dedupe),
    present: (args) => spec.present ? spec.present(args) : {},
    input: spec.input,
    ...(spec.broker === "self" ? {} : { spec }),
  };
}

/**
 * A toolset of ready specs and nothing else — specs a turn has already bound
 * to its state (`src/lib/search/alevr/turn.ts`). The dispatcher runs each one
 * itself, through its broker port, exactly as it runs a registry spec; the
 * cross-provider search harness hands one of these to every adapter.
 */
export function specChatToolset(specs: readonly ToolSpec[]): ChatToolset {
  const byName = new Map(specs.map((spec) => [spec.id, spec]));
  return {
    tools: specs.map(junoFunctionTool),
    connectors: [],
    resolve: (name) => {
      const spec = byName.get(name);
      return spec ? resolvedJunoTool(spec) : undefined;
    },
    labelFor: (name) => byName.get(name)?.title ?? name,
    accessFor: (name) => {
      const spec = byName.get(name);
      return spec ? (spec.risk === "read" ? "read" : "write") : "unknown";
    },
    // Every spec here is dispatched directly; this path is never a way around the broker.
    execute: async () => ({ text: NOT_DISPATCHED_TEXT, body: NOT_DISPATCHED_TEXT, ok: false }),
    close: async () => {},
  };
}

/** Native tools ask for approval on their own and carry no dispatcher timer; their own flows bound them. */
const NATIVE_TIMEOUT_MS = 60_000;

/** A native tool that is not in the registry: risk from its declared access, never parallel. */
export function resolvedNativeTool(native: NativeChatTool): ResolvedTool {
  return {
    name: native.tool.function.name,
    canonical: "start_task",
    origin: "juno",
    title: native.label,
    risk: native.access === "read" ? "read" : "external",
    parallelSafe: false,
    timeoutMs: NATIVE_TIMEOUT_MS,
    dedupe: true,
    present: () => ({}),
  };
}

/** A toolset with nothing in it. */
export function emptyChatToolset(): ChatToolset {
  return {
    tools: [],
    connectors: [],
    resolve: () => undefined,
    labelFor: (name) => name,
    accessFor: () => "unknown",
    execute: async (name) => {
      const text = `Unknown tool: ${name}`;
      return { text, body: text, ok: false };
    },
    close: async () => {},
  };
}

/** `base` with the native tools added after everything it already carries. */
export function withNativeChatTools(base: ChatToolset | undefined, native: readonly NativeChatTool[]): ChatToolset | undefined {
  if (native.length === 0) return base;
  const inner = base ?? emptyChatToolset();
  const byName = new Map(native.map((entry) => [entry.tool.function.name, entry]));
  return {
    tools: [...inner.tools.filter((tool) => !byName.has(tool.function.name)), ...native.map((entry) => entry.tool)],
    connectors: inner.connectors,
    resolve: (name) => {
      const entry = byName.get(name);
      return entry ? resolvedNativeTool(entry) : inner.resolve(name);
    },
    labelFor: (name) => byName.get(name)?.label ?? inner.labelFor(name),
    accessFor: (name) => byName.get(name)?.access ?? inner.accessFor(name),
    execute: (name, args, signal, callId, opts) => {
      const entry = byName.get(name);
      if (entry) return entry.execute(args, signal, opts);
      return inner.execute(name, args, signal, callId, opts);
    },
    close: () => inner.close(),
  };
}

export async function openChatToolset(input: {
  plan: ChatToolPlan;
  connectors: ActiveConnector[];
  skipped: Array<{ id: string; label: string; reason: ConnectorFailure }>;
  context: Omit<ToolContext, "callId" | "round" | "signal" | "onApprovalRequest">;
  mcpContext: McpToolsetContext | null;
  nativeTools: readonly NativeChatTool[];
  maxTools?: number;
  order?: readonly string[];
  openMcp?: OpenMcp;
}): Promise<ChatToolset & { connectors: Array<{ id: string; label: string; state: "ready" | ConnectorFailure; tools: number }> }> {
  const { plan } = input;
  const notices: RunNotice[] = [];
  const cap = Math.max(0, Math.min(MAX_CHAT_FUNCTION_TOOLS, input.maxTools ?? MAX_CHAT_FUNCTION_TOOLS));

  const nativeByName = new Map(input.nativeTools.map((native) => [native.tool.function.name, native]));
  const junoSpecs = plan.juno
    .map((id) => junoToolSpec(id))
    .filter((spec): spec is ToolSpec => !!spec)
    .filter((spec) => spec.broker !== "self" || nativeByName.has(spec.id));

  const states = new Map<string, "ready" | ConnectorFailure>();
  for (const skipped of input.skipped) states.set(skipped.id, skipped.reason);
  let mcp: McpToolset | null = null;
  const wantConnectors = plan.connectors && !!input.mcpContext && input.connectors.length > 0;
  if (wantConnectors) {
    try {
      const open = input.openMcp ?? (await import("@/lib/mcp")).openMcpToolset;
      mcp = await open(input.connectors, input.mcpContext!, {
        connectTimeoutMs: CHAT_CONNECT_TIMEOUT_MS,
        onConnectorStatus: (id, state) => states.set(id, state),
      });
    } catch {
      mcp = null;
    }
    for (const connector of input.connectors) if (!states.has(connector.id)) states.set(connector.id, "unreachable");
  }

  type Entry = { tool: McpFunctionTool; resolved: ResolvedTool; connectorId?: string };
  const entries: Entry[] = [];
  for (const spec of junoSpecs) {
    const native = spec.broker === "self" ? nativeByName.get(spec.id) : undefined;
    entries.push({ tool: native?.tool ?? junoFunctionTool(spec), resolved: resolvedJunoTool(spec) });
  }
  if (mcp) {
    for (const tool of mcp.tools) {
      const route = mcp.route?.(tool.function.name);
      if (!route) continue;
      entries.push({ tool, resolved: resolvedConnectorTool(route), connectorId: route.connectorId });
    }
  }
  const junoNames = new Set(junoSpecs.map((spec) => spec.id));
  for (const native of input.nativeTools) {
    const name = native.tool.function.name;
    if (junoNames.has(name as ToolSpec["id"])) continue;
    if (name === "start_task" && !plan.juno.includes("start_task")) continue;
    entries.push({ tool: native.tool, resolved: resolvedNativeTool(native) });
  }

  const offered = entries.slice(0, cap);
  const dropped = entries.length - offered.length;
  if (dropped > 0) notices.push({ code: "tools_capped", params: { dropped } });

  const byName = new Map(offered.map((entry) => [entry.resolved.name, entry]));
  const toolsPerConnector = new Map<string, number>();
  for (const entry of offered) {
    if (entry.connectorId) toolsPerConnector.set(entry.connectorId, (toolsPerConnector.get(entry.connectorId) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const connector of input.connectors) labels.set(connector.id, connector.label);
  for (const skipped of input.skipped) labels.set(skipped.id, skipped.label);
  const ids = [...new Set([...(input.order ?? []), ...input.connectors.map((c) => c.id), ...input.skipped.map((s) => s.id)])]
    .filter((id) => labels.has(id));
  const connectors = ids.map((id) => ({
    id,
    label: labels.get(id)!,
    state: states.get(id) ?? (wantConnectors ? "unreachable" : "misconfigured"),
    tools: toolsPerConnector.get(id) ?? 0,
  }));

  const failure = (name: string, text: string): ToolExecution => ({
    text,
    body: text,
    ok: false,
    status: "failed",
    error: { code: name ? "not_permitted" : "unknown_tool" },
  });

  return {
    tools: offered.map((entry) => entry.tool),
    connectors,
    notices,
    resolve: (name) => byName.get(name)?.resolved,
    labelFor(name) {
      const entry = byName.get(name);
      if (!entry) return "tool";
      if (entry.connectorId && mcp) return mcp.labelFor(name);
      return nativeByName.get(name)?.label ?? entry.resolved.title;
    },
    accessFor(name) {
      const entry = byName.get(name);
      if (!entry) return "unknown";
      if (entry.connectorId && mcp) return mcp.accessFor(name);
      const native = nativeByName.get(name);
      if (native) return native.access;
      return entry.resolved.risk === "read" ? "read" : "write";
    },
    async execute(name, args, signal, callId, opts) {
      const entry = byName.get(name);
      if (!entry) return { ...failure("", unknownToolText(name)), error: { code: "unknown_tool" } };
      if (entry.connectorId && mcp) return mcp.execute(name, args, signal, callId, opts);
      const native = nativeByName.get(name);
      if (native) return native.execute(args, signal, opts);
      const spec = entry.resolved.spec;
      if (spec && spec.broker === "none") {
        opts?.onAuthorized?.();
        const outcome = await spec.execute(args, {
          ...input.context,
          callId: callId ?? `jc_${name}`,
          round: 0,
          signal: signal ?? new AbortController().signal,
          ...(opts?.onApprovalRequest ? { onApprovalRequest: opts.onApprovalRequest } : {}),
        });
        return {
          text: outcome.text,
          body: outcome.body,
          ok: outcome.status === "succeeded",
          status: outcome.status,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.figure ? { figure: outcome.figure } : {}),
          ...(outcome.images?.length ? { images: outcome.images } : {}),
        };
      }
      return failure(name, NOT_DISPATCHED_TEXT);
    },
    async close() {
      await mcp?.close();
    },
  };
}
