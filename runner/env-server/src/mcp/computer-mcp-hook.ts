/**
 * Wires `computer_use` into the env lane's Alevr MCP server (SPEC §3.11,
 * §3.12) through its registration hook, `AlevrMcpServer.registerTool()`.
 *
 * That server registers each tool once for every session and passes the
 * caller's scope (session id + depth, taken from the bearer token) to the
 * handler. Computer use is per session — its own lock holder id, runtime
 * mode, coordinate space and turn items — so this adapter keeps one
 * `ComputerTools` per scoped session, created on the first call and disposed
 * on turn end, session close or explicit release so the desktop lock and
 * the Mac's per-session grants are let go.
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
 */
import { ALEVR_COMPUTER_TOOL_NAME, type ComputerActionItem, type ComputerCoordinateSpace } from "../contracts/code-v2.js";
import type { ComputerBridge } from "./computer-bridge.js";
import {
  COMPUTER_TOOL_RULES,
  coordinateSpaceForModel,
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
  /** Native function tools for the built-in engine, including its children. */
  engineTools(scope: ComputerMcpScope): unknown[];
  /** Release the lead at turn end; active background children own their resources until they settle. */
  finishTurn(sessionId: string): Promise<void>;
  /** Releases a session and all its children on close. Safe for sessions that never used the tool. */
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
    "Prefer ax_find then ax_press with an element id over clicking coordinates: it hits the exact control. Models without vision receive accessibility controls instead of images. " +
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
  const owners = new Map<string, string>();
  const releasing = new Map<string, Promise<void>>();

  const toolsFor = (scope: ComputerMcpScope, current?: ComputerToolSession, owner = scope.sessionId): ComputerTools | undefined => {
    const existing = perSession.get(scope.sessionId);
    if (existing) return existing;
    const session = current ?? options.session(scope);
    if (!session) return undefined;
    const tools = createComputerTools({
      bridge: options.bridge,
      lock,
      // The lock and the Mac's grants key on the scoped session, whatever id the resolver reports.
      session: { ...session, id: scope.sessionId },
      onItem: options.onItem ? (item) => options.onItem!(owner, item) : undefined,
      now: options.now,
      heartbeatMs: options.heartbeatMs,
    });
    perSession.set(scope.sessionId, tools);
    owners.set(scope.sessionId, owner);
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
      return options.session(scope) !== undefined;
    },
    async handler(args, scope, signal) {
      await releasing.get(scope.sessionId);
      const session = options.session(scope);
      const tools = session ? toolsFor(scope, session) : undefined;
      if (!tools) {
        return { content: [{ type: "text", text: "Computer use isn't available in this session." }], isError: true };
      }
      return tools.call(args, { callId: newCallId(), signal, session: { ...session!, id: scope.sessionId } });
    },
  });

  const releaseOne = (sessionId: string): Promise<void> => {
    const existing = releasing.get(sessionId);
    if (existing) return existing;
    const tools = perSession.get(sessionId);
    if (!tools) return Promise.resolve();
    const work = tools.dispose().finally(() => {
      if (perSession.get(sessionId) === tools) perSession.delete(sessionId);
      owners.delete(sessionId);
      releasing.delete(sessionId);
    });
    releasing.set(sessionId, work);
    return work;
  };
  const disposeSession = async (sessionId: string) => {
    const descendants = [...owners].filter(([child, owner]) => owner === sessionId && child !== sessionId).map(([child]) => child);
    await Promise.all([releaseOne(sessionId), ...descendants.map(releaseOne)]);
  };

  const unregisterRelease = mcp.registerTool({
    name: "computer_release",
    description: "Release this agent's desktop lock and app grants when finished or before another agent uses the computer.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availableTo: (scope) => !(scope.depth > 0 && options.subagents === false) && options.session(scope) !== undefined,
    async handler(_args, scope) {
      await releaseOne(scope.sessionId);
      return { content: [{ type: "text", text: "Released the computer." }] };
    },
  });

  const engineTools = (scope: ComputerMcpScope) => {
    if (scope.depth > 0 && options.subagents === false) return [];
    type Context = { callId?: string; signal?: AbortSignal; agentId?: string; model?: string; supportsVision?: boolean; permissionMode?: string };
    const caller = (ctx: Context) => ctx.agentId ? `${scope.sessionId}:agent:${ctx.agentId}` : scope.sessionId;
    return [
      {
        spec: { name: ALEVR_COMPUTER_TOOL_NAME, description: sharedComputerToolDescription(), inputSchema: sharedComputerToolInputSchema() },
        // Native executor owns the action ladder, app grants and consequential floor.
        kind: "read",
        finishSubagent: async (agentId: string) => releaseOne(`${scope.sessionId}:agent:${agentId}`),
        summarize: (input: Record<string, unknown>) => `${String(input.action ?? "Observe")} in ${String(input.app ?? "the current app")}`,
        async execute(input: Record<string, unknown>, ctx: Context) {
          if (ctx.agentId && options.subagents === false) return { output: "Computer use is disabled for subagents.", isError: true };
          const id = caller(ctx);
          await releasing.get(id);
          const parent = options.session(scope);
          if (!parent) return { output: "Computer use cannot reach this Mac. Open the Alevr desktop app and retry.", isError: true };
          const runtimeMode = parent.runtimeMode === "read-only" || ctx.permissionMode === "plan" ? "read-only" : ctx.permissionMode === "ask" ? "ask" : ctx.permissionMode === "auto-edit" ? (parent.runtimeMode === "ask" ? "ask" : "auto-edit") : parent.runtimeMode;
          const session: ComputerToolSession = {
            ...parent, id, runtimeMode, images: ctx.supportsVision ?? parent.images,
            ...(ctx.model ? { coordinateSpace: coordinateSpaceForModel(ctx.model) } : {}),
          };
          const tools = toolsFor({ sessionId: id, depth: ctx.agentId ? 1 : scope.depth }, session, scope.sessionId)!;
          const callId = ctx.callId ?? newCallId();
          const scopedCallId = ctx.agentId ? `${ctx.agentId}_${callId}` : callId;
          const result = await tools.call(input, { callId: scopedCallId, signal: ctx.signal, session });
          if (!result.isError && session.images === false && input.action !== "ax_find") {
            const controls = await tools.call({ action: "ax_find", app: input.app }, { callId: `${scopedCallId}_controls`, signal: ctx.signal, session });
            result.content.push(...controls.content);
          }
          return {
            output: result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
            isError: result.isError,
            images: result.content.flatMap((c) => c.type === "image" && (c.mimeType === "image/png" || c.mimeType === "image/jpeg")
              ? [{ mediaType: c.mimeType, data: c.data }] : []),
          };
        },
      },
      {
        spec: { name: "computer_release", description: "Release the desktop and app grants when finished or before delegating computer work.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        kind: "read",
        summarize: () => "Release the computer",
        async execute(_input: Record<string, unknown>, ctx: Context) {
          if (ctx.agentId && options.subagents === false) return { output: "Computer use is disabled for subagents.", isError: true };
          // A child can release only its own lock, never its parent's or sibling's.
          const id = caller(ctx);
          await releaseOne(id);
          return { output: "Released the computer." };
        },
      },
    ];
  };

  return {
    engineTools,
    finishTurn: releaseOne,
    disposeSession,
    async dispose() {
      unregister();
      unregisterRelease();
      await Promise.all([...perSession.keys()].map(disposeSession));
    },
    activeSessions: () => [...perSession.keys()],
  };
}

/** Re-exported so the integrator picks a session's convention from its model id. */
export type { ComputerCoordinateSpace };
