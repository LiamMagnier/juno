/**
 * The web Agents tree (REA backlog 10): its model (agent-tree.ts), its
 * keyboard rules, the browser's control client, and the rendered pane over
 * the dev gallery's fixtures (ARIA tree roles, states in words, controls).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsTreePane } from "@/components/code/v2/agents-tree";
import { CodeWorkspace } from "@/components/code/v2/workspace";
import { AGENT_NODE_STATE_LABEL, LEAD_NODE_ID, buildAgentTree, countLive, findNode, treeKey, visibleRows } from "@/lib/code-v2/agent-tree";
import { sendAgentControl, type AgentControlTransport } from "@/lib/code-v2/agent-control-client";
import type { SubagentItem, TurnItem } from "@/lib/code-v2/contracts";
import { STATES, makeActions } from "../src/app/dev/code-v2/fixtures";

(globalThis as unknown as { React: typeof React }).React = React;

const at = "2026-10-18T12:00:00.000Z";
const agent = (over: Partial<SubagentItem> & { agentId: string }): SubagentItem => ({
  id: `item-${over.agentId}`,
  kind: "subagent",
  createdAt: at,
  role: "worker",
  model: { instanceId: "alevr", model: "anthropic:claude-sonnet-5-5" },
  status: "running",
  ...over,
});

test("tree: agents nest under the agent that started them, and each state is read from the thread", () => {
  const items: TurnItem[] = [
    agent({ agentId: "a", label: "Builder 1", liveLine: "Thinking about totals", tokens: { input: 1_000, output: 500 }, tokenBudget: 400_000 }),
    agent({ agentId: "b", label: "Builder 2" }),
    agent({ agentId: "c", label: "Helper", parentAgentId: "a", paused: true }),
    agent({ agentId: "d", label: "Reviewer", status: "completed", closingText: "Looks right.\nMore detail." }),
    agent({ agentId: "e", label: "Late", status: "waiting" }),
    agent({ agentId: "f", label: "Broken", status: "failed", liveLine: "tests failed" }),
    agent({ agentId: "g", label: "Halted", status: "interrupted" }),
    agent({ agentId: "loop", label: "Orphan", parentAgentId: "nobody" }),
    { id: "x1", kind: "command_execution", callId: "c1", agentId: "b", command: "pnpm test\n--watch", status: "running", createdAt: at },
    { id: "ap", kind: "approval_request", callId: "c2", requestId: "r1", action: "command", summary: "rm -rf dist", status: "pending", agentId: "e", createdAt: at },
  ];
  const root = buildAgentTree(items, { running: true, budgetUsd: 4 });
  assert.equal(root.id, LEAD_NODE_ID);
  assert.deepEqual(root.children.map((c) => c.id), ["a", "b", "d", "e", "f", "g", "loop"], "an unknown parent falls back to the lead");
  const a = findNode(root, "a")!;
  assert.deepEqual(a.children.map((c) => c.id), ["c"]);
  assert.equal(findNode(root, "c")!.depth, 2);
  assert.equal(a.state, "thinking");
  assert.equal(a.tokens, 1_500);
  assert.equal(a.tokenBudget, 400_000);
  assert.equal(findNode(root, "b")!.state, "tool");
  assert.equal(findNode(root, "b")!.step, "Running pnpm test", "the command's first line");
  assert.equal(findNode(root, "c")!.state, "paused");
  assert.equal(findNode(root, "d")!.state, "done");
  assert.equal(findNode(root, "d")!.step, "Looks right.");
  assert.equal(findNode(root, "e")!.state, "waiting", "a pending approval is needs-you, whatever the status says");
  assert.equal(findNode(root, "e")!.step, "rm -rf dist");
  assert.equal(findNode(root, "f")!.state, "failed");
  assert.equal(findNode(root, "g")!.state, "stopped");
  assert.equal(root.state, "thinking");
  assert.match(root.step, /Coordinating 8 agents/);
  const counts = countLive(root);
  assert.deepEqual(counts, { live: 5, waiting: 1, paused: 1, total: 8 });
  for (const s of Object.keys(AGENT_NODE_STATE_LABEL)) assert.ok(AGENT_NODE_STATE_LABEL[s as keyof typeof AGENT_NODE_STATE_LABEL]);

  // Cycles in what the engine sent never hang the tree.
  const cyclic = buildAgentTree([agent({ agentId: "x", parentAgentId: "y" }), agent({ agentId: "y", parentAgentId: "x" })], { running: false });
  assert.equal(cyclic.state, "done");
  const ids: string[] = [];
  const walk = (n: typeof cyclic) => n.children.forEach((c) => (ids.push(c.id), walk(c)));
  walk(cyclic);
  assert.deepEqual(ids.sort(), ["x", "y"]);
});

test("keyboard: the WAI-ARIA tree view keys", () => {
  const root = buildAgentTree([agent({ agentId: "a" }), agent({ agentId: "c", parentAgentId: "a" }), agent({ agentId: "b" })], { running: true });
  const all = new Set([LEAD_NODE_ID, "a"]);
  const rows = visibleRows(root, all);
  assert.deepEqual(rows.map((r) => r.id), [LEAD_NODE_ID, "a", "c", "b"]);
  assert.deepEqual(treeKey("ArrowDown", "a", rows, all), { kind: "focus", id: "c" });
  assert.deepEqual(treeKey("ArrowUp", "a", rows, all), { kind: "focus", id: LEAD_NODE_ID });
  assert.deepEqual(treeKey("End", "a", rows, all), { kind: "focus", id: "b" });
  assert.deepEqual(treeKey("Home", "b", rows, all), { kind: "focus", id: LEAD_NODE_ID });
  assert.deepEqual(treeKey("ArrowRight", "a", rows, all), { kind: "focus", id: "c" }, "into an open node");
  assert.deepEqual(treeKey("ArrowLeft", "a", rows, all), { kind: "collapse", id: "a" });
  assert.deepEqual(treeKey("ArrowLeft", "c", rows, all), { kind: "focus", id: "a" }, "out to the parent");
  assert.deepEqual(treeKey("Enter", "c", rows, all), { kind: "select", id: "c" });
  assert.deepEqual(treeKey(" ", "c", rows, all), { kind: "select", id: "c" });
  const folded = new Set([LEAD_NODE_ID]);
  const fewer = visibleRows(root, folded);
  assert.deepEqual(fewer.map((r) => r.id), [LEAD_NODE_ID, "a", "b"], "a closed node hides its subtree");
  assert.deepEqual(treeKey("ArrowRight", "a", fewer, folded), { kind: "expand", id: "a" });
  assert.deepEqual(treeKey("*", "b", fewer, folded), { kind: "expand-siblings", ids: ["a"] });
  assert.deepEqual(treeKey("ArrowDown", "b", fewer, folded), { kind: "none" });
  assert.deepEqual(treeKey("x", "b", fewer, folded), { kind: "none" });
});

const fixture = (id: string) => {
  const s = STATES.find((x) => x.id === id);
  assert.ok(s, id);
  return { ...s, model: { ...s.model, actions: makeActions(() => undefined) } };
};

test("pane: an ARIA tree with levels, states in words, and the selected agent's controls", () => {
  const f = fixture("subagents");
  const html = renderToStaticMarkup(React.createElement(AgentsTreePane, { model: f.model, selectedId: "w2", onSelect: () => undefined, modelLabel: (s) => s.model }));
  assert.match(html, /role="tree"[^>]*aria-label="Agents in this run"/);
  assert.match(html, /role="treeitem"[^>]*aria-level="1"/);
  assert.match(html, /role="group"/);
  // The nested helper sits at level 3 under Worker 2, paused, and says so in words.
  assert.match(html, /aria-level="3"[^>]*aria-label="Hook audit, Paused, 10K \/ 400K tokens"/);
  assert.match(html, /aria-label="Worker 3, Using a tool, Running pnpm test --filter cart/);
  // Roving focus: exactly one row is in the tab order.
  assert.equal(html.match(/role="treeitem"[^>]*tabindex="0"/g)?.length, 1);
  assert.match(html, /aria-selected="true"[^>]*aria-label="Worker 2/);
  // The detail: live controls and the steer box for a running agent.
  assert.match(html, /role="toolbar" aria-label="Agent controls"/);
  assert.match(html, />Pause</);
  assert.match(html, />Stop</);
  assert.match(html, />Top up</);
  assert.match(html, /aria-label="Steer Worker 2"/);
  assert.match(html, /role="meter"[^>]*aria-label="Token budget used"/);
  assert.match(html, /role="status" aria-live="polite"/);
});

test("pane: the lead offers run controls, and a reader without controls sees no buttons", () => {
  const f = fixture("subagents");
  const lead = renderToStaticMarkup(React.createElement(AgentsTreePane, { model: f.model, selectedId: null, onSelect: () => undefined, modelLabel: (s) => s.model }));
  assert.match(lead, /role="toolbar" aria-label="Run controls"/);
  assert.match(lead, />Pause all</);
  assert.match(lead, />Stop run</);
  assert.match(lead, /The lead&#x27;s own work is in the thread/);
  assert.match(lead, /Run budget used/);

  const readOnly = { ...f.model, actions: { ...f.model.actions, controlAgent: undefined } };
  const html = renderToStaticMarkup(React.createElement(AgentsTreePane, { model: readOnly, selectedId: "w2", onSelect: () => undefined, modelLabel: (s) => s.model }));
  assert.doesNotMatch(html, /role="toolbar"/);
  assert.doesNotMatch(html, /Steer Worker 2/);
});

test("workspace: the Agents dock shows the tree for a delegated run and keeps Best of N's compare", () => {
  const sub = fixture("subagents");
  assert.match(renderToStaticMarkup(React.createElement(CodeWorkspace, { model: sub.model, ui: sub.ui })), /role="tree"/);
  const best = fixture("best-of-n");
  const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: best.model, ui: best.ui }));
  assert.doesNotMatch(html, /role="tree"/);
});

test("client: over the hosted link a press posts once with its key and retries a lost answer under the same key", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const statuses = [503, 200];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const status = statuses.shift()!;
    return new Response(JSON.stringify(status === 200 ? { accepted: true, message: "Agent w1 resumed." } : { message: "Your Mac did not answer in time." }), { status });
  };
  const transport: AgentControlTransport = { linkDeviceId: "mac 1", request: async () => { throw new Error("not the socket"); } };
  const result = await sendAgentControl(transport, { sessionId: "s1", agentId: "w1", action: "resume" }, { fetcher, key: "agent-control:k1" });
  assert.equal(result.accepted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "/api/code/v2/link/mac%201/agents");
  assert.equal(calls[0]!.body.idempotencyKey, "agent-control:k1");
  assert.equal(calls[1]!.body.idempotencyKey, "agent-control:k1");

  // A refusal is an error with the server's words, never retried.
  const refuse = async () => new Response(JSON.stringify({ error: "Too many top-ups this hour." }), { status: 429 });
  await assert.rejects(sendAgentControl(transport, { sessionId: "s1", agentId: "w1", action: "top_up", tokens: 100_000 }, { fetcher: refuse }), /Too many top-ups/);
});

test("client: on a direct socket the key rides as the env server's request id", async () => {
  const sent: { type: string; params: Record<string, unknown> }[] = [];
  const transport: AgentControlTransport = {
    linkDeviceId: null,
    request: (async (type: string, params: Record<string, unknown>) => {
      sent.push({ type, params });
      return { accepted: true };
    }) as AgentControlTransport["request"],
  };
  await sendAgentControl(transport, { sessionId: "s1", action: "pause" }, { key: "agent-control:k2" });
  await sendAgentControl(transport, { sessionId: "s1", agentId: "w1", action: "steer", text: "Only the route." }, { key: "agent-control:k3" });
  await sendAgentControl(transport, { sessionId: "s1", action: "stop" }, { key: "agent-control:k4" });
  assert.deepEqual(sent, [
    { type: "agent.pause", params: { sessionId: "s1", requestId: "agent-control:k2" } },
    { type: "agent.message", params: { sessionId: "s1", agentId: "w1", text: "Only the route.", requestId: "agent-control:k3" } },
    { type: "turn.interrupt", params: { sessionId: "s1" } },
  ]);
});
