/**
 * The Agents tree's model (REA backlog 10): a run's agents as a tree, each
 * node with a live state, its current step, its clock and its spend against
 * its budget; and the keyboard rules of the ARIA tree that shows it.
 *
 * Pure: derived from the thread's items on every render, so it is exactly as
 * live as the session stream that feeds them (the device link's long poll or
 * the Mac's socket); nothing here polls.
 */
import type { ApprovalRequestItem, SubagentItem, TurnItem } from "./contracts";
import { TEAM_PHASE_VALUES } from "./contracts";

/** What a node is doing, in the tree's own vocabulary. */
export type AgentNodeState = "thinking" | "tool" | "waiting" | "queued" | "paused" | "done" | "failed" | "stopped";

export const AGENT_NODE_STATE_LABEL: Record<AgentNodeState, string> = {
  thinking: "Thinking",
  tool: "Using a tool",
  waiting: "Needs you",
  queued: "Waiting to start",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export const LEAD_NODE_ID = "lead";

export interface AgentTreeNode {
  /** `LEAD_NODE_ID` for the root, else the agent id. */
  id: string;
  agent?: SubagentItem;
  label: string;
  state: AgentNodeState;
  /** The current step, in a sentence. */
  step: string;
  /** ISO start, for a live clock while it runs. */
  startedAt?: string;
  /** Settled duration, when the engine sent one. */
  elapsedMs?: number;
  tokens?: number;
  tokenBudget?: number;
  costUsd?: number;
  /** Root only: the run's dollar budget. */
  budgetUsd?: number;
  children: AgentTreeNode[];
  depth: number;
}

export const isLive = (state: AgentNodeState) => state === "thinking" || state === "tool" || state === "waiting" || state === "queued" || state === "paused";

/** Newest snapshot per agent (an agent is re-sent as it changes). */
export function latestAgentItems(items: readonly TurnItem[]): SubagentItem[] {
  const by = new Map<string, SubagentItem>();
  for (const i of items) if (i.kind === "subagent") by.set(i.agentId, i);
  return [...by.values()];
}

type ToolItem = Extract<TurnItem, { kind: "command_execution" | "file_change" | "search" | "web_search" | "computer_action" }>;

function runningTool(items: readonly TurnItem[], agentId: string | undefined): ToolItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.agentId !== agentId) continue;
    if ((it.kind === "command_execution" || it.kind === "file_change" || it.kind === "search" || it.kind === "web_search" || it.kind === "computer_action") && it.status === "running") return it;
  }
  return undefined;
}

function pendingApproval(items: readonly TurnItem[], agentId: string | undefined): ApprovalRequestItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "approval_request" && it.status === "pending" && it.agentId === agentId) return it;
  }
  return undefined;
}

/** A running tool call in a few words. */
export function toolStep(item: ToolItem): string {
  switch (item.kind) {
    case "command_execution":
      return `Running ${item.command.split("\n")[0]!.slice(0, 120)}`;
    case "file_change": {
      const path = item.changes[0]?.path;
      return path ? `Editing ${path}` : "Editing files";
    }
    case "search":
      return `Searching ${item.query.slice(0, 120)}`;
    case "web_search":
      return `Searching the web for ${item.query.slice(0, 120)}`;
    case "computer_action":
      return item.summary ?? "Using the computer";
  }
}

export function agentNodeState(agent: SubagentItem, items: readonly TurnItem[]): { state: AgentNodeState; step: string } {
  const firstLine = (s: string | undefined) => s?.split("\n").find((l) => l.trim())?.trim();
  if (agent.status === "completed") return { state: "done", step: firstLine(agent.closingText) ?? agent.title ?? "Done" };
  if (agent.status === "failed") return { state: "failed", step: agent.liveLine ? `Failed: ${agent.liveLine}` : "Failed" };
  if (agent.status === "interrupted") return { state: "stopped", step: "Stopped" };
  const approval = pendingApproval(items, agent.agentId);
  if (approval) return { state: "waiting", step: approval.summary || "Waiting for your approval" };
  if (agent.paused) return { state: "paused", step: agent.liveLine && agent.liveLine !== "Paused" ? `Paused after: ${agent.liveLine}` : "Paused" };
  if (agent.status === "waiting") return { state: "queued", step: agent.liveLine ?? "Waiting to start" };
  const tool = runningTool(items, agent.agentId);
  if (tool) return { state: "tool", step: toolStep(tool) };
  return { state: "thinking", step: agent.liveLine ?? agent.title ?? "Thinking" };
}

export function agentLabel(agent: SubagentItem): string {
  return agent.label ?? agent.title ?? agent.task?.split("\n")[0]?.slice(0, 80) ?? "Agent";
}

const phaseRank = (a: SubagentItem) => (a.phase ? TEAM_PHASE_VALUES.indexOf(a.phase) : TEAM_PHASE_VALUES.length);

export interface LeadInput {
  /** The run is going: the lead is working. */
  running: boolean;
  /** The lead itself is waiting on an approval. */
  label?: string;
  budgetUsd?: number;
}

/**
 * The run as a tree: the lead at the root, each agent under the agent that
 * started it (`parentAgentId`), or under the lead. Plan → Build → Verify
 * phases first, then the order they started in.
 */
export function buildAgentTree(items: readonly TurnItem[], lead: LeadInput): AgentTreeNode {
  const agents = latestAgentItems(items)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => phaseRank(x.a) - phaseRank(y.a) || x.i - y.i)
    .map((x) => x.a);
  const known = new Set(agents.map((a) => a.agentId));
  const nodes = new Map<string, AgentTreeNode>();
  for (const agent of agents) {
    const { state, step } = agentNodeState(agent, items);
    const tokens = agent.tokens ? agent.tokens.input + agent.tokens.output : undefined;
    nodes.set(agent.agentId, {
      id: agent.agentId,
      agent,
      label: agentLabel(agent),
      state,
      step,
      startedAt: agent.createdAt,
      ...(agent.elapsedMs !== undefined ? { elapsedMs: agent.elapsedMs } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(agent.tokenBudget !== undefined ? { tokenBudget: agent.tokenBudget } : {}),
      ...(agent.costUsd !== undefined ? { costUsd: agent.costUsd } : {}),
      children: [],
      depth: 1,
    });
  }
  const leadApproval = pendingApproval(items, undefined);
  const leadTool = runningTool(items, undefined);
  const costs = agents.map((a) => a.costUsd).filter((c): c is number => c !== undefined);
  const root: AgentTreeNode = {
    id: LEAD_NODE_ID,
    label: lead.label ?? "Lead",
    state: !lead.running ? "done" : leadApproval ? "waiting" : leadTool ? "tool" : "thinking",
    step: !lead.running
      ? agents.length ? `Ran ${agents.length} ${agents.length === 1 ? "agent" : "agents"}` : "Idle"
      : leadApproval ? leadApproval.summary || "Waiting for your approval" : leadTool ? toolStep(leadTool) : `Coordinating ${agents.length} ${agents.length === 1 ? "agent" : "agents"}`,
    ...(costs.length ? { costUsd: costs.reduce((a, b) => a + b, 0) } : {}),
    ...(lead.budgetUsd !== undefined ? { budgetUsd: lead.budgetUsd } : {}),
    children: [],
    depth: 0,
  };
  for (const agent of agents) {
    const node = nodes.get(agent.agentId)!;
    const parentId = agent.parentAgentId && agent.parentAgentId !== agent.agentId && known.has(agent.parentAgentId) ? agent.parentAgentId : null;
    const parent = parentId ? nodes.get(parentId)! : root;
    // A cycle in what the engine sent can never hang the tree: an agent that is its own ancestor goes under the lead.
    if (parent !== root && isAncestor(node, parent)) root.children.push(node);
    else parent.children.push(node);
  }
  setDepth(root, 0);
  return root;
}

function isAncestor(candidate: AgentTreeNode, of: AgentTreeNode): boolean {
  const stack = [...candidate.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === of) return true;
    stack.push(...n.children);
  }
  return false;
}

function setDepth(node: AgentTreeNode, depth: number) {
  node.depth = depth;
  for (const c of node.children) setDepth(c, depth + 1);
}

export function findNode(root: AgentTreeNode, id: string): AgentTreeNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}

export function countLive(root: AgentTreeNode): { live: number; waiting: number; paused: number; total: number } {
  const out = { live: 0, waiting: 0, paused: 0, total: 0 };
  const walk = (n: AgentTreeNode) => {
    for (const c of n.children) {
      out.total += 1;
      if (isLive(c.state)) out.live += 1;
      if (c.state === "waiting") out.waiting += 1;
      if (c.state === "paused") out.paused += 1;
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** Spend against a budget as a 0…1 fraction, or null when there is no budget to measure against. */
export function budgetFraction(used: number | undefined, budget: number | undefined): number | null {
  if (used === undefined || budget === undefined || !(budget > 0)) return null;
  return Math.max(0, Math.min(1, used / budget));
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

// ── Keyboard (WAI-ARIA tree view pattern) ─────────────────────────────────

export interface VisibleRow {
  id: string;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
}

/** The rows a reader can reach, in order: a collapsed node hides its subtree. */
export function visibleRows(root: AgentTreeNode, expanded: ReadonlySet<string>): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (n: AgentTreeNode, parentId: string | null) => {
    out.push({ id: n.id, depth: n.depth, parentId, hasChildren: n.children.length > 0 });
    if (n.children.length && expanded.has(n.id)) for (const c of n.children) walk(c, n.id);
  };
  walk(root, null);
  return out;
}

export type TreeKeyEffect =
  | { kind: "focus"; id: string }
  | { kind: "expand"; id: string }
  | { kind: "collapse"; id: string }
  | { kind: "select"; id: string }
  | { kind: "expand-siblings"; ids: string[] }
  | { kind: "none" };

/**
 * What a key does on the focused row: Up/Down move, Home/End jump, Right
 * opens a closed node or steps into an open one, Left closes an open node or
 * steps out to its parent, Enter/Space select, `*` opens every sibling.
 */
export function treeKey(key: string, focusedId: string, rows: readonly VisibleRow[], expanded: ReadonlySet<string>): TreeKeyEffect {
  const i = rows.findIndex((r) => r.id === focusedId);
  if (i < 0) return rows[0] ? { kind: "focus", id: rows[0].id } : { kind: "none" };
  const row = rows[i]!;
  switch (key) {
    case "ArrowDown":
      return i + 1 < rows.length ? { kind: "focus", id: rows[i + 1]!.id } : { kind: "none" };
    case "ArrowUp":
      return i > 0 ? { kind: "focus", id: rows[i - 1]!.id } : { kind: "none" };
    case "Home":
      return { kind: "focus", id: rows[0]!.id };
    case "End":
      return { kind: "focus", id: rows[rows.length - 1]!.id };
    case "ArrowRight":
      if (!row.hasChildren) return { kind: "none" };
      if (!expanded.has(row.id)) return { kind: "expand", id: row.id };
      return rows[i + 1] && rows[i + 1]!.parentId === row.id ? { kind: "focus", id: rows[i + 1]!.id } : { kind: "none" };
    case "ArrowLeft":
      if (row.hasChildren && expanded.has(row.id)) return { kind: "collapse", id: row.id };
      return row.parentId ? { kind: "focus", id: row.parentId } : { kind: "none" };
    case "Enter":
    case " ":
      return { kind: "select", id: row.id };
    case "*": {
      const ids = rows.filter((r) => r.parentId === row.parentId && r.hasChildren && !expanded.has(r.id)).map((r) => r.id);
      return ids.length ? { kind: "expand-siblings", ids } : { kind: "none" };
    }
    default:
      return { kind: "none" };
  }
}
