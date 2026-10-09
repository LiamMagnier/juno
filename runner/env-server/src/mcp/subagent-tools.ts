/**
 * Alevr subagents for vendor agents (SPEC §3.3, §3.11): a Claude, Codex or
 * ACP session can start a child on ANY connected instance (Alevr, BYOK, the
 * user's own Claude/Codex, an ACP agent) through the Alevr MCP server.
 *
 * A child is an ordinary env-server session with `parentSessionId`, so
 * clients can open it, watch it and answer its approvals. The parent's
 * thread gets one `subagent` item that follows the child's state, and the
 * child's closing text is delivered once — as the result of wait_subagent —
 * which is the parent's single settlement notice. Depth is 1: children do not
 * see these tools. A child's runtime mode is never wider than its parent's.
 */
import type { AgentRole, ModelSelection, RuntimeMode, SubagentItem, SubagentStatus, TurnItem } from "../contracts/code-v2.js";
import { isRuntimeMode } from "../contracts/code-v2.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { stricterMode } from "../sessions/session-manager.js";
import { text, type AlevrMcpServer, type McpScope, type McpToolResult } from "./alevr-mcp.js";
import { newId, nowIso, truncateMiddle } from "../util.js";

const topLevel = (scope: McpScope) => scope.depth === 0;

interface ChildRecord {
  parentId: string;
  itemId: string;
  role: AgentRole;
  task: string;
  selection: ModelSelection;
  /** The parent turn that spawned it; the parent's item stays attached to that turn. */
  turnId?: string;
}

export function registerSubagentTools(mcp: AlevrMcpServer, sessions: SessionManager): () => void {
  const children = new Map<string, ChildRecord>();

  const closingText = (childId: string): string => {
    const items = sessions.log(childId).snapshot.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "assistant_message" && item.text.trim()) return item.text;
    }
    return "";
  };

  const childStatus = (childId: string): SubagentStatus => {
    const snap = sessions.log(childId).snapshot;
    if (snap.state === "running") return "running";
    if (snap.state === "waiting") return "waiting";
    if (snap.state === "error" || snap.state === "limited") return "failed";
    const last = [...snap.items].reverse().find((i) => i.kind === "interrupt" || i.kind === "error" || i.kind === "assistant_message");
    if (last?.kind === "interrupt") return "interrupted";
    if (last?.kind === "error") return "failed";
    return "completed";
  };

  const syncParent = (childId: string) => {
    const rec = children.get(childId);
    if (!rec || !sessions.has(rec.parentId)) return;
    const status = childStatus(childId);
    const usage = sessions.log(childId).snapshot.usage;
    const item: SubagentItem = {
      id: rec.itemId,
      kind: "subagent",
      createdAt: nowIso(),
      agentId: childId,
      role: rec.role,
      model: rec.selection,
      status,
      task: rec.task,
      ...(status === "completed" ? { closingText: truncateMiddle(closingText(childId), 4000) } : {}),
      ...(usage ? { tokens: { input: usage.inputTokens, output: usage.outputTokens, ...(usage.cachedInputTokens ? { cachedInput: usage.cachedInputTokens } : {}) } } : {}),
    };
    sessions.upsertItem(rec.parentId, (rec.turnId ? { ...item, turnId: rec.turnId } : item) as TurnItem);
  };

  const unsubscribeEnded = sessions.onTurnEnded((sessionId) => {
    if (children.has(sessionId)) syncParent(sessionId);
  });

  const owned = (scope: McpScope, agentId: unknown): ChildRecord | undefined => {
    if (typeof agentId !== "string") return undefined;
    const rec = children.get(agentId);
    return rec && rec.parentId === scope.sessionId ? rec : undefined;
  };

  const removers = [
    mcp.registerTool({
      name: "spawn_subagent",
      title: "Start a subagent",
      description:
        "Start a background subagent on any model the user has connected in Alevr and give it a self-contained task. Returns an agentId at once; call wait_subagent to get its final answer. Use instanceId/model to pick the provider (e.g. instanceId \"alevr\" with model \"openai:gpt-6.1\", or \"codex:default\"); omit them to use the thread's worker model.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Everything the subagent needs to know; it cannot see this conversation." },
          role: { type: "string", enum: ["worker", "explorer", "reviewer"], default: "worker" },
          instanceId: { type: "string", description: "Provider instance id from Alevr (optional)." },
          model: { type: "string", description: "Model id on that instance (optional)." },
          effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
          runtimeMode: { type: "string", enum: ["read-only", "ask", "auto-edit", "auto", "full"], description: "Never wider than this thread's own mode." },
        },
        required: ["task"],
      },
      availableTo: topLevel,
      handler: async (args, scope): Promise<McpToolResult> => {
        const task = typeof args.task === "string" ? args.task.trim() : "";
        if (!task) return text("A subagent needs a task.", true);
        const parent = sessions.log(scope.sessionId);
        const meta = parent.meta;
        const role: AgentRole = args.role === "explorer" || args.role === "reviewer" ? args.role : "worker";
        const routed = role === "reviewer" ? meta.routing?.reviewer : role === "explorer" ? meta.routing?.explorer : meta.routing?.workers?.[0];
        const selection: ModelSelection = {
          ...(routed ?? meta.selection),
          ...(typeof args.instanceId === "string" && args.instanceId ? { instanceId: args.instanceId } : {}),
          ...(typeof args.model === "string" && args.model ? { model: args.model } : {}),
          ...(typeof args.effort === "string" ? { effort: args.effort as ModelSelection["effort"] } : {}),
        };
        if (typeof args.instanceId === "string" && args.instanceId && typeof args.model !== "string") {
          const instance = sessions.registry.get(args.instanceId);
          const fallback = instance?.models?.find((m) => m.isDefault)?.id ?? instance?.models?.[0]?.id;
          selection.model = fallback ?? "default";
        }
        const requested: RuntimeMode = isRuntimeMode(args.runtimeMode) ? args.runtimeMode : meta.runtimeMode;
        const runtimeMode = stricterMode(requested, meta.runtimeMode);
        const child = await sessions.open({ cwd: meta.cwd, selection, parentSessionId: scope.sessionId, runtimeMode });
        const itemId = newId("agent");
        const parentTurn = sessions.activeTurnId(scope.sessionId);
        children.set(child.id, { parentId: scope.sessionId, itemId, role, task, selection, ...(parentTurn ? { turnId: parentTurn } : {}) });
        try {
          sessions.startTurn({ sessionId: child.id, input: { text: task }, selection, runtimeMode, interactionMode: "default" });
        } catch (error) {
          children.delete(child.id);
          return text(`The subagent could not start: ${error instanceof Error ? error.message : String(error)}`, true);
        }
        syncParent(child.id);
        return {
          content: [{ type: "text", text: `Started subagent ${child.id} on ${selection.instanceId} · ${selection.model}. Call wait_subagent with this agentId for its answer.` }],
          structuredContent: { agentId: child.id, instanceId: selection.instanceId, model: selection.model },
        };
      },
    }),
    mcp.registerTool({
      name: "wait_subagent",
      title: "Wait for a subagent",
      description: "Wait until a subagent finishes and return its closing message. Returns early with its current state when the timeout passes.",
      inputSchema: {
        type: "object",
        properties: { agentId: { type: "string" }, timeoutSeconds: { type: "number", default: 600, maximum: 3600 } },
        required: ["agentId"],
      },
      availableTo: topLevel,
      handler: async (args, scope, signal): Promise<McpToolResult> => {
        const rec = owned(scope, args.agentId);
        if (!rec) return text("No such subagent in this thread.", true);
        const id = args.agentId as string;
        const timeout = Math.min(3600, Math.max(1, Number(args.timeoutSeconds ?? 600))) * 1000;
        const timer = new AbortController();
        const t = setTimeout(() => timer.abort(), timeout);
        const onAbort = () => timer.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          await sessions.waitIdle(id, timer.signal);
        } finally {
          clearTimeout(t);
          signal.removeEventListener("abort", onAbort);
        }
        const status = childStatus(id);
        syncParent(id);
        const body = status === "completed" ? closingText(id) || "(The subagent finished without a message.)" : `The subagent is ${status}.`;
        return { content: [{ type: "text", text: body }], structuredContent: { agentId: id, status } };
      },
    }),
    mcp.registerTool({
      name: "list_subagents",
      title: "List subagents",
      description: "List this thread's subagents with their status.",
      inputSchema: { type: "object", properties: {} },
      availableTo: topLevel,
      handler: async (_args, scope): Promise<McpToolResult> => {
        const rows = [...children.entries()]
          .filter(([, r]) => r.parentId === scope.sessionId)
          .map(([id, r]) => ({ agentId: id, role: r.role, instanceId: r.selection.instanceId, model: r.selection.model, status: childStatus(id), task: r.task.slice(0, 200) }));
        return { content: [{ type: "text", text: rows.length ? JSON.stringify(rows, null, 2) : "No subagents yet." }], structuredContent: { subagents: rows } };
      },
    }),
    mcp.registerTool({
      name: "cancel_subagent",
      title: "Stop a subagent",
      description: "Stop a running subagent.",
      inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
      availableTo: topLevel,
      handler: async (args, scope): Promise<McpToolResult> => {
        if (!owned(scope, args.agentId)) return text("No such subagent in this thread.", true);
        await sessions.interrupt({ sessionId: args.agentId as string });
        syncParent(args.agentId as string);
        return text("Stopped.");
      },
    }),
    mcp.registerTool({
      name: "message_subagent",
      title: "Message a subagent",
      description: "Send a follow-up instruction to a subagent: steered into its running turn when its provider supports that, otherwise run as its next turn.",
      inputSchema: { type: "object", properties: { agentId: { type: "string" }, text: { type: "string" } }, required: ["agentId", "text"] },
      availableTo: topLevel,
      handler: async (args, scope): Promise<McpToolResult> => {
        if (!owned(scope, args.agentId) || typeof args.text !== "string") return text("No such subagent in this thread.", true);
        const id = args.agentId as string;
        const turnId = sessions.activeTurnId(id);
        if (turnId) {
          const r = await sessions.steer({ sessionId: id, turnId, input: { text: args.text } });
          return text(r.accepted ? "Delivered into its running turn." : "Queued as its next turn.");
        }
        sessions.queue({ sessionId: id, input: { text: args.text } });
        syncParent(id);
        return text("Started its next turn.");
      },
    }),
    mcp.registerTool({
      name: "search_threads",
      title: "Search Alevr threads",
      description: "Search the user's earlier Alevr Code threads on this machine by words in their titles and messages.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", default: 10, maximum: 50 } }, required: ["query"] },
      annotations: { readOnlyHint: true },
      handler: async (args, scope): Promise<McpToolResult> => {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return text("Give a query.", true);
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10)));
        const rows = sessions
          .list({ query, limit: limit + 1 })
          .filter((s) => s.id !== scope.sessionId)
          .slice(0, limit)
          .map((s) => ({ threadId: s.id, title: s.title ?? "Untitled", cwd: s.cwd, updatedAt: s.updatedAt, snippet: snippet(sessions, s.id, query) }));
        return { content: [{ type: "text", text: rows.length ? JSON.stringify(rows, null, 2) : "No matching threads." }], structuredContent: { threads: rows } };
      },
    }),
  ];

  return () => {
    unsubscribeEnded();
    for (const remove of removers) remove();
  };
}

function snippet(sessions: SessionManager, id: string, query: string): string {
  const q = query.toLowerCase();
  for (const item of sessions.log(id).snapshot.items) {
    if (item.kind !== "user_message" && item.kind !== "assistant_message") continue;
    const at = item.text.toLowerCase().indexOf(q);
    if (at >= 0) return item.text.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, " ").trim();
  }
  return "";
}
