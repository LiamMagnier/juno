/*
 * THE LEGACY TASK EVENTS, UPGRADED TO THE CANONICAL PROTOCOL.
 *
 * Every Code task stored before the protocol existed — and every one a shipped
 * Mac still writes — is a stream of `CodeTaskEvent` kinds (src/lib/code-remote.ts
 * `EVENT_KINDS`): `user`, `text`, `tool`, `file_change`, `approval_request`, …
 * This turns each such row into the protocol events it meant, so one reducer
 * (fold.ts) reads old and new tasks alike and old tasks keep rendering.
 *
 * It is also the ONLY place an outcome is read out of a display string. Rows
 * written before producers typed their outcomes carry nothing else: the cloud
 * runner's ` — ok` / ` — failed` suffix, its `Denied …` and
 * `Auto-allowed in sandbox: …` rows, the Mac's completion rows named after
 * their status. Producers that speak the protocol send
 * `item.tool_result.status`, and nothing downstream of this file parses text.
 *
 * Rows a producer derived from a protocol event it ALSO posted carry
 * `protocolEventId` in their payload; they exist for readers that predate the
 * protocol, and a reader of the protocol skips them (see `isDerivedLegacyRow`).
 */
import {
  AGENT_PROTOCOL,
  AGENT_RISK_VALUES,
  AGENT_SUBAGENT_STATUS_VALUES,
  type AgentEvent,
  type AgentEventBody,
  type AgentFileChangeKind,
  type AgentRisk,
  type AgentStopReason,
  type AgentSubagentStatus,
  type AgentToolKind,
  type AgentToolResultStatus,
  type AgentUsage,
} from "./protocol.generated";

/** One stored task event, as the task routes serialize it. */
export interface TaskEventRow {
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

/** The kind a task event carries a protocol event under; its payload is the event. */
export const PROTOCOL_TASK_EVENT_KIND = "protocol";

/**
 * The payload key a producer sets on a legacy row it derived from a protocol
 * event it also posted, naming that event. Readers of the protocol skip such
 * rows; readers that predate it never look at the key.
 */
export const DERIVED_FROM_PROTOCOL_KEY = "protocolEventId";

type Payload = Record<string, unknown>;

const record = (value: unknown): Payload =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : {};
const str = (payload: Payload, key: string): string | undefined =>
  typeof payload[key] === "string" ? (payload[key] as string) : undefined;
const num = (payload: Payload, key: string): number | undefined =>
  typeof payload[key] === "number" && Number.isFinite(payload[key]) ? (payload[key] as number) : undefined;
const int = (payload: Payload, key: string): number | undefined => {
  const value = num(payload, key);
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
};

/** Whether a legacy row is the twin of a protocol event posted beside it. */
export function isDerivedLegacyRow(row: Pick<TaskEventRow, "payload">): boolean {
  return typeof record(row.payload)[DERIVED_FROM_PROTOCOL_KEY] === "string";
}

/** The cloud runner's outcome suffix on a bash summary, from before `exitCode`. */
const OUTCOME_SUFFIX = / — (ok|failed)$/;
/** The Mac's completion rows were named after `ToolCompletionStatus`. */
const MAC_COMPLETION: Record<string, AgentToolResultStatus> = {
  succeeded: "ok",
  failed: "error",
  denied: "denied",
  cancelled: "not_executed",
};

/**
 * How a legacy `tool` row ended, as the protocol types it. The number first,
 * then the flags, then — for rows persisted before either existed — the text.
 */
export function legacyToolStatus(payload: unknown): AgentToolResultStatus {
  const row = record(payload);
  const exitCode = num(row, "exitCode");
  if (exitCode !== undefined) return exitCode === 0 ? "ok" : "error";
  if (row.failed === true) return "error";
  const name = str(row, "name");
  if (name && MAC_COMPLETION[name]) return MAC_COMPLETION[name];
  const summary = str(row, "summary") ?? "";
  const suffix = OUTCOME_SUFFIX.exec(summary)?.[1];
  if (suffix === "ok") return "ok";
  if (suffix === "failed") return "error";
  if (/^Denied /.test(summary)) return "denied";
  // The runner's automatic allow, persisted as a tool row before the fold made
  // it a note; the transcript always drew it as a success.
  if (AUTO_ALLOWED.test(summary)) return "ok";
  return "unknown";
}

/** A legacy tool row's title, without the outcome suffix it no longer needs. */
export function legacyToolTitle(payload: unknown): string {
  const row = record(payload);
  return (str(row, "summary") ?? str(row, "name") ?? "").replace(OUTCOME_SUFFIX, "");
}

/** What kind of call a tool name is, for the names both engines use. */
export function toolKindFor(name: string): AgentToolKind {
  switch (name) {
    case "read_file":
    case "list_directory":
    case "inspect_active_editor":
      return "read";
    case "write_file":
    case "edit_file":
    case "apply_patch":
    case "create_file":
    case "delete_file":
    case "move_file":
      return "edit";
    case "bash":
    case "run_command":
      return "execute";
    case "glob":
    case "grep":
    case "find_files":
      return "search";
    case "web_fetch":
    case "web_search":
      return "fetch";
    case "delegate_task":
    case "delegate_tasks":
    case "await_subagents":
    case "inspect_subagent":
    case "cancel_subagent":
    case "update_goal":
    case "update_plan":
      return "think";
    default:
      return "other";
  }
}

/** The task wire's risk words (`destructive | outside | neutral`) and the Mac's tiers, as protocol risk. */
function riskFrom(value: string | undefined): AgentRisk | undefined {
  if (value === undefined) return undefined;
  if ((AGENT_RISK_VALUES as readonly string[]).includes(value)) return value as AgentRisk;
  if (value === "outside") return "critical";
  if (value === "neutral") return undefined;
  return "unknown";
}

const FILE_CHANGES: Record<string, AgentFileChangeKind> = {
  create: "created",
  created: "created",
  edit: "modified",
  modified: "modified",
  delete: "deleted",
  deleted: "deleted",
  move: "moved",
  moved: "moved",
};

const TASK_STATES: Record<string, AgentEventBody<"session.state">["state"]> = {
  queued: "idle",
  running: "running",
  awaiting_approval: "awaiting_approval",
  done: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function stopReasonFrom(finishReason: string | undefined): AgentStopReason {
  switch (finishReason) {
    case undefined:
    case "end_turn":
    case "no_changes":
      return "end_turn";
    case "cancelled":
    case "aborted":
      return "cancelled";
    case "max_steps":
    case "max_tokens":
    case "refusal":
      return finishReason;
    default:
      return "unknown";
  }
}

/** The runner's refusal row: `Denied — this run is set to Plan: npm test`. */
const MODE_DENIAL = /^Denied — (.+?): ([\s\S]*)$/;
const AUTO_ALLOWED = /^Auto-allowed in sandbox: /;

/**
 * Upgrades one task's legacy rows, in order. Stateful because the legacy wire
 * is: consecutive `text` rows are one reply, and a prompt opens the turn that
 * the rows after it belong to.
 */
export class LegacyTaskUpgrader {
  private openTurnId: string | undefined;
  /** The reply and the thinking block consecutive deltas extend. */
  private textItemId: string | undefined;
  private thinkingItemId: string | undefined;

  constructor(private readonly sessionId: string) {}

  upgrade(row: TaskEventRow): AgentEvent[] {
    const payload = record(row.payload);
    const out: AgentEvent[] = [];
    const emit = (body: AgentEventBody, extra: { agentId?: string } = {}) => {
      const event = {
        v: AGENT_PROTOCOL.v,
        id: `legacy:${row.seq}:${out.length}`,
        sessionId: this.sessionId,
        seq: row.seq,
        at: row.createdAt,
        ...(this.openTurnId !== undefined ? { turnId: this.openTurnId } : {}),
        ...(extra.agentId !== undefined ? { agentId: extra.agentId } : {}),
        ...body,
      } as AgentEvent;
      out.push(event);
    };
    // Only consecutive deltas extend one item.
    if (row.kind !== "text") this.textItemId = undefined;
    if (row.kind !== "reasoning" && row.kind !== "reasoning_delta") this.thinkingItemId = undefined;

    switch (row.kind) {
      case "user": {
        const text = str(payload, "text");
        if (!text) break;
        const delivery = payload.steer === true || payload.delivery === "steer" ? "steer" : payload.delivery === "queue" ? "queue" : "prompt";
        if (delivery === "prompt") {
          this.openTurnId = `legacy-turn:${row.seq}`;
          emit({ type: "turn.started", origin: "user" });
        }
        const commandId = str(payload, "requestId");
        emit({
          type: "item.user_message",
          itemId: `legacy-user:${row.seq}`,
          text,
          delivery,
          ...(commandId ? { commandId } : {}),
        });
        break;
      }
      case "text": {
        const text = str(payload, "text");
        if (!text) break;
        this.textItemId ??= `legacy-text:${row.seq}`;
        emit({ type: "item.assistant_text.delta", itemId: this.textItemId, text });
        break;
      }
      case "reasoning":
      case "reasoning_delta": {
        const text = str(payload, "text");
        if (!text) break;
        this.thinkingItemId ??= `legacy-thinking:${row.seq}`;
        emit({ type: "item.thinking.delta", itemId: this.thinkingItemId, text });
        break;
      }
      case "tool":
        this.upgradeTool(row, payload, emit);
        break;
      case "file_change": {
        const path = str(payload, "path");
        if (!path) break;
        const patch = str(payload, "patch") ?? str(payload, "diff");
        const checkpointId = str(payload, "checkpointId");
        emit({
          type: "item.file_change",
          itemId: `legacy-file:${row.seq}`,
          path,
          change: FILE_CHANGES[str(payload, "changeKind") ?? "edit"] ?? "unknown",
          linesAdded: int(payload, "added") ?? int(payload, "linesAdded") ?? 0,
          linesRemoved: int(payload, "removed") ?? int(payload, "linesRemoved") ?? 0,
          ...(patch ? { patch } : {}),
          ...(checkpointId ? { checkpointId } : {}),
        });
        break;
      }
      case "approval_request": {
        const approvalId = str(payload, "requestId");
        const summary = str(payload, "summary");
        if (!approvalId || !summary) break;
        emit({
          type: "approval.requested",
          approvalId,
          action: str(payload, "detail") ?? "tool",
          summary,
          risk: riskFrom(str(payload, "risk")) ?? "unknown",
        });
        break;
      }
      case "approval_response": {
        const approvalId = str(payload, "requestId");
        const approved = typeof payload.approve === "boolean" ? payload.approve : payload.approved;
        if (!approvalId || typeof approved !== "boolean") break;
        emit({ type: "approval.resolved", approvalId, decision: approved ? "allow_once" : "deny", by: "user" });
        break;
      }
      case "error": {
        const message = str(payload, "message");
        if (!message) break;
        emit({ type: "session.error", error: { code: "internal", message, retryable: false } });
        break;
      }
      case "done": {
        const promptTokens = int(payload, "promptTokens");
        const completionTokens = int(payload, "completionTokens");
        if (promptTokens !== undefined || completionTokens !== undefined) {
          const usage: AgentUsage = { inputTokens: promptTokens ?? 0, outputTokens: completionTokens ?? 0 };
          emit({ type: "usage.updated", usage, scope: "turn" });
        }
        const branch = str(payload, "branch");
        if (branch) {
          const prUrl = str(payload, "prUrl");
          const prNumber = int(payload, "prNumber");
          emit({
            type: "code.pull_request",
            branch,
            ...(prUrl ? { prUrl } : {}),
            ...(prNumber !== undefined ? { prNumber } : {}),
          });
        }
        if (this.openTurnId !== undefined) {
          const summary = str(payload, "summary");
          const filesChanged = int(payload, "filesChanged");
          emit({
            type: "turn.completed",
            stopReason: stopReasonFrom(str(payload, "finishReason")),
            ...(summary ? { summary } : {}),
            ...(filesChanged !== undefined ? { filesChanged } : {}),
          });
          this.openTurnId = undefined;
        }
        break;
      }
      case "status": {
        // Task statuses only. The Mac's free-text status rows ("Context
        // compacted", "Running <id>") were never part of a transcript.
        const state = TASK_STATES[str(payload, "status") ?? ""];
        if (state) emit({ type: "session.state", state });
        break;
      }
      case "agent": {
        const agent = record(payload.agent);
        const id = str(agent, "id");
        if (!id) break;
        const status = str(agent, "status") ?? "";
        const usage = record(agent.usage);
        const input = int(usage, "inputTokens");
        const output = int(usage, "outputTokens");
        const role = str(agent, "role");
        const activity = str(agent, "currentActivity") ?? str(agent, "activity");
        const summary = str(agent, "summary");
        const error = str(agent, "error");
        emit({
          type: "item.subagent",
          itemId: id,
          title: str(agent, "title") ?? "",
          status: (AGENT_SUBAGENT_STATUS_VALUES as readonly string[]).includes(status)
            ? (status as AgentSubagentStatus)
            : "unknown",
          ...(role ? { role } : {}),
          ...(activity ? { activity } : {}),
          ...(summary ? { summary } : {}),
          ...(error ? { error } : {}),
          ...(input !== undefined && output !== undefined ? { usage: { inputTokens: input, outputTokens: output } } : {}),
        });
        break;
      }
      default:
        // Controls (steer, steer_ack, cancel_request, the rollback verbs and
        // results, rollback_ready) are not transcript: the task view handles
        // them beside the fold. `protocol` rows are read, not upgraded.
        break;
    }
    return out;
  }

  private upgradeTool(row: TaskEventRow, payload: Payload, emit: (body: AgentEventBody, extra?: { agentId?: string }) => void) {
    const name = str(payload, "name") ?? "";
    const summary = str(payload, "summary") ?? "";
    const agentId = str(payload, "agentId");
    // The cloud runner's answer to an approval nobody was attached to.
    if (name === "approval") {
      const approvalId = `legacy-approval:${row.seq}`;
      const risk = riskFrom(str(payload, "risk")) ?? "unknown";
      const allowed = payload.autoAllowed === true || AUTO_ALLOWED.test(summary);
      const denial = allowed ? null : MODE_DENIAL.exec(summary);
      const shown = allowed ? summary.replace(AUTO_ALLOWED, "") : (denial?.[2] ?? summary);
      emit({ type: "approval.requested", approvalId, action: "tool", summary: shown, risk }, { agentId });
      emit(
        {
          type: "approval.resolved",
          approvalId,
          decision: allowed ? "allow_once" : "deny",
          by: "mode",
          ...(denial ? { feedback: denial[1] } : {}),
        },
        { agentId },
      );
      return;
    }
    // The Mac's reasoning summaries rode as tool rows.
    if (name === "Reasoning") {
      if (summary) emit({ type: "item.thinking", itemId: `legacy-thinking:${row.seq}`, summary });
      return;
    }
    const itemId = `legacy-tool:${row.seq}`;
    const detail = str(payload, "detail");
    // The Mac put a proposal's risk tier in `detail`; anything else there is output.
    const detailRisk = detail !== undefined && (AGENT_RISK_VALUES as readonly string[]).includes(detail) ? (detail as AgentRisk) : undefined;
    const exitCode = int(payload, "exitCode");
    emit(
      {
        type: "item.tool_call",
        itemId,
        toolName: name,
        toolKind: toolKindFor(name),
        title: legacyToolTitle(payload),
        ...(detailRisk ? { risk: detailRisk } : {}),
      },
      { agentId },
    );
    emit(
      {
        type: "item.tool_result",
        itemId,
        status: legacyToolStatus(payload),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(detail !== undefined && !detailRisk ? { output: detail } : {}),
      },
      { agentId },
    );
  }
}
