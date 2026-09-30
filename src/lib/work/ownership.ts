/**
 * Who owns a task, and when that may change.
 *
 * A task (`WorkSession`) belongs to the account always, and to at most one crew
 * member: `agentId`, the member it runs as. The member's brief, apps, approval
 * mode and budget are the ones its runs are given, and its face counts the
 * task towards its state. Ownership is a different fact from the executor
 * lease on a run (`WorkRun.claimedBy/leaseExpiresAt`), which only says which
 * process is executing one attempt right now; the two are never merged.
 *
 * Ownership changes in exactly one way: a transfer. A transfer names who asked
 * for it, the member it goes to (or the person, `null`), and why, and it is
 * refused unless the task is at a safe point, because a run that is mid-step
 * was started with the old owner's identity, apps and approval mode and would
 * finish the step as somebody else. What counts as safe is decided here, as a
 * pure function, so the route, the chat tool and the tests read one rule.
 *
 * `tests/work-ownership.test.ts` covers every branch.
 */

import {
  isTerminalStatus,
  narrowestPolicy,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";

/** The longest reason kept on a transfer. It is one sentence a person reads in the task's log. */
export const MAX_TRANSFER_REASON_CHARS = 500;

/**
 * Statuses at which ownership may change, beside any terminal status.
 *
 * `draft` has never run. `paused` stopped at a checkpoint and is resumed as a
 * fresh claim that re-reads the session. `queued` is safe only while no
 * executor holds the lease (the transfer function checks that separately).
 * `preparing`, `running`, `waiting_input` and `waiting_approval` are not: an
 * executor is holding the attempt open with the old owner's identity, and
 * waiting on the person is still inside that attempt.
 */
const SAFE_LIVE_STATUSES = new Set(["draft", "paused", "queued"]);

export interface OwnerTransferInput {
  status: string;
  /** The session's current owner. */
  fromAgentId: string | null;
  /** The owner asked for. `null` hands the task back to the person. */
  toAgentId: string | null;
  /** `status` of the member it goes to, when it goes to one. */
  toAgentStatus?: string | null;
  /** Display names, for the sentences below. */
  fromName?: string | null;
  toName?: string | null;
  /** The current attempt's executor lease, when there is an attempt. */
  run?: { status: string; claimedBy: string | null; leaseExpiresAt: Date | null } | null;
  reason: string;
  now: Date;
}

export type OwnerTransferRefusalCode =
  | "same_owner"
  | "member_paused"
  | "not_at_safe_point"
  | "reason_required";

export interface OwnerTransferRefusal {
  code: OwnerTransferRefusalCode;
  message: string;
}

/**
 * Why this transfer may not happen, or null when it may.
 *
 * The order is the policy: a reason is required first (a transfer nobody can
 * explain later is the thing the record exists to prevent), then the no-op,
 * then the target's own state, then the task's.
 */
export function ownerTransferRefusal(input: OwnerTransferInput): OwnerTransferRefusal | null {
  if (!input.reason.trim()) {
    return { code: "reason_required", message: "Say why the task is moving, so its log can show it later." };
  }
  if ((input.fromAgentId ?? null) === (input.toAgentId ?? null)) {
    return {
      code: "same_owner",
      message: input.toAgentId
        ? `${input.toName?.trim() || "That crew member"} already owns this task.`
        : "You already own this task.",
    };
  }
  if (input.toAgentId && input.toAgentStatus && input.toAgentStatus !== "active") {
    return {
      code: "member_paused",
      message: `${input.toName?.trim() || "That crew member"} is paused. Resume them before handing them work.`,
    };
  }
  if (!isAtSafePoint({ status: input.status, run: input.run ?? null, now: input.now })) {
    return {
      code: "not_at_safe_point",
      message:
        "This task is in the middle of a step. Pause it, or let it finish or ask its question, then hand it over.",
    };
  }
  return null;
}

/**
 * Whether no executor is part-way through this task.
 *
 * A queued attempt that an executor has claimed is past the point of no
 * return even though its status has not moved yet: the claim and the status
 * change are two writes, and the lease is the one that is true first. An
 * expired lease is nobody's, which is the same rule the lease sweep applies.
 */
export function isAtSafePoint(input: {
  status: string;
  run: { status: string; claimedBy: string | null; leaseExpiresAt: Date | null } | null;
  now: Date;
}): boolean {
  if (isTerminalStatus(input.status)) return true;
  if (!SAFE_LIVE_STATUSES.has(input.status)) return false;
  if (input.status !== "queued") return true;
  const run = input.run;
  if (!run || !run.claimedBy) return true;
  return run.leaseExpiresAt !== null && run.leaseExpiresAt.getTime() <= input.now.getTime();
}

/**
 * The approval mode a task keeps after it changes hands.
 *
 * Never wider than it was: a task moving to a member who runs everything
 * without asking keeps the stricter mode it was started under, and a task
 * moving to a stricter member takes that member's mode. Handing a task back to
 * the person keeps the mode it had.
 */
export function transferredPermissionPolicy(input: {
  current: WorkPermissionPolicy;
  toMemberMode: WorkPermissionPolicy | null;
}): WorkPermissionPolicy {
  return input.toMemberMode ? narrowestPolicy(input.current, input.toMemberMode) : input.current;
}

/**
 * The apps a task keeps after it changes hands: only those the new member may
 * use. A member cannot be handed access it was never given by being handed a
 * task that had it. Back to the person, the task keeps what it was granted.
 */
export function transferredConnectorIds(input: {
  current: readonly string[];
  toMemberConnectorIds: readonly string[] | null;
}): string[] {
  if (!input.toMemberConnectorIds) return [...input.current];
  const allowed = new Set(input.toMemberConnectorIds);
  return input.current.filter((id) => allowed.has(id));
}

/** The `owner_transferred` event payload, one shape for the log, the web and the apps. */
export function ownerTransferredPayload(input: {
  from: { agentId: string | null; name: string | null };
  to: { agentId: string | null; name: string | null };
  by: { kind: "person" } | { kind: "member"; agentId: string; name: string | null };
  reason: string;
  at: Date;
}): Record<string, unknown> {
  const who = (side: { agentId: string | null; name: string | null }) =>
    side.agentId ? { kind: "member", agentId: side.agentId, name: side.name } : { kind: "person" };
  return {
    from: who(input.from),
    to: who(input.to),
    by: input.by.kind === "person" ? { kind: "person" } : { kind: "member", agentId: input.by.agentId, name: input.by.name },
    reason: input.reason.trim().slice(0, MAX_TRANSFER_REASON_CHARS),
    at: input.at.toISOString(),
    summary: ownerTransferSentence(input),
  };
}

/** "Mira handed this to Otto: she is out tomorrow." — what the log line says. */
export function ownerTransferSentence(input: {
  from: { agentId: string | null; name: string | null };
  to: { agentId: string | null; name: string | null };
  by: { kind: "person" } | { kind: "member"; agentId: string; name: string | null };
  reason: string;
}): string {
  const name = (side: { agentId: string | null; name: string | null }) =>
    side.agentId ? side.name?.trim() || "a crew member" : "you";
  const actor = input.by.kind === "person" ? "You" : input.by.name?.trim() || "A crew member";
  const reason = input.reason.trim().replace(/\s+/g, " ").slice(0, 200);
  const target = input.to.agentId ? name(input.to) : "you";
  const moved =
    input.by.kind === "person" && !input.to.agentId
      ? `You took this back from ${name(input.from)}`
      : `${actor} handed this from ${name(input.from)} to ${target}`;
  return reason ? `${moved}: ${reason}` : moved;
}
