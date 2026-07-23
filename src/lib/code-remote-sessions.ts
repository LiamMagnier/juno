import type { CodeRemoteSession, CodeRemoteSessionEvent, CodeSessionCommand, Prisma } from "@prisma/client";
export const REMOTE_PROTOCOL_VERSION = 2;
export const REMOTE_DEVICE_ONLINE_WINDOW_MS = 120_000;
export const SESSION_STATUSES = ["idle", "running", "awaiting_approval", "completed", "failed", "interrupted"] as const;
export const TRANSCRIPT_POLICIES = ["metadata", "recent", "full"] as const;
export const SESSION_COMMAND_KINDS = [
  "message",
  "stop",
  "approval",
  "patch",
  "delete",
  "fork",
  "retry",
  "accept_change",
  "reject_change",
  "undo_change",
  "run_tests",
  "stop_tests",
  "git",
  "stop_agent",
] as const;
export const SESSION_EVENT_KINDS = [
  "session_created",
  "session_updated",
  "user_message",
  "text_delta",
  "reasoning_delta",
  "tool_start",
  "tool_result",
  "command_output",
  "file_change",
  "test_update",
  "git_update",
  "approval_request",
  "approval_response",
  "subagent_update",
  "status_update",
  "usage",
  "error",
  "completed",
  "heartbeat",
] as const;

export type RemoteSessionSummaryInput = {
  sessionId: string;
  workspaceId?: string | null;
  workspaceKey?: string | null;
  workspaceName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  title: string;
  titleSource?: string;
  modelId: string;
  reasoningEffort?: string | null;
  rolePreset?: string;
  permissionMode?: string;
  origin?: string;
  pinned?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  currentStatus?: string;
  isRunning?: boolean;
  isAwaitingApproval?: boolean;
  pendingChangeCount?: number;
  activeBranch?: string | null;
  gitDirtyState?: string | null;
  lastError?: string | null;
  lastEventSequence?: number;
  transcriptVersion?: number;
  snapshotVersion?: number;
  transcriptPolicy?: string;
  indexedSearch?: string;
};

const asRecord = (value: Prisma.JsonValue | null): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function serializeRemoteSession(session: CodeRemoteSession, online?: boolean) {
  return {
    sessionID: session.sessionId,
    deviceID: session.deviceId,
    workspaceID: session.workspaceId,
    workspaceKey: session.workspaceKey,
    workspaceName: session.workspaceName,
    projectID: session.projectId,
    projectName: session.projectName,
    title: session.title,
    titleSource: session.titleSource,
    modelID: session.modelId,
    reasoningEffort: session.reasoningEffort,
    rolePreset: session.rolePreset,
    permissionMode: session.permissionMode,
    origin: session.origin,
    pinned: session.pinned,
    archived: session.archived,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.sessionUpdatedAt.toISOString(),
    lastMessageAt: session.lastMessageAt.toISOString(),
    currentStatus: session.currentStatus,
    isRunning: session.isRunning,
    isAwaitingApproval: session.isAwaitingApproval,
    pendingChangeCount: session.pendingChangeCount,
    activeBranch: session.activeBranch,
    gitDirtyState: session.gitDirtyState,
    lastError: session.lastError,
    lastEventSequence: session.lastEventSequence,
    transcriptVersion: session.transcriptVersion,
    snapshotVersion: session.snapshotVersion,
    transcriptPolicy: session.transcriptPolicy,
    syncedAt: session.syncedAt.toISOString(),
    ...(online === undefined ? {} : { fresh: online }),
  };
}

export function serializeRemoteSessionDetail(session: CodeRemoteSession, online: boolean) {
  return {
    session: serializeRemoteSession(session, online),
    transcript: session.transcript,
    changes: session.changes,
    terminal: session.terminal,
    tests: session.tests,
    git: session.git,
    approvals: session.approvals,
    subagents: session.subagents,
    usage: session.usage,
    live: online && session.isRunning,
    stale: !online,
  };
}

export function serializeSessionEvent(event: CodeRemoteSessionEvent) {
  return {
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

export function serializeSessionCommand(command: CodeSessionCommand) {
  return {
    id: command.id,
    sessionID: command.sessionId,
    kind: command.kind,
    payload: command.payload,
    status: command.status,
    result: command.result,
    error: command.error,
    createdAt: command.createdAt.toISOString(),
    claimedAt: command.claimedAt?.toISOString() ?? null,
    completedAt: command.completedAt?.toISOString() ?? null,
  };
}

export function sessionUpsertData(input: RemoteSessionSummaryInput, transcriptPolicy: string) {
  const createdAt = new Date(input.createdAt);
  const updatedAt = new Date(input.updatedAt);
  const lastMessageAt = new Date(input.lastMessageAt);
  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId ?? null,
    workspaceKey: input.workspaceKey ?? null,
    workspaceName: input.workspaceName ?? null,
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    title: input.title,
    titleSource: input.titleSource ?? "default",
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort ?? null,
    rolePreset: input.rolePreset ?? "builder",
    permissionMode: input.permissionMode ?? "approvalRequired",
    origin: input.origin ?? "local",
    pinned: input.pinned ?? false,
    archived: input.archived ?? false,
    createdAt,
    sessionUpdatedAt: updatedAt,
    lastMessageAt,
    currentStatus: input.currentStatus ?? "idle",
    isRunning: input.isRunning ?? false,
    isAwaitingApproval: input.isAwaitingApproval ?? false,
    pendingChangeCount: input.pendingChangeCount ?? 0,
    activeBranch: input.activeBranch ?? null,
    gitDirtyState: input.gitDirtyState ?? null,
    lastError: input.lastError ?? null,
    lastEventSequence: input.lastEventSequence ?? 0,
    transcriptVersion: input.transcriptVersion ?? 1,
    snapshotVersion: input.snapshotVersion ?? 1,
    transcriptPolicy,
    indexedSearch: input.indexedSearch ?? [input.title, input.workspaceName, input.projectName, input.activeBranch, input.modelId]
      .filter(Boolean)
      .join(" ")
      .slice(0, 200_000),
    deletedAt: null,
    syncedAt: new Date(),
  };
}

export function deviceIsOnline(lastSeenAt: Date, now = Date.now()): boolean {
  return now - lastSeenAt.getTime() <= REMOTE_DEVICE_ONLINE_WINDOW_MS;
}

/** Live-state columns a `status_update` event folds into the session row. A run
 *  is "running" only in that status; awaiting_approval is its own busy state.
 *  Returns null for a status that doesn't map (so the caller leaves the row). */
export function deriveSessionStatusFields(
  status: string | undefined,
): { currentStatus: string; isRunning: boolean; isAwaitingApproval: boolean } | null {
  if (!status || !(SESSION_STATUSES as readonly string[]).includes(status)) return null;
  return { currentStatus: status, isRunning: status === "running", isAwaitingApproval: status === "awaiting_approval" };
}

export type IncomingSessionEvent = { seq: number; kind: string; payload: Record<string, unknown>; createdAt?: string };

export type SessionEventAppendPlan =
  | { ok: false; error: "missing_events"; expectedSeq: number }
  | { ok: true; accepted: IncomingSessionEvent[]; lastSeq: number; status: string | undefined };

/**
 * Deterministic host-append planner (RULE 17). Given the session's persisted
 * `lastEventSequence` and an incoming batch, it:
 *  - sorts by seq (a host may batch out of order),
 *  - treats every seq ≤ lastEventSequence as an idempotent replay (skipped) so a
 *    reconnect/retry never double-writes a delta or tool call,
 *  - rejects the FIRST gap after lastEventSequence (a hole would make the stored
 *    transcript look complete when it isn't),
 *  - returns only the genuinely-new events plus the derived trailing status.
 * Pure — no DB — so fragmented/repeated deliveries are exhaustively testable.
 */
export function planSessionEventAppend(lastEventSequence: number, events: IncomingSessionEvent[]): SessionEventAppendPlan {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let expected = lastEventSequence + 1;
  for (const event of sorted) {
    if (event.seq <= lastEventSequence) continue; // already persisted — replay
    if (event.seq !== expected) return { ok: false, error: "missing_events", expectedSeq: expected };
    expected += 1;
  }
  const accepted = sorted.filter((event) => event.seq > lastEventSequence);
  const lastSeq = accepted.length ? accepted[accepted.length - 1].seq : lastEventSequence;
  const statusEvent = [...accepted].reverse().find((event) => event.kind === "status_update");
  const status = typeof statusEvent?.payload.status === "string" ? statusEvent.payload.status : undefined;
  return { ok: true, accepted, lastSeq, status };
}

export function decodeCursor(cursor: string | null): { updatedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { updatedAt?: string; id?: string };
    if (!value.updatedAt || !value.id) return null;
    const updatedAt = new Date(value.updatedAt);
    return Number.isNaN(updatedAt.getTime()) ? null : { updatedAt, id: value.id };
  } catch {
    return null;
  }
}

export function encodeCursor(session: CodeRemoteSession): string {
  return Buffer.from(JSON.stringify({ updatedAt: session.sessionUpdatedAt.toISOString(), id: session.id })).toString("base64url");
}

export function snapshotVersionOf(session: CodeRemoteSession): number {
  return session.snapshotVersion;
}

/** A detail snapshot upload is stale (reject 409) when it would move either the
 *  snapshot generation OR the event high-water-mark backwards — the Mac is the
 *  source of truth, but two hosts / a replayed request must never overwrite a
 *  newer snapshot with an older one. */
export function snapshotIsStale(
  incoming: { snapshotVersion: number; lastEventSequence: number },
  current: { snapshotVersion: number; lastEventSequence: number },
): boolean {
  return incoming.snapshotVersion < current.snapshotVersion || incoming.lastEventSequence < current.lastEventSequence;
}

/** Whether the host is permitted to persist transcript/diff/terminal content
 *  for the given policy. "metadata" keeps only summaries server-side; the
 *  richer policies retain content the phone can read while the Mac is offline. */
export function policyKeepsContent(policy: string): boolean {
  return policy !== "metadata";
}

export function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return asRecord(value) ?? {};
}
