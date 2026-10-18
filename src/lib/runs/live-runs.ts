/**
 * Live runs: one list of every agent run an account has going right now, for
 * the supervisor surfaces (the iPhone's Runs screen and its Live Activity, and
 * any web or Mac view that wants the same picture).
 *
 * Two kinds of run feed it, and both already live in Postgres:
 *
 *  - `code`: a Code session on a paired Mac (`CodeRemoteSession`), whose
 *    journal the Mac mirrors to the relay. Computer use driven from Code runs
 *    inside one of these.
 *  - `work`: a Work attempt (`WorkRun`), on a Mac or in the cloud. Work tasks
 *    that drive a screen (Mac screen control or a cloud computer) are these.
 *
 * Everything here is pure: rows in, a projection out. The routes read the rows
 * (`src/app/api/runs/**`); tests feed literals. Nothing in a projection is
 * new information — it is the same state the web and the Mac render, so an
 * answer or a Stop from the phone shows up there because it lands in the same
 * rows, not because anything is mirrored.
 */

export type LiveRunKind = "code" | "work";

export type LiveRunRef =
  | { kind: "code"; deviceId: string; sessionId: string }
  | { kind: "work"; runId: string };

/** The phone's coarse vocabulary. Everything maps into one of these. */
export type LiveRunStatus = "queued" | "running" | "waiting_approval" | "waiting_input" | "paused";

export interface LiveRunApproval {
  /** The Code request id, or the Work approval row id. */
  id: string;
  summary: string;
  detail: string | null;
  /** As the producer stated it (`neutral`, `edit`, `command`, `irreversible`…). */
  risk: string;
  /** Whether answering needs the device owner (Face ID) on the phone. */
  highRisk: boolean;
  /** Work only: the digest the decision must echo. Null for Code. */
  actionDigest: string | null;
  requestedAt: string;
  expiresAt: string | null;
}

export interface LiveRun {
  /** Stable across snapshots: `code:<device>:<session>` or `work:<run>`. */
  key: string;
  ref: LiveRunRef;
  kind: LiveRunKind;
  title: string;
  hostName: string | null;
  target: "mac" | "cloud";
  status: LiveRunStatus;
  /** The producer's own status word, for surfaces that want the detail. */
  rawStatus: string;
  /** Tool steps taken in the current turn (Code) or attempt (Work). */
  steps: number;
  currentAction: string | null;
  usesComputer: boolean;
  startedAt: string;
  updatedAt: string;
  costUsd: number | null;
  /** False when the host has gone quiet: a Stop would queue for nobody. */
  hostOnline: boolean;
  canStop: boolean;
  approvals: LiveRunApproval[];
}

/**
 * Risk words that may be answered with a tap. Anything else — including a
 * word this build has never seen — needs the device owner, which is the
 * fail-closed direction: an unknown risk is treated as a high one.
 */
const LOW_RISK = new Set(["safe", "low", "neutral", "read", "edit", "info", "none", ""]);

export function isHighRisk(risk: string | null | undefined): boolean {
  return !LOW_RISK.has((risk ?? "").trim().toLowerCase());
}

export function liveRunKey(ref: LiveRunRef): string {
  return ref.kind === "code" ? `code:${ref.deviceId}:${ref.sessionId}` : `work:${ref.runId}`;
}

const COMPUTER_TOOL = /computer|screen|app_(click|type|key|scroll|drag|menu|press)|ax_(find|press)/i;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function read(payload: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = text(payload[key]);
    if (value) return value;
  }
  return null;
}

function clip(value: string | null, max = 140): string | null {
  if (!value) return null;
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

// ---------------------------------------------------------------------------
// Code sessions
// ---------------------------------------------------------------------------

export interface CodeSessionRow {
  deviceId: string;
  sessionId: string;
  title: string;
  currentStatus: string;
  isRunning: boolean;
  isAwaitingApproval: boolean;
  permissionMode: string;
  usage: unknown;
  sessionUpdatedAt: Date;
  lastMessageAt: Date;
}

export interface CodeEventRow {
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: Date;
}

/**
 * A `canonical_session_event` envelope unwrapped to the legacy `(kind,
 * payload)` pair, matching the phone's own reducer (`CodeRemoteThread`), so
 * the server and the phone read one vocabulary.
 */
export function unwrapCodeEvent(event: Pick<CodeEventRow, "kind" | "payload">): { kind: string; payload: Record<string, unknown> } {
  const payload = record(event.payload);
  if (event.kind !== "canonical_session_event") return { kind: event.kind, payload };
  const inner = record(record(payload.event).payload);
  const entries = Object.entries(inner);
  if (entries.length === 0) return { kind: event.kind, payload };
  const [caseName, body] = entries[0];
  const mapped: Record<string, string> = {
    userPrompt: "user_message",
    userInstruction: "user_message",
    toolProposed: "tool_start",
    toolStarted: "tool_start",
    toolCompleted: "tool_result",
    approvalRequested: "approval_request",
    approvalResolved: "approval_response",
    statusChanged: "status_update",
    runCompleted: "completed",
  };
  return { kind: mapped[caseName] ?? caseName, payload: record(body) };
}

/** The cost a Mac reported for the session, in dollars, when it reported one. */
export function codeSessionCost(usage: unknown): number | null {
  const value = record(usage);
  for (const key of ["costUsd", "totalCostUsd", "cost"]) {
    const n = value[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
  }
  const micro = value.costMicroUsd;
  if (typeof micro === "number" && Number.isFinite(micro) && micro >= 0) return micro / 1_000_000;
  return null;
}

/** Whether a Code session belongs on the live list at all. */
export function codeSessionIsLive(session: Pick<CodeSessionRow, "isRunning" | "isAwaitingApproval" | "currentStatus">): boolean {
  return session.isRunning || session.isAwaitingApproval || session.currentStatus === "queued";
}

/** Approvals asked in the journal and not yet answered there, oldest first. */
export function pendingCodeApprovals(events: readonly CodeEventRow[]): LiveRunApproval[] {
  const pending = new Map<string, LiveRunApproval>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const { kind, payload } = unwrapCodeEvent(event);
    if (kind === "approval_request") {
      const id = read(payload, ["requestId", "requestID", "id"]);
      if (!id) continue;
      const risk = read(payload, ["risk", "category"]) ?? "neutral";
      pending.set(id, {
        id,
        summary: clip(read(payload, ["summary", "text", "title"]) ?? "Approval required", 200) ?? "Approval required",
        detail: clip(read(payload, ["detail", "description", "command"]), 400),
        risk,
        highRisk: isHighRisk(risk),
        actionDigest: null,
        requestedAt: event.createdAt.toISOString(),
        expiresAt: null,
      });
    } else if (kind === "approval_response") {
      const id = read(payload, ["requestId", "requestID", "id"]);
      if (id) pending.delete(id);
    } else if (kind === "completed" || (kind === "status_update" && ["completed", "failed", "interrupted", "idle"].includes(read(payload, ["status", "state"]) ?? ""))) {
      // A finished turn has no question left open, whatever the journal
      // failed to say about it.
      pending.clear();
    }
  }
  return [...pending.values()];
}

export function projectCodeRun(input: {
  session: CodeSessionRow;
  hostName: string | null;
  hostOnline: boolean;
  /** The session's recent journal tail, any order. */
  events: readonly CodeEventRow[];
}): LiveRun {
  const { session } = input;
  const ordered = [...input.events].sort((a, b) => a.seq - b.seq);
  let turnStart: Date | null = null;
  let steps = 0;
  let currentAction: string | null = null;
  let usesComputer = false;
  for (const event of ordered) {
    const { kind, payload } = unwrapCodeEvent(event);
    if (kind === "user_message") {
      turnStart = event.createdAt;
      steps = 0;
      currentAction = null;
      usesComputer = false;
    } else if (kind === "tool_start") {
      steps += 1;
      const name = read(payload, ["name", "toolName", "tool"]);
      currentAction = clip(read(payload, ["summary", "title"]) ?? name);
      if (name && COMPUTER_TOOL.test(name)) usesComputer = true;
    }
  }
  const ref: LiveRunRef = { kind: "code", deviceId: session.deviceId, sessionId: session.sessionId };
  const approvals = session.isAwaitingApproval || session.currentStatus === "awaiting_approval" ? pendingCodeApprovals(ordered) : [];
  const status: LiveRunStatus = approvals.length > 0 || session.isAwaitingApproval
    ? "waiting_approval"
    : session.currentStatus === "queued"
      ? "queued"
      : "running";
  return {
    key: liveRunKey(ref),
    ref,
    kind: "code",
    title: session.title,
    hostName: input.hostName,
    target: "mac",
    status,
    rawStatus: session.currentStatus,
    steps,
    currentAction,
    usesComputer,
    startedAt: (turnStart ?? session.lastMessageAt).toISOString(),
    updatedAt: session.sessionUpdatedAt.toISOString(),
    costUsd: codeSessionCost(session.usage),
    hostOnline: input.hostOnline,
    canStop: true,
    approvals,
  };
}

// ---------------------------------------------------------------------------
// Work runs
// ---------------------------------------------------------------------------

export interface WorkRunRow {
  id: string;
  status: string;
  effectiveTarget: string | null;
  requestedTarget: string;
  costMicroUsd: number;
  startedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sessionTitle: string;
}

export interface WorkApprovalRow {
  id: string;
  summary: string;
  risk: string;
  actionDigest: string;
  decision: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface WorkToolEventRow {
  payload: unknown;
}

const WORK_STATUS: Record<string, LiveRunStatus> = {
  queued: "queued",
  preparing: "running",
  running: "running",
  waiting_input: "waiting_input",
  waiting_approval: "waiting_approval",
  paused: "paused",
};

/** Live Work statuses the list carries. `draft` is a session, never a run. */
export const LIVE_WORK_RUN_STATUSES = Object.keys(WORK_STATUS);

export function projectWorkRun(input: {
  run: WorkRunRow;
  hostName: string | null;
  hostOnline: boolean;
  steps: number;
  latestTool: WorkToolEventRow | null;
  approvals: readonly WorkApprovalRow[];
  now: Date;
}): LiveRun {
  const { run } = input;
  const latest = record(input.latestTool?.payload);
  const toolName = read(latest, ["tool", "name", "toolName"]);
  const approvals = input.approvals
    .filter((row) => row.decision === "pending" && row.expiresAt.getTime() > input.now.getTime())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map<LiveRunApproval>((row) => ({
      id: row.id,
      summary: clip(row.summary, 200) ?? "Approval required",
      detail: null,
      risk: row.risk,
      highRisk: isHighRisk(row.risk),
      actionDigest: row.actionDigest,
      requestedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }));
  const ref: LiveRunRef = { kind: "work", runId: run.id };
  const target = (run.effectiveTarget ?? run.requestedTarget) === "cloud" ? "cloud" : "mac";
  return {
    key: liveRunKey(ref),
    ref,
    kind: "work",
    title: run.sessionTitle,
    hostName: target === "cloud" ? null : input.hostName,
    target,
    status: approvals.length > 0 ? "waiting_approval" : WORK_STATUS[run.status] ?? "running",
    rawStatus: run.status,
    steps: input.steps,
    currentAction: clip(read(latest, ["summary", "title"]) ?? toolName),
    usesComputer: Boolean(toolName && COMPUTER_TOOL.test(toolName)),
    startedAt: (run.startedAt ?? run.createdAt).toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    costUsd: run.costMicroUsd > 0 ? run.costMicroUsd / 1_000_000 : null,
    hostOnline: target === "cloud" ? true : input.hostOnline,
    canStop: true,
    approvals,
  };
}

/** Needs-you first, then the most recently active. */
export function sortLiveRuns(runs: LiveRun[]): LiveRun[] {
  return [...runs].sort((a, b) => {
    const needs = Number(b.approvals.length > 0) - Number(a.approvals.length > 0);
    if (needs !== 0) return needs;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * The stream's change detector. A snapshot is sent when this changes, so it
 * covers everything a row renders and nothing that ticks on its own.
 */
export function liveRunsDigest(runs: readonly LiveRun[]): string {
  return JSON.stringify(runs);
}
