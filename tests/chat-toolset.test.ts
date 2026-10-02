import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { ClientActionApproval } from "@/lib/action-approval";
import type { ActiveConnector, McpFunctionTool, McpToolset, McpToolsetContext, OpenMcpToolsetOptions, ToolExecuteOptions } from "@/lib/mcp";
import type { ConnectorToolRoute } from "@/lib/tools/connector-tools";
import type { ChatToolPlan } from "@/lib/tools/entitlements";
import { MAX_CHAT_FUNCTION_TOOLS, openChatToolset } from "@/lib/tools/toolset";
import type { NativeChatTool, ToolContext } from "@/lib/tools/types";
import type { ConnectorFailure } from "@/types/run";

/*
 * `openChatToolset` (SPEC §3.7): Juno's tools first in registry order, then
 * the connectors' (sorted by mcp.ts), then the native tools, cut at 64; a
 * connector that fails, or MCP failing to open at all, never takes Juno's or
 * the native tools with it (RC-3). Replaces unified-agent-runtime.test.ts once
 * the old runtime goes (WS9a).
 */

const context = {
  userId: "u1",
  conversationId: "c1",
  projectId: null,
  generationId: "gen-1",
  private: false,
  plan: "PRO",
  citationsNumbered: false,
  sources: {} as ToolContext["sources"],
  ledger: null,
  taint: {} as ToolContext["taint"],
  limits: {} as ToolContext["limits"],
  attachments: async () => [],
} satisfies Omit<ToolContext, "callId" | "round" | "signal" | "onApprovalRequest">;

const mcpContext: McpToolsetContext = { userId: "u1", conversationId: "c1", surface: "chat", sessionId: "gen-1" };

function plan(overrides: Partial<ChatToolPlan> = {}): ChatToolPlan {
  return {
    juno: ["web_fetch", "current_time", "calculate", "start_task"],
    nativeSearch: false,
    connectors: true,
    suggestResearch: false,
    roundBudget: 10,
    notices: [],
    citationStyle: "links",
    ...overrides,
  };
}

const connector = (id: string, label = id): ActiveConnector => ({ id, label, mcpUrl: `https://${id}.example/mcp`, headers: {} });

interface FakeMcp {
  toolset: McpToolset;
  closed: number;
  calls: Array<{ name: string; callId?: string; opts?: ToolExecuteOptions }>;
}

/** An `openMcpToolset` stand-in: tools per connector, statuses as a server would give them. */
function fakeOpenMcp(
  byConnector: Record<string, { tools?: string[]; state?: "ready" | ConnectorFailure }>,
  box: { fake?: FakeMcp; opts?: OpenMcpToolsetOptions },
) {
  return async (active: ActiveConnector[], _ctx: McpToolsetContext, opts?: OpenMcpToolsetOptions): Promise<McpToolset> => {
    box.opts = opts;
    const routes = new Map<string, ConnectorToolRoute>();
    const tools: McpFunctionTool[] = [];
    for (const c of [...active].sort((a, b) => a.id.localeCompare(b.id))) {
      const entry = byConnector[c.id] ?? {};
      opts?.onConnectorStatus?.(c.id, entry.state ?? "ready");
      if ((entry.state ?? "ready") !== "ready") continue;
      for (const toolName of entry.tools ?? []) {
        const name = `${c.id}__${toolName}`;
        routes.set(name, { functionName: name, connectorId: c.id, connectorLabel: c.label, toolName, annotations: { readOnlyHint: toolName.startsWith("list") } });
        tools.push({ type: "function", function: { name, parameters: { type: "object", properties: {} } } });
      }
    }
    const fake: FakeMcp = {
      closed: 0,
      calls: [],
      toolset: {
        tools,
        labelFor: (name) => routes.get(name)?.connectorLabel ?? "tool",
        accessFor: () => "read",
        route: (name) => routes.get(name),
        async execute(name, _args, _signal, callId, execOpts) {
          fake.calls.push({ name, callId, opts: execOpts });
          execOpts?.onApprovalRequest?.({ id: `card-${name}` } as ClientActionApproval);
          execOpts?.onAuthorized?.();
          return { text: "done", body: "done", ok: true };
        },
        async close() {
          fake.closed += 1;
        },
      },
    };
    box.fake = fake;
    return fake.toolset;
  };
}

function startTask(): NativeChatTool & { seen: Array<ToolExecuteOptions | undefined> } {
  const seen: Array<ToolExecuteOptions | undefined> = [];
  return {
    seen,
    tool: { type: "function", function: { name: "start_task", description: "Start a task.", parameters: { type: "object", properties: {} } } },
    label: "Task",
    access: "write",
    async execute(_args, _signal, opts) {
      seen.push(opts);
      opts?.onAuthorized?.();
      return { text: "started", body: "started", ok: true };
    },
  };
}

test("the toolset loads mcp.ts only when a connector is to be opened", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/tools/toolset.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  assert.doesNotMatch(source, /^import \{[^}]*\} from "@\/lib\/mcp";/m, "only types from mcp.ts, statically");
  assert.match(source, /await import\("@\/lib\/mcp"\)/);
  assert.equal(MAX_CHAT_FUNCTION_TOOLS, 64);
});

test("Juno's tools come first in registry order, then connectors, then native tools", async () => {
  const box: { fake?: FakeMcp; opts?: OpenMcpToolsetOptions } = {};
  const task = startTask();
  const toolset = await openChatToolset({
    plan: plan(),
    connectors: [connector("notion", "Notion"), connector("github", "GitHub")],
    skipped: [{ id: "linear", label: "Linear", reason: "not_linked" }],
    context,
    mcpContext,
    nativeTools: [task],
    order: ["notion", "linear", "github"],
    openMcp: fakeOpenMcp({ github: { tools: ["list_issues", "create_issue"] }, notion: { tools: ["search"] } }, box),
  });
  assert.deepEqual(toolset.tools.map((t) => t.function.name), [
    "web_fetch", "current_time", "calculate", "start_task",
    "github__list_issues", "github__create_issue", "notion__search",
  ]);
  assert.equal(box.opts?.connectTimeoutMs, 10_000, "chat bounds each connector's connect");
  // Juno tools say which they are, for the adapters; the annotations never reach the wire.
  assert.equal(toolset.tools[0].annotations?.junoCanonical, "web_fetch");
  assert.deepEqual(toolset.connectors, [
    { id: "notion", label: "Notion", state: "ready", tools: 1 },
    { id: "linear", label: "Linear", state: "not_linked", tools: 0 },
    { id: "github", label: "GitHub", state: "ready", tools: 2 },
  ]);

  const fetchTool = toolset.resolve("web_fetch")!;
  assert.equal(fetchTool.origin, "juno");
  assert.equal(fetchTool.spec?.id, "web_fetch", "the dispatcher runs Juno specs itself");
  const task0 = toolset.resolve("start_task")!;
  assert.equal(task0.spec, undefined, "start_task runs through its native tool, which authorises itself");
  assert.equal(task0.risk, "external");
  const issue = toolset.resolve("github__create_issue")!;
  assert.deepEqual([issue.origin, issue.canonical, issue.risk, issue.connectorLabel], ["connector", "mcp", "external", "GitHub"]);
  assert.equal(toolset.resolve("github__list_issues")!.risk, "read");
  assert.equal(toolset.labelFor("github__list_issues"), "GitHub");
  assert.equal(toolset.labelFor("current_time"), "Current time");
  await toolset.close();
  assert.equal(box.fake?.closed, 1, "close() closes the connector clients");
});

test("a connector that fails to connect fails alone, with its reason", async () => {
  const box: { fake?: FakeMcp } = {};
  const toolset = await openChatToolset({
    plan: plan(),
    connectors: [connector("github"), connector("figma")],
    skipped: [],
    context,
    mcpContext,
    nativeTools: [],
    openMcp: fakeOpenMcp({ github: { tools: ["list_issues"] }, figma: { state: "auth_expired" } }, box),
  });
  assert.deepEqual(toolset.connectors.map((c) => [c.id, c.state, c.tools]), [["github", "ready", 1], ["figma", "auth_expired", 0]]);
  assert.ok(toolset.tools.some((t) => t.function.name === "github__list_issues"));
});

test("MCP failing to open at all keeps Juno's and the native tools (RC-3)", async () => {
  const task = startTask();
  const toolset = await openChatToolset({
    plan: plan(),
    connectors: [connector("github")],
    skipped: [],
    context,
    mcpContext,
    nativeTools: [task],
    openMcp: async () => {
      throw new Error("MCP SDK exploded");
    },
  });
  assert.deepEqual(toolset.tools.map((t) => t.function.name), ["web_fetch", "current_time", "calculate", "start_task"]);
  assert.deepEqual(toolset.connectors, [{ id: "github", label: "github", state: "unreachable", tools: 0 }]);
  await toolset.close();
});

test("a private chat opens no connectors", async () => {
  let opened = 0;
  const toolset = await openChatToolset({
    plan: plan({ connectors: false, juno: ["current_time", "calculate"] }),
    connectors: [],
    skipped: [],
    context: { ...context, private: true, conversationId: null },
    mcpContext: null,
    nativeTools: [],
    openMcp: async () => {
      opened += 1;
      throw new Error("never");
    },
  });
  assert.equal(opened, 0);
  assert.deepEqual(toolset.tools.map((t) => t.function.name), ["current_time", "calculate"]);
});

test("the 64-tool cap keeps Juno's tools and says how many were dropped", async () => {
  const many = Array.from({ length: 70 }, (_, i) => `list_${String(i).padStart(2, "0")}`);
  const toolset = await openChatToolset({
    plan: plan(),
    connectors: [connector("big")],
    skipped: [],
    context,
    mcpContext,
    nativeTools: [startTask()],
    openMcp: fakeOpenMcp({ big: { tools: many } }, {}),
  });
  assert.equal(toolset.tools.length, 64);
  assert.deepEqual(toolset.tools.slice(0, 4).map((t) => t.function.name), ["web_fetch", "current_time", "calculate", "start_task"]);
  assert.deepEqual(toolset.notices, [{ code: "tools_capped", params: { dropped: 10 } }]);
  assert.equal(toolset.connectors[0].tools, 60);
  assert.equal(toolset.resolve("big__list_69"), undefined, "a dropped tool cannot be called either");

  // A model's own lower cap wins.
  const small = await openChatToolset({
    plan: plan(),
    connectors: [],
    skipped: [],
    context,
    mcpContext,
    nativeTools: [],
    maxTools: 2,
  });
  assert.equal(small.tools.length, 2);
  assert.deepEqual(small.notices, [{ code: "tools_capped", params: { dropped: 1 } }]);
});

test("per-call approvals, the timer and onAuthorized reach the connector and the native tool", async () => {
  const box: { fake?: FakeMcp } = {};
  const task = startTask();
  const toolset = await openChatToolset({
    plan: plan(),
    connectors: [connector("github")],
    skipped: [],
    context,
    mcpContext,
    nativeTools: [task],
    openMcp: fakeOpenMcp({ github: { tools: ["create_issue"] } }, box),
  });
  const cards: string[] = [];
  let authorized = 0;
  const opts: ToolExecuteOptions = { onApprovalRequest: (a) => cards.push(a.id), timeoutMs: 60_000, onAuthorized: () => (authorized += 1) };
  await toolset.execute("github__create_issue", { title: "x" }, new AbortController().signal, "call-1", opts);
  assert.deepEqual(box.fake?.calls.map((c) => [c.name, c.callId, c.opts?.timeoutMs]), [["github__create_issue", "call-1", 60_000]]);
  assert.deepEqual(cards, ["card-github__create_issue"]);
  await toolset.execute("start_task", { title: "t", goal: "g" }, new AbortController().signal, "call-2", opts);
  assert.equal(task.seen[0]?.timeoutMs, 60_000);
  assert.equal(authorized, 2);
});

test("a pure tool can run from any path; a brokered Juno tool only through the dispatcher", async () => {
  const toolset = await openChatToolset({
    plan: plan(),
    connectors: [],
    skipped: [],
    context,
    mcpContext: null,
    nativeTools: [],
  });
  const calc = await toolset.execute("calculate", { expression: "6*7" }, new AbortController().signal, "c1");
  assert.equal(calc.ok, true);
  assert.match(calc.text, /^= 42/);
  const fetched = await toolset.execute("web_fetch", { url: "https://example.com/" }, new AbortController().signal, "c2");
  assert.equal(fetched.ok, false, "no broker on this path, so it fails closed");
  assert.equal(fetched.error?.code, "not_permitted");
  const unknown = await toolset.execute("teleport", {}, new AbortController().signal, "c3");
  assert.equal(unknown.error?.code, "unknown_tool");
});

test("start_task is offered only with a native tool and only when the plan entitles it", async () => {
  const without = await openChatToolset({ plan: plan(), connectors: [], skipped: [], context, mcpContext: null, nativeTools: [] });
  assert.ok(!without.tools.some((t) => t.function.name === "start_task"));
  const notEntitled = await openChatToolset({
    plan: plan({ juno: ["current_time"] }),
    connectors: [],
    skipped: [],
    context,
    mcpContext: null,
    nativeTools: [startTask()],
  });
  assert.deepEqual(notEntitled.tools.map((t) => t.function.name), ["current_time"]);
});
