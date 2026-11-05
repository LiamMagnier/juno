/**
 * Stop and answer a live run from anywhere — the iPhone's Runs screen and Live
 * Activity first, and the web's agents tree on the same endpoints.
 *
 * This file adds no authority of its own. Each action resolves to a path that
 * already existed and already carried the rules:
 *
 *  - Code stop/approval: the relay's per-session command queue, behind the
 *    same ownership check and the same remote-control pair check
 *    (`requireRemotePair`) as `/api/code/devices/…/stop` and `…/approvals`.
 *    The Mac still applies its own permission ladder and consequential-action
 *    floor when it reads the answer; the phone only ever answers a question
 *    the Mac asked.
 *  - Work stop/approval: the Work control and decision routes themselves,
 *    which own the single terminal writer (`finishRun`), the digest and
 *    policy checks, the write-once decision, and their own audit rows.
 *
 * What it does add is what a remote supervisor needs and those paths did not
 * give: a Stop that is idempotent across retries, double taps and two devices
 * (a second Stop is "already stopping/stopped", never an error or a second
 * command), a refusal to answer a Code request the journal no longer shows as
 * pending, a refusal to approve in a mode that forbids acting, and an audit
 * row for every Code stop and answer, which had none.
 *
 * The dependencies are injected so the rules are tested without a database;
 * `remote-control-prisma.ts` wires the real ones.
 */
import type { WorkActor, WorkAuditKind, WorkAuditSeverity } from "@/lib/work/domain";
import {
  codeSessionIsLive,
  LIVE_WORK_RUN_STATUSES,
  pendingCodeApprovals,
  type CodeEventRow,
  type LiveRunRef,
} from "@/lib/runs/live-runs";

export type RemoteActor = Extract<WorkActor, "web" | "macos" | "ios">;

export interface ControlResult {
  status: number;
  body: Record<string, unknown>;
}

export interface CodeSessionForControl {
  /** The relay row id (`CodeRemoteSession.id`). */
  id: string;
  isRunning: boolean;
  isAwaitingApproval: boolean;
  currentStatus: string;
  permissionMode: string;
  lastEventSequence: number;
}

export interface EnqueuedCommand {
  commandId: string;
  status: string;
  /** False when the idempotency key resolved to a command already queued. */
  created: boolean;
  payload: Record<string, unknown>;
}

export interface RunControlDeps {
  findCodeSession(userId: string, deviceId: string, sessionId: string): Promise<CodeSessionForControl | null>;
  /** The newest `take` journal events of one relay session row. */
  codeEventsTail(userId: string, remoteSessionId: string, take: number): Promise<CodeEventRow[]>;
  /** Null when this caller holds a live pair with the Mac, else the refusal. */
  requireCodePair(userId: string, deviceId: string): Promise<ControlResult | null>;
  enqueueCodeCommand(input: {
    userId: string;
    deviceId: string;
    sessionId: string;
    remoteSessionId: string;
    kind: "stop" | "approval";
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<EnqueuedCommand>;
  findWorkRun(userId: string, runId: string): Promise<{ id: string; sessionId: string; status: string; hostId: string | null } | null>;
  /** The Work control route's cancel, as it answers. */
  cancelWorkRun(runId: string): Promise<ControlResult>;
  findWorkApproval(userId: string, approvalId: string): Promise<{ id: string; runId: string } | null>;
  /** The Work decision route, as it answers. */
  decideWorkApproval(approvalId: string, body: { decision: "allowed" | "denied"; actionDigest: string }): Promise<ControlResult>;
  audit(input: {
    userId: string;
    kind: WorkAuditKind;
    severity?: WorkAuditSeverity;
    actor: RemoteActor;
    sessionId?: string | null;
    runId?: string | null;
    hostId?: string | null;
    detail: Record<string, unknown>;
  }): Promise<void>;
}

/** How far back the journal is read to find an open question. */
export const CODE_APPROVAL_JOURNAL_WINDOW = 400;

/**
 * Modes in which nothing may be approved into happening. A Mac in one of
 * these never asks; an "approve" naming one is forged or stale, and the
 * server refuses it rather than trusting the Mac to.
 */
const NON_ACTING_MODE = /plan|read.?only|readonly|ask.?only/i;

export function modeForbidsApproval(permissionMode: string): boolean {
  return NON_ACTING_MODE.test(permissionMode);
}

/** One stop per session state: two taps, two phones or a retry share it. */
export function codeStopKey(remoteSessionId: string, lastEventSequence: number): string {
  return `runs-stop:${remoteSessionId}:${lastEventSequence}`;
}

/** One answer per Code request, whichever device sends it first. */
export function codeApprovalKey(remoteSessionId: string, requestId: string): string {
  return `runs-approval:${remoteSessionId}:${requestId}`.slice(0, 200);
}

const LIVE_WORK = new Set(LIVE_WORK_RUN_STATUSES);

export async function stopRun(
  deps: RunControlDeps,
  input: { userId: string; actor: RemoteActor; ref: LiveRunRef }
): Promise<ControlResult> {
  const { userId, actor, ref } = input;
  if (ref.kind === "code") {
    const session = await deps.findCodeSession(userId, ref.deviceId, ref.sessionId);
    if (!session) return { status: 404, body: { error: "not_found", message: "That run no longer exists." } };
    if (!codeSessionIsLive(session)) {
      return { status: 200, body: { outcome: "already_stopped", status: session.currentStatus } };
    }
    const unpaired = await deps.requireCodePair(userId, ref.deviceId);
    if (unpaired) return unpaired;
    const idempotencyKey = codeStopKey(session.id, session.lastEventSequence);
    const command = await deps.enqueueCodeCommand({
      userId,
      deviceId: ref.deviceId,
      sessionId: ref.sessionId,
      remoteSessionId: session.id,
      kind: "stop",
      payload: {},
      idempotencyKey,
    });
    if (command.created) {
      await deps.audit({
        userId,
        kind: "run_stop_requested",
        actor,
        detail: { kind: "code", deviceId: ref.deviceId, sessionId: ref.sessionId, commandId: command.commandId, idempotencyKey },
      });
    }
    return {
      status: command.status === "pending" ? 202 : 200,
      body: {
        outcome: command.created ? "stop_requested" : "already_stopping",
        commandId: command.commandId,
        commandStatus: command.status,
      },
    };
  }

  const run = await deps.findWorkRun(userId, ref.runId);
  if (!run) return { status: 404, body: { error: "not_found", message: "That run no longer exists." } };
  if (!LIVE_WORK.has(run.status)) return { status: 200, body: { outcome: "already_stopped", status: run.status } };
  const result = await deps.cancelWorkRun(run.id);
  // The control route answers 409 `run_not_live` when the run left a live
  // status between the read above and its own conditional write — a stop that
  // raced the run's own ending, or another device's stop. Either way the run
  // is stopped, which is what was asked.
  if (result.status === 409 && result.body.error === "run_not_live") {
    return { status: 200, body: { outcome: "already_stopped", status: result.body.status ?? run.status } };
  }
  if (result.status < 200 || result.status > 299) return result;
  await deps.audit({
    userId,
    kind: "run_stop_requested",
    actor,
    sessionId: run.sessionId,
    runId: run.id,
    hostId: run.hostId,
    detail: { kind: "work", runId: run.id },
  });
  return { status: 200, body: { outcome: "stopped", ...result.body } };
}

export async function decideRunApproval(
  deps: RunControlDeps,
  input: {
    userId: string;
    actor: RemoteActor;
    ref: LiveRunRef;
    approvalId: string;
    approve: boolean;
    actionDigest?: string | null;
  }
): Promise<ControlResult> {
  const { userId, actor, ref, approvalId, approve } = input;
  if (ref.kind === "work") {
    const approval = await deps.findWorkApproval(userId, approvalId);
    // Bound to the run it was shown under: an id lifted from one run's card
    // cannot answer another run's question.
    if (!approval || approval.runId !== ref.runId) {
      return { status: 404, body: { error: "not_found", message: "That request no longer exists." } };
    }
    if (!input.actionDigest) {
      return { status: 400, body: { error: "invalid_input", message: "The request's digest is required." } };
    }
    return deps.decideWorkApproval(approval.id, {
      decision: approve ? "allowed" : "denied",
      actionDigest: input.actionDigest,
    });
  }

  const session = await deps.findCodeSession(userId, ref.deviceId, ref.sessionId);
  if (!session) return { status: 404, body: { error: "not_found", message: "That run no longer exists." } };
  const refuse = async (code: string, status: number, message: string): Promise<ControlResult> => {
    await deps.audit({
      userId,
      kind: "approval_replay_refused",
      severity: "refusal",
      actor,
      detail: { kind: "code", deviceId: ref.deviceId, sessionId: ref.sessionId, requestId: approvalId, decision: approve ? "allowed" : "denied", reason: code },
    });
    return { status, body: { error: code, message } };
  };
  if (approve && modeForbidsApproval(session.permissionMode)) {
    return refuse("mode_forbids", 403, "This session's mode does not allow approving actions.");
  }
  const pending = pendingCodeApprovals(await deps.codeEventsTail(userId, session.id, CODE_APPROVAL_JOURNAL_WINDOW));
  if (!pending.some((approval) => approval.id === approvalId)) {
    return refuse("approval_not_pending", 409, "This request has already been answered or has gone.");
  }
  const unpaired = await deps.requireCodePair(userId, ref.deviceId);
  if (unpaired) return unpaired;
  const idempotencyKey = codeApprovalKey(session.id, approvalId);
  const command = await deps.enqueueCodeCommand({
    userId,
    deviceId: ref.deviceId,
    sessionId: ref.sessionId,
    remoteSessionId: session.id,
    kind: "approval",
    payload: { requestId: approvalId, approved: approve },
    idempotencyKey,
  });
  if (!command.created) {
    // Write-once, like a Work approval: the first device to answer wins, and a
    // different second answer is a conflict, not a silent overwrite.
    const recorded = command.payload.approved ?? command.payload.approve;
    if (recorded !== approve) {
      return refuse("already_decided", 409, "This request has already been answered.");
    }
    return { status: 200, body: { outcome: "already_decided", replay: true, commandId: command.commandId, commandStatus: command.status } };
  }
  await deps.audit({
    userId,
    kind: "approval_decided",
    actor,
    detail: { kind: "code", deviceId: ref.deviceId, sessionId: ref.sessionId, requestId: approvalId, commandId: command.commandId, decision: approve ? "allowed" : "denied" },
  });
  return {
    status: command.status === "pending" ? 202 : 200,
    body: { outcome: "decision_sent", commandId: command.commandId, commandStatus: command.status },
  };
}
