/**
 * Today's CodeTask path (useCodeSession: persisted messages, activity rows,
 * delegated agents, file changes, one pending approval / question / plan)
 * folded into normalized `TurnItem`s, so the v2 workspace renders every
 * existing Code session — and live device runs on older Mac builds — with the
 * same components the env-server path uses.
 *
 * Pure and structurally typed (no imports from hooks), so it is testable.
 */
import type {
  ItemStatus,
  SessionState,
  SubagentItem,
  SubagentStatus,
  TurnItem,
} from "@/lib/code-v2/contracts";

export interface LegacyActivityRow {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  createdAt: string;
  patch?: string;
  exitCode?: number;
  toolStatus?: string;
}

export interface LegacyMessage {
  id: string;
  role: string;
  content: string;
  reasoning?: string | null;
  createdAt: string;
  model?: string | null;
  attachments?: { id: string; name?: string; filename?: string; mimeType?: string; mediaType?: string }[];
  activity?: LegacyActivityRow[];
  pending?: boolean;
  streaming?: boolean;
}

export interface LegacyAgent {
  id: string;
  title: string;
  role: string;
  model?: string;
  status: string;
  currentActivity?: string;
  summary?: string;
  error?: string;
  filesChanged?: string[];
  worktreeBranch?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LegacyApproval {
  requestId: string;
  summary: string;
  risk: string;
  detail: string | null;
}

export interface LegacyQuestion {
  questionId: string;
  prompt: string;
  options?: { id: string; label: string }[];
  multiSelect?: boolean;
}

export interface LegacyPlan {
  planId: string;
  text: string;
}

export interface LegacyFileChange {
  path: string;
  changeKind: string;
  added: number;
  removed: number;
  patch: string | null;
}

export interface LegacySessionInput {
  messages: readonly LegacyMessage[];
  /** useCodeSession's status. */
  status: string;
  pendingApproval?: LegacyApproval | null;
  pendingQuestion?: LegacyQuestion | null;
  pendingPlan?: LegacyPlan | null;
  agents?: readonly LegacyAgent[];
  fileChanges?: readonly LegacyFileChange[];
  /** Instance + model the session runs on, for subagent model labels. */
  instanceId?: string;
}

export interface LegacySessionOutput {
  items: TurnItem[];
  state: SessionState;
}

const COMMAND_TOOL = /^(bash|shell|run|exec|terminal|command|ran\b|running\b|\$ )/i;
const READ_TOOL = /^(read|view|open|cat|list|ls|glob|grep|search|find)\b/i;

function toolStatus(row: LegacyActivityRow): ItemStatus {
  switch (row.toolStatus) {
    case "running":
      return "running";
    case "ok":
      return "completed";
    case "error":
      return "failed";
    case "denied":
      return "declined";
    case "not_executed":
      return "interrupted";
    default:
      return row.exitCode !== undefined && row.exitCode !== 0 ? "failed" : "completed";
  }
}

function stripVerb(title: string): string {
  return title.replace(/^(ran|running|run|bash|shell|exec)[:\s]+/i, "").replace(/^`(.+)`$/, "$1").trim();
}

function parseCounts(detail?: string): { additions: number; deletions: number } {
  const m = /\+(\d+)\s*[−-](\d+)/.exec(detail ?? "");
  return m ? { additions: Number(m[1]), deletions: Number(m[2]) } : { additions: 0, deletions: 0 };
}

function changeOf(word: string): "add" | "modify" | "delete" | "rename" {
  if (/^creat/i.test(word)) return "add";
  if (/^delet/i.test(word)) return "delete";
  if (/^mov|^renam/i.test(word)) return "rename";
  return "modify";
}

/** One activity row as a turn item (null for rows the v2 thread does not draw). */
export function activityToItem(row: LegacyActivityRow, turnId: string): TurnItem | null {
  const base = { id: row.id, turnId, createdAt: row.createdAt || new Date(0).toISOString() };
  switch (row.kind) {
    case "write": {
      const m = /^(\w+)\s+(.+)$/.exec(row.title);
      const counts = parseCounts(row.detail);
      return {
        ...base,
        kind: "file_change",
        callId: row.id,
        status: "completed",
        changes: [{ path: m ? m[2] : row.title, change: changeOf(m?.[1] ?? "edit"), diff: row.patch, ...counts }],
      };
    }
    case "reasoning":
      return { ...base, kind: "reasoning", text: row.detail ?? row.title, streaming: false, summary: true };
    case "search":
      return { ...base, kind: "web_search", callId: row.id, query: row.title, status: "completed" };
    case "visit":
      return { ...base, kind: "web_search", callId: row.id, query: row.title, status: "completed", results: row.detail ? [{ title: row.detail, url: row.detail }] : [] };
    case "warning":
      if (/^approval requested$/i.test(row.title)) return null; // the takeover / receipt carries it
      return { ...base, kind: "system_notice", level: "warning", text: row.detail ? `${row.title}. ${row.detail}` : row.title };
    case "tool": {
      if (/^context compacted$/i.test(row.title)) {
        return { ...base, kind: "compaction", beforeTokens: 0, afterTokens: 0, summary: row.detail };
      }
      if (/^agent\s/i.test(row.title)) return null; // subagents render from `agents`
      if (/^tests (passed|failed)$/i.test(row.title)) {
        return {
          ...base,
          kind: "command_execution",
          callId: row.id,
          command: row.detail ?? "tests",
          status: /passed/i.test(row.title) ? "completed" : "failed",
          exitCode: /passed/i.test(row.title) ? 0 : 1,
        };
      }
      if (READ_TOOL.test(row.title)) {
        return { ...base, kind: "search", callId: row.id, query: row.title.replace(READ_TOOL, "").trim() || row.title, scope: "files", status: toolStatus(row) };
      }
      if (COMMAND_TOOL.test(row.title) || row.exitCode !== undefined) {
        return {
          ...base,
          kind: "command_execution",
          callId: row.id,
          command: stripVerb(row.title),
          output: row.detail,
          exitCode: row.exitCode,
          status: toolStatus(row),
        };
      }
      return { ...base, kind: "command_execution", callId: row.id, command: row.title, output: row.detail, status: toolStatus(row) };
    }
    case "done":
      if (/^(allowed|approved)/i.test(row.title)) {
        return { ...base, kind: "approval_request", callId: row.id, requestId: row.id, action: "tool", summary: row.detail ?? row.title, status: "resolved", decision: "accept" };
      }
      return null;
    default:
      return null;
  }
}

function agentStatus(status: string): SubagentStatus {
  switch (status) {
    case "running":
    case "queued":
    case "starting":
      return "running";
    case "awaiting_approval":
    case "waiting":
    case "blocked":
      return "waiting";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "interrupted";
    default:
      return "completed";
  }
}

function agentRole(role: string): SubagentItem["role"] {
  const r = role.toLowerCase();
  if (r.includes("review")) return "reviewer";
  if (r.includes("explor") || r.includes("research")) return "explorer";
  return "worker";
}

export function agentToItem(agent: LegacyAgent, turnId: string, createdAt: string, index: number, instanceId = "alevr"): SubagentItem {
  const role = agentRole(agent.role);
  return {
    id: `agent-${agent.id}`,
    turnId,
    createdAt,
    kind: "subagent",
    agentId: agent.id,
    role,
    model: { instanceId, model: agent.model ?? "" },
    status: agentStatus(agent.status),
    title: agent.title,
    label: role === "worker" ? `Worker ${index + 1}` : role === "explorer" ? "Explorer" : "Reviewer",
    liveLine: agent.error ?? agent.currentActivity,
    closingText: agent.summary,
    worktreeBranch: agent.worktreeBranch,
    ...(agent.usage ? { tokens: { input: agent.usage.inputTokens, output: agent.usage.outputTokens } } : {}),
  };
}

export function legacyState(status: string): SessionState {
  switch (status) {
    case "awaiting_approval":
      return "waiting";
    case "submitting":
    case "queued":
    case "running":
    case "stopping":
      return "running";
    default:
      return "idle";
  }
}

/** Fold a CodeTask-path session into turn items plus a session state. */
export function legacyToItems(input: LegacySessionInput): LegacySessionOutput {
  const items: TurnItem[] = [];
  const state = legacyState(input.status);
  let turnId = "turn-0";
  const lastAssistantIndex = (() => {
    for (let i = input.messages.length - 1; i >= 0; i--) if (input.messages[i].role !== "USER") return i;
    return -1;
  })();

  input.messages.forEach((m, mi) => {
    if (m.role === "USER") {
      turnId = `turn-${m.id}`;
      items.push({
        id: m.id,
        turnId,
        kind: "user_message",
        text: m.content,
        createdAt: m.createdAt,
        delivery: "send",
        attachments: (m.attachments ?? []).map((a) => ({ name: a.name ?? a.filename ?? "attachment", mediaType: a.mediaType ?? a.mimeType ?? "application/octet-stream", ref: a.id })),
      });
      return;
    }
    if (m.reasoning && !(m.activity ?? []).some((r) => r.kind === "reasoning")) {
      items.push({ id: `${m.id}-reasoning`, turnId, kind: "reasoning", text: m.reasoning, streaming: false, summary: true, createdAt: m.createdAt });
    }
    for (const row of m.activity ?? []) {
      const item = activityToItem(row, turnId);
      if (item) items.push(item);
    }
    // Live subagents belong to the newest assistant turn.
    if (mi === lastAssistantIndex && input.agents?.length) {
      input.agents.forEach((a, i) => items.push(agentToItem(a, turnId, m.createdAt, i, input.instanceId)));
    }
    const live = mi === lastAssistantIndex && state === "running";
    if (m.content.trim() || live) {
      items.push({ id: `${m.id}-text`, turnId, kind: "assistant_message", text: m.content, streaming: live && !!m.streaming, createdAt: m.createdAt });
    }
  });

  // A live session whose assistant row has not arrived yet still shows its agents.
  if (lastAssistantIndex < 0 && input.agents?.length) {
    const at = input.messages[input.messages.length - 1]?.createdAt ?? new Date(0).toISOString();
    input.agents.forEach((a, i) => items.push(agentToItem(a, turnId, at, i, input.instanceId)));
  }

  // Session file changes carry patches the persisted rows lost: attach them to
  // the matching file_change entries (newest per path), so Changes has hunks.
  if (input.fileChanges?.length) {
    const byPath = new Map(input.fileChanges.map((f) => [f.path, f]));
    for (const item of items) {
      if (item.kind !== "file_change") continue;
      item.changes = item.changes.map((c) => {
        const f = byPath.get(c.path);
        return f ? { ...c, diff: c.diff ?? f.patch ?? undefined, additions: c.additions || f.added, deletions: c.deletions || f.removed } : c;
      });
    }
  }

  const now = input.messages[input.messages.length - 1]?.createdAt ?? new Date(0).toISOString();
  if (input.pendingApproval) {
    const a = input.pendingApproval;
    items.push({
      id: `approval-${a.requestId}`,
      turnId,
      kind: "approval_request",
      callId: a.requestId,
      requestId: a.requestId,
      action: /command|run|bash|\$/i.test(a.summary) ? "command" : a.risk === "outside" ? "permissions" : "tool",
      summary: a.summary,
      detail: a.detail ?? undefined,
      options: ["accept", "decline"],
      status: "pending",
      createdAt: now,
    });
  }
  if (input.pendingQuestion) {
    const q = input.pendingQuestion;
    items.push({
      id: `question-${q.questionId}`,
      turnId,
      kind: "user_input_request",
      requestId: q.questionId,
      questions: [{ id: q.questionId, prompt: q.prompt, options: q.options?.map((o) => o.label), multiSelect: q.multiSelect }],
      status: "pending",
      createdAt: now,
    });
  }
  if (input.pendingPlan) {
    items.push({ id: `plan-${input.pendingPlan.planId}`, turnId, kind: "plan", text: input.pendingPlan.text, awaitingApproval: true, createdAt: now });
  }
  return { items, state: input.pendingApproval || input.pendingQuestion || input.pendingPlan ? "waiting" : state };
}
