/*
 * A CODE TASK'S TRANSCRIPT, READ THROUGH THE ONE FOLD.
 *
 * Both readers of a task's events go through this: the live session view
 * (src/hooks/use-code-session.ts) and the outcome message persisted when the
 * task ends (src/lib/code-task-outcome.ts). Before it, each had its own switch
 * over the legacy kinds, and a tool row's outcome was recovered from its title
 * with a regex. Now:
 *
 *   - a `protocol` row is a canonical event, read as one;
 *   - a legacy row a producer derived from a protocol event it also posted is
 *     skipped (its twin is already in the stream);
 *   - any other legacy row is upgraded (legacy.ts), so tasks stored before the
 *     protocol, and those a shipped Mac still writes, fold the same way;
 *   - the host's control replies that are not transcript in the protocol
 *     (rollback asks and results) keep their own rows, in arrival order.
 *
 * What comes out is the chat vocabulary's activity rows — the shape every
 * transcript surface already draws — with the tool outcome as a TYPED field
 * (`toolStatus`), never inferred from the text.
 *
 * Deliberately free of React, Prisma and next/*: the PM2 workers persist task
 * outcomes, and they must be able to import this (see code-task-outcome.ts).
 */
import type { ClientActivityEvent } from "@/types/chat";

import { applyAgentEvent, createAgentFold, type AgentFold, type AgentItemView, type AgentSessionView, type AgentToolItemStatus } from "./fold";
import {
  DERIVED_FROM_PROTOCOL_KEY,
  LegacyTaskUpgrader,
  PROTOCOL_TASK_EVENT_KIND,
  isDerivedLegacyRow,
  legacyToolStatus,
  legacyToolTitle,
  type TaskEventRow,
} from "./legacy";
import { parseAgentEvent, type ParsedAgentEvent } from "./protocol.generated";

export { DERIVED_FROM_PROTOCOL_KEY, PROTOCOL_TASK_EVENT_KIND, type TaskEventRow };

/**
 * A Code activity row: the shared chat row plus Code's extra keys. `patch` is
 * a write row's diff, `exitCode` a command's status, and `toolStatus` how the
 * call ended, typed by the producer.
 */
export type CodeActivityRow = ClientActivityEvent & {
  patch?: string;
  exitCode?: number;
  toolStatus?: AgentToolItemStatus;
};

export interface CodeTaskTranscriptOptions {
  /**
   * Show the reader's own rollback asks. The live view does (the reader just
   * pressed the button); the persisted outcome does not, because an ask a host
   * may never have acted on is not a fact about the files.
   */
  includeRollbackAsks?: boolean;
  /** Append one summary row per delegated agent (the persisted outcome's "who did what"). */
  includeAgentSummaries?: boolean;
}

type Slot = { itemId: string } | { row: CodeActivityRow };

const ROLLBACK_ASKS = new Set(["accept_change", "reject_change", "undo_change"]);

export class CodeTaskTranscript {
  private readonly fold: AgentFold = createAgentFold();
  private readonly upgrader: LegacyTaskUpgrader;
  /** What the transcript shows, in arrival order: fold items by id, and control rows. */
  private slots: Slot[] = [];
  private readonly slotted = new Set<string>();
  /** When each item first appeared, for its row's timestamp. */
  private readonly firstSeen = new Map<string, string>();

  constructor(
    sessionId: string,
    private readonly options: CodeTaskTranscriptOptions = {},
  ) {
    this.upgrader = new LegacyTaskUpgrader(sessionId);
  }

  get view(): AgentSessionView {
    return this.fold.view;
  }

  /** Apply one stored task event. */
  apply(row: TaskEventRow): void {
    if (row.kind === PROTOCOL_TASK_EVENT_KIND) {
      const event = parseAgentEvent(row.payload);
      if (event) this.applyEvent(event);
      return;
    }
    if (row.kind === "rollback_result") {
      this.slots.push({ row: rollbackResultRow(row) });
      return;
    }
    if (ROLLBACK_ASKS.has(row.kind)) {
      if (this.options.includeRollbackAsks) this.slots.push({ row: rollbackAskRow(row) });
      return;
    }
    if (isDerivedLegacyRow(row)) return;
    for (const event of this.upgrader.upgrade(row)) this.applyEvent(event);
  }

  applyAll(rows: Iterable<TaskEventRow>): void {
    for (const row of rows) this.apply(row);
  }

  private applyEvent(event: ParsedAgentEvent): void {
    const before = this.fold.view.items.length;
    applyAgentEvent(this.fold, event);
    const items = this.fold.view.items;
    if (items.length < before || (event.type === "transcript.restarted")) {
      // A rewind: the fold dropped its items, so their rows go too.
      this.slots = this.slots.filter((slot) => !("itemId" in slot));
      this.slotted.clear();
    }
    for (const item of items) {
      if (this.slotted.has(item.itemId)) continue;
      this.slotted.add(item.itemId);
      this.firstSeen.set(item.itemId, event.at);
      this.slots.push({ itemId: item.itemId });
    }
  }

  /** The assistant's reply: every reply item's text, in order. */
  get content(): string {
    return this.fold.view.items
      .flatMap((item) => (item.kind === "assistant_text" && item.text ? [item.text] : []))
      .join("\n\n");
  }

  /** The visible thinking, in order. */
  get reasoning(): string {
    return this.fold.view.items
      .flatMap((item) => (item.kind === "thinking" && item.text ? [item.text] : []))
      .join("\n\n");
  }

  /** The last error the run reported, if any. */
  get errorMessage(): string | null {
    return this.fold.view.lastError?.message ?? null;
  }

  /** Provider-reported token totals, or null when none were reported. */
  get tokens(): { promptTokens: number; completionTokens: number } | null {
    const usage = this.fold.view.usage;
    const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (prompt === 0 && usage.outputTokens === 0) return null;
    return { promptTokens: prompt, completionTokens: usage.outputTokens };
  }

  /** The approval a reader can answer now, in the shape the task routes take. */
  get pendingApproval(): { requestId: string; summary: string; risk: string; detail: string | null } | null {
    const id = this.fold.view.pendingApprovalId;
    if (id === undefined) return null;
    const approval = this.fold.view.items.find((item) => item.kind === "approval" && item.approvalId === id);
    if (!approval || approval.kind !== "approval") return null;
    return { requestId: approval.approvalId, summary: approval.summary, risk: approval.risk, detail: approval.action || null };
  }

  /** The files the run changed, last report per path. */
  get fileChanges(): Array<{ path: string; changeKind: string; added: number; removed: number; patch: string | null }> {
    const byPath = new Map<string, { path: string; changeKind: string; added: number; removed: number; patch: string | null }>();
    for (const item of this.fold.view.items) {
      if (item.kind !== "file_change") continue;
      const previous = byPath.get(item.path);
      byPath.set(item.path, {
        path: item.path,
        changeKind: changeWord(item.change),
        added: item.linesAdded,
        removed: item.linesRemoved,
        // A later report that lost its hunks keeps the diff already shown.
        patch: item.patch ?? previous?.patch ?? null,
      });
    }
    return [...byPath.values()];
  }

  /** The transcript's activity rows, in the order things happened. */
  activity(): CodeActivityRow[] {
    const view = this.fold.view;
    const byId = new Map(view.items.map((item) => [item.itemId, item]));
    // One refused call is one row: when the mode answered for a call, its
    // approval row says so and the call's own denied row would repeat it.
    const answeredByMode = new Set<string>();
    for (const item of view.items) {
      if (item.kind === "approval" && item.by === "mode" && item.toolItemId) answeredByMode.add(item.toolItemId);
    }
    const rows: CodeActivityRow[] = [];
    for (const slot of this.slots) {
      if ("row" in slot) {
        rows.push(slot.row);
        continue;
      }
      const item = byId.get(slot.itemId);
      if (!item) continue;
      rows.push(...this.rowsFor(item, answeredByMode));
    }
    if (this.options.includeAgentSummaries) {
      for (const item of view.items) {
        if (item.kind !== "subagent") continue;
        rows.push({
          id: `item-${item.itemId}-summary`,
          kind: "tool",
          title: `Agent ${item.role ?? "agent"}${item.title ? ` · ${item.title}` : ""} — ${item.status}`,
          detail: item.summary ? item.summary.slice(0, 500) : undefined,
          createdAt: this.firstSeen.get(item.itemId) ?? "",
        });
      }
    }
    return rows;
  }

  private rowsFor(item: AgentItemView, answeredByMode: ReadonlySet<string>): CodeActivityRow[] {
    const id = `item-${item.itemId}`;
    const createdAt = this.firstSeen.get(item.itemId) ?? "";
    switch (item.kind) {
      case "tool": {
        if (item.status === "denied" && answeredByMode.has(item.itemId)) return [];
        const detail = item.output ?? item.summary;
        return [
          {
            id,
            kind: "tool",
            title: item.title || item.toolName,
            ...(detail ? { detail } : {}),
            createdAt,
            toolStatus: item.status,
            ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
          },
        ];
      }
      case "file_change":
        return [
          {
            id,
            kind: "write",
            title: `${changeWord(item.change)} ${item.path}`,
            detail: `+${item.linesAdded} −${item.linesRemoved}`,
            createdAt,
            ...(item.patch ? { patch: item.patch } : {}),
          },
        ];
      case "approval": {
        if (item.by === "mode") {
          // Nobody was asked: the mode answered, and one row says which way —
          // a note when it allowed, a failure when it refused, told apart by
          // the decision rather than by how the sentence starts.
          const allowed = item.decision === "allow_once" || item.decision === "allow_always";
          return [
            {
              id,
              kind: allowed ? "done" : "warning",
              title: allowed
                ? `Auto-allowed in sandbox: ${item.summary}`
                : item.feedback
                  ? `Denied — ${item.feedback}: ${item.summary}`
                  : `Denied: ${item.summary}`,
              createdAt,
            },
          ];
        }
        const rows: CodeActivityRow[] = [
          { id, kind: "warning", title: "Approval requested", detail: item.summary, createdAt },
        ];
        if (item.decision !== undefined) {
          const allowed = item.decision === "allow_once" || item.decision === "allow_always";
          rows.push({
            id: `${id}-decision`,
            kind: allowed ? "done" : "warning",
            title: allowed ? "Approved" : "Denied",
            ...(item.feedback ? { detail: item.feedback } : {}),
            createdAt,
          });
        }
        return rows;
      }
      case "test_run":
        return [
          {
            id,
            kind: "tool",
            title: item.passed ? "Tests passed" : "Tests failed",
            detail: item.command,
            createdAt,
            toolStatus: item.passed ? "ok" : "error",
          },
        ];
      case "notice":
        return [{ id, kind: "tool", title: item.text, ...(item.detail ? { detail: item.detail } : {}), createdAt }];
      case "compaction":
        return [
          {
            id,
            kind: "tool",
            title: "Context compacted",
            ...(item.beforeMessages !== undefined && item.afterMessages !== undefined
              ? { detail: `${item.beforeMessages} → ${item.afterMessages} messages` }
              : {}),
            createdAt,
          },
        ];
      case "question":
        return [
          {
            id,
            kind: item.answered ? "done" : "warning",
            title: item.answered ? "Question answered" : "Asked a question",
            detail: item.prompt,
            createdAt,
          },
        ];
      case "plan_proposal":
        return [
          {
            id,
            kind: item.decision === "rejected" ? "warning" : "done",
            title: item.decision === "approved" ? "Plan approved" : item.decision === "rejected" ? "Plan rejected" : "Proposed a plan",
            detail: item.text,
            createdAt,
          },
        ];
      // The reply, the thinking and the reader's own messages are the
      // message's body; errors are its error line; sub-agents are cards live
      // and summaries when persisted.
      case "user_message":
      case "assistant_text":
      case "thinking":
      case "error":
      case "subagent":
        return [];
    }
  }
}

/** The web's word for a change kind, as write rows have always carried it. */
function changeWord(change: string): string {
  switch (change) {
    case "created":
      return "create";
    case "deleted":
      return "delete";
    case "moved":
      return "move";
    default:
      return "edit";
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The host's answer to a rollback ask: what it did, never what was asked. */
function rollbackResultRow(row: TaskEventRow): CodeActivityRow {
  const payload = record(row.payload);
  const status = typeof payload.status === "string" ? payload.status : "failed";
  const paths = Array.isArray(payload.paths) ? payload.paths.filter((entry): entry is string => typeof entry === "string") : [];
  const message = typeof payload.message === "string" ? payload.message : undefined;
  return {
    id: `evt-${row.seq}`,
    kind: status === "applied" ? "done" : "warning",
    title:
      status === "applied"
        ? paths.length === 0
          ? "Rolled back"
          : paths.length === 1
            ? `Rolled back ${paths[0]}`
            : `Rolled back ${paths.length} files`
        : status === "unsupported"
          ? "Nothing to roll back"
          : "Rollback failed",
    ...(message ? { detail: message } : {}),
    createdAt: row.createdAt,
  };
}

/** The reader's own ask, in the past tense of asking — the host has not answered yet. */
function rollbackAskRow(row: TaskEventRow): CodeActivityRow {
  const payload = record(row.payload);
  const path = typeof payload.path === "string" ? payload.path : undefined;
  return {
    id: `evt-${row.seq}`,
    kind: "tool",
    title:
      row.kind === "undo_change"
        ? "Asked to undo the last turn"
        : row.kind === "reject_change"
          ? "Asked to revert a file"
          : "Asked to keep a file",
    ...(path ? { detail: path } : {}),
    createdAt: row.createdAt,
  };
}

/**
 * How a tool row's call ended. Rows this module wrote carry the fold's typed
 * status; rows persisted before it (an old Message.activity) carry only an
 * exit code or the text they were written with, and are read the one way the
 * legacy adapter reads such rows.
 */
export function codeToolStatus(row: ClientActivityEvent): AgentToolItemStatus {
  const typed = (row as { toolStatus?: unknown }).toolStatus;
  if (typeof typed === "string" && TOOL_ITEM_STATUSES.has(typed)) return typed as AgentToolItemStatus;
  return legacyToolStatus({ exitCode: (row as { exitCode?: unknown }).exitCode, summary: row.title });
}

/** A tool row's label: its title, without the outcome suffix old rows carry. */
export function codeToolLabel(row: ClientActivityEvent): string {
  const typed = (row as { toolStatus?: unknown }).toolStatus;
  return typeof typed === "string" ? row.title : legacyToolTitle({ summary: row.title });
}

const TOOL_ITEM_STATUSES: ReadonlySet<string> = new Set(["running", "ok", "error", "denied", "not_executed", "unknown"]);

/** Whether a string is a tool item status, for readers restoring persisted rows. */
export function isCodeToolStatus(value: unknown): value is AgentToolItemStatus {
  return typeof value === "string" && TOOL_ITEM_STATUSES.has(value);
}
