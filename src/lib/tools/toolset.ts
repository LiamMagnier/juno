/**
 * Composing the turn's `ChatToolset`: the runtime toolset (registry tools,
 * provider specs and connector tools, `openUnifiedAgentToolset`) plus the
 * route's native tools (`start_task`, the handoff, agent configuration, rooms).
 *
 * Native tools are offered after everything else and dispatched first by name,
 * exactly as `withNativeTools` in llm.ts did — so the registry and its broker
 * never see them, and a toolset that failed to open still leaves them usable.
 * What changes is that the dispatcher now knows each one (`resolve`) and the
 * Alevr call id and the dispatcher's options reach it.
 *
 * Free of `server-only`.
 */

import type { McpFunctionTool, ToolExecution } from "@/lib/mcp";
import type { ToolAccess } from "@/lib/tool-access";
import type { ChatToolset, ResolvedTool, ToolExecuteOptions } from "@/lib/tools/types";

/**
 * A tool the chat route builds for one turn and runs itself (moved here from
 * llm.ts, which re-exports it). A closure over the turn it belongs to — the
 * account, the conversation, the user message it answers — that decides for
 * itself when a person has to be asked.
 */
export interface NativeChatTool {
  tool: McpFunctionTool;
  /** The name the activity row and the thought-process panel show for it. */
  label: string;
  access: ToolAccess;
  execute(args: Record<string, unknown>, signal?: AbortSignal, opts?: ToolExecuteOptions): Promise<ToolExecution>;
}

/** Native tools ask for approval on their own and carry no dispatcher timer; their own flows bound them. */
const NATIVE_TIMEOUT_MS = 60_000;

export function resolvedNativeTool(entry: NativeChatTool): ResolvedTool {
  return {
    name: entry.tool.function.name,
    origin: "native",
    title: entry.label,
    risk: entry.access === "read" ? "read" : "external",
    parallelSafe: false,
    timeoutMs: NATIVE_TIMEOUT_MS,
    // A repeated start_task or room question is the tool's own business.
    dedupe: false,
    inputSchema: entry.tool.function.parameters,
  };
}

/** A toolset with nothing in it. */
export function emptyChatToolset(): ChatToolset {
  return {
    tools: [],
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
