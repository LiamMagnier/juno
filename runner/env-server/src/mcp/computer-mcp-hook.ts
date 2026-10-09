/**
 * Wires `computer_use` into the env lane's Alevr MCP server (SPEC §3.11,
 * §3.12) through its registration hook, `AlevrMcpServer.registerTool()`.
 *
 * That server registers each tool once for every session and passes the
 * caller's scope (session id + depth, taken from the bearer token) to the
 * handler. Computer use is per session — its own lock holder id, runtime
 * mode, coordinate space and turn items — so this adapter keeps one
 * `ComputerTools` per scoped session, created on the first call and disposed
 * when the session closes (`disposeSession`, called from the session
 * manager's close path) so the desktop lock and the Mac's per-session grants
 * are let go.
 *
 * The types below are structural copies of the env lane's `McpScope` /
 * `McpToolDefinition`, so this file compiles on either branch; the integrator
 * calls:
 *
 *   const computer = registerComputerUseOnAlevrMcp(mcp, {
 *     bridge: createUnixSocketBridge(),
 *     session: (scope) => sessionInfo(scope.sessionId),
 *     onItem: (sessionId, item) => sessions.log(sessionId).upsertItem(item),
 *   });
 *   // on session close: await computer.disposeSession(id)
 *
 * The env lane's `McpToolResult.content` is text-only today; computer use
 * also returns `{ type: "image" }` blocks (valid MCP), so that union needs
 * the image member when the two branches meet.
 */
import { ALEVR_COMPUTER_TOOL_NAME, type ComputerActionItem, type ComputerCoordinateSpace } from "../contracts/code-v2.js";
import type { ComputerBridge } from "./computer-bridge.js";
import {
  COMPUTER_TOOL_RULES,
  computerToolInputSchema,
  createComputerTools,
  type ComputerToolSession,
  type ComputerTools,
  type McpCallResult,
} from "./computer-tools.js";
import { DesktopLock } from "./desktop-lock.js";

/** Mirrors `McpScope` in the env lane's alevr-mcp.ts. */
export interface ComputerMcpScope {
  sessionId: string;
  /** 0 for a top-level session, 1 for a subagent. */
  depth: number;
}

/** Mirrors `McpToolDefinition` in the env lane's alevr-mcp.ts. */
export interface ScopedMcpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  availableTo?(scope: ComputerMcpScope): boolean;
  handler(args: Record<string, unknown>, scope: ComputerMcpScope, signal: AbortSignal): Promise<McpCallResult>;
}

/** Anything with the env lane's registration hook. */
export interface AlevrMcpRegistry {
  registerTool(tool: ScopedMcpToolDefinition): () => void;
}

export interface ComputerUseHookOptions {
  bridge: ComputerBridge;
  /** Shared by every session on this env server; one file lock with the Mac app. */
  lock?: DesktopLock;
  /**
   * The session behind a scope: its title, runtime mode, model coordinate
   * space and whether it sees images. Undefined hides the tool from that
   * scope (closed session, or a provider that should not get it).
   */
  session(scope: ComputerMcpScope): ComputerToolSession | undefined;
  /** Every call's turn item, for that session's log. */
  onItem?(sessionId: string, item: ComputerActionItem): void;
  /** Whether subagents (depth 1) see the tool too. Default true: the desktop lock keeps them from fighting their parent. */
  subagents?: boolean;
  /** Fresh id per call when the transport has none (MCP tools/call carries no call id). */
  newCallId?: () => string;
  now?: () => Date;
  heartbeatMs?: number;
}

export interface ComputerUseHook {
  /** Releases one session's lock and Mac grants. Safe to call for sessions that never used the tool. */
  disposeSession(sessionId: string): Promise<void>;
  /** Unregisters the tool and disposes every session. */
  dispose(): Promise<void>;
  /** Sessions holding a live ComputerTools (for tests and diagnostics). */
  activeSessions(): string[];
}

/** The one description every session sees: both coordinate conventions, chosen per call. */
export function sharedComputerToolDescription(): string {
  return (
    "Use an app on the user's Mac. Start with screenshot (or open_app), then act; every action returns the screen after it settles. " +
    "Prefer ax_find then ax_press with an element id over clicking coordinates: it hits the exact control. " +
    "x and y are pixels of the latest screenshot (its size is on the first line of every result); " +
    "if your model points in 0-999 on each axis instead, pass coordinate_space: normalized_1000. " +
    "Clicks, typing and keys may ask the user first; sending, buying, deleting and signing in always ask. " +
    COMPUTER_TOOL_RULES
  );
}

export function sharedComputerToolInputSchema(): Record<string, unknown> {
  const base = computerToolInputSchema("pixels");
  return {
    ...base,
    properties: {
      ...base.properties,
      coordinate_space: {
        type: "string",
        enum: ["pixels", "normalized_1000"],
        description: "How x, y, to_x, to_y and region are written. Default: this session's model convention.",
      },
    },
  };
}

let callSequence = 0;
const defaultCallId = () => `mcp_${Date.now().toString(36)}_${(++callSequence).toString(36)}`;

export function registerComputerUseOnAlevrMcp(mcp: AlevrMcpRegistry, options: ComputerUseHookOptions): ComputerUseHook {
  const lock = options.lock ?? new DesktopLock();
  const perSession = new Map<string, ComputerTools>();
  const newCallId = options.newCallId ?? defaultCallId;

  const toolsFor = (scope: ComputerMcpScope): ComputerTools | undefined => {
    const existing = perSession.get(scope.sessionId);
    if (existing) return existing;
    const session = options.session(scope);
    if (!session) return undefined;
    const tools = createComputerTools({
      bridge: options.bridge,
      lock,
      // The lock and the Mac's grants key on the scoped session, whatever id the resolver reports.
      session: { ...session, id: scope.sessionId },
      onItem: options.onItem ? (item) => options.onItem!(scope.sessionId, item) : undefined,
      now: options.now,
      heartbeatMs: options.heartbeatMs,
    });
    perSession.set(scope.sessionId, tools);
    return tools;
  };

  const unregister = mcp.registerTool({
    name: ALEVR_COMPUTER_TOOL_NAME,
    title: "Use an app on this Mac",
    description: sharedComputerToolDescription(),
    inputSchema: sharedComputerToolInputSchema(),
    annotations: { title: "Use an app on this Mac", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    availableTo(scope) {
      if (scope.depth > 0 && options.subagents === false) return false;
      return perSession.has(scope.sessionId) || options.session(scope) !== undefined;
    },
    async handler(args, scope, signal) {
      const tools = toolsFor(scope);
      if (!tools) {
        return { content: [{ type: "text", text: "Computer use isn't available in this session." }], isError: true };
      }
      return tools.call(args, { callId: newCallId(), signal });
    },
  });

  const disposeSession = async (sessionId: string) => {
    const tools = perSession.get(sessionId);
    if (!tools) return;
    perSession.delete(sessionId);
    await tools.dispose();
  };

  return {
    disposeSession,
    async dispose() {
      unregister();
      await Promise.all([...perSession.keys()].map(disposeSession));
    },
    activeSessions: () => [...perSession.keys()],
  };
}

/** Re-exported so the integrator picks a session's convention from its model id. */
export type { ComputerCoordinateSpace };
