/**
 * Approval integrity for Juno Work.
 *
 * An approval is a promise the user made about one exact thing. Everything in
 * this file exists to stop that promise being spent on something else, and
 * there are two concrete ways that happens.
 *
 * The first is action substitution. The user is shown "Move 14 files from
 * Downloads to Archive" and taps Allow. The approval row now says
 * `decision: "allowed"`. If the executor consults only that column, anything it
 * does next is authorised — including the delete it was refused ten seconds
 * earlier, a second move to a different folder, or the same move re-run against
 * a directory whose contents changed while the user was reading. Binding the
 * approval to a hash of the exact normalised action means the executor can ask
 * a different question: not "was something allowed" but "was THIS allowed".
 * A digest over an action nobody approved simply does not match.
 *
 * The second is policy widening by the back door. The user approves a Gmail
 * send while the session is running under `permissive`. Before the executor
 * gets to it, the user (or the host, or the project) narrows the policy to
 * `conservative` — the whole point of which is that sends now stop and ask. An
 * approval carrying no record of the policy it was granted under would sail
 * straight through that change, and the narrowing would have had no effect on
 * the one operation it was aimed at. Hashing the resolved policy alongside the
 * action makes the change detectable: the digests no longer agree, and the
 * approval has to be asked again under the rules that are actually in force.
 *
 * Deliberately pure — no Prisma, no `server-only`, no clock. The executor, the
 * relay, the route handlers and the tests all need to compute and check these,
 * and the digest is only worth anything if every one of them computes it the
 * same way.
 */

import { createHash } from "node:crypto";
import type { WorkApprovalDecision } from "@/lib/work/domain";

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped, no whitespace.
 *
 * `JSON.stringify` preserves insertion order, so `{a, b}` and `{b, a}` — the
 * same action, built by two code paths, or round-tripped through a JSONB column
 * that did not preserve the original order — hash differently. A digest that
 * changes when nothing about the action changed proves nothing: every mismatch
 * becomes noise, and the check gets disabled by whoever is on call the night it
 * starts firing.
 */
export function canonicalize(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      // JSON has no NaN or Infinity. Writing `null` for both is what
      // JSON.stringify does, and matching it keeps the canonical form parseable.
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      // As a string, because a bigint large enough to matter cannot survive
      // JSON.parse as a number and would come back a different value.
      return JSON.stringify(value.toString());
    case "undefined":
    case "function":
    case "symbol":
      // Only reachable inside an array, where JSON writes a hole as `null`.
      // As an object property these are dropped by the object branch below.
      return "null";
    default:
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) {
    // A cycle has no canonical form, and silently emitting a placeholder would
    // make two genuinely different actions hash the same.
    throw new TypeError("canonicalize: a cyclic value has no canonical form");
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, ancestors)).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol"
    );
    // Compared by UTF-16 code unit, never `localeCompare`: a locale-aware sort
    // orders keys differently on a host with a different ICU build, which would
    // make the same action hash differently on two machines in the same fleet.
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Domain separation tags.
 *
 * Without them, a policy blob and an action detail that happen to canonicalise
 * to the same bytes produce the same digest, and a value stored in one column
 * would satisfy a check against the other.
 */
const ACTION_DIGEST_DOMAIN = "juno.work.approval.action.v1";
const POLICY_DIGEST_DOMAIN = "juno.work.approval.policy.v1";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The digest an executor recomputes immediately before acting.
 *
 * The action name goes in as a JSON string rather than raw, so the boundary
 * between it and the detail cannot be moved: `"work.file.move"` followed by one
 * detail can never produce the same bytes as `"work.file.mov"` followed by
 * another, which a bare concatenation would allow.
 */
export function actionDigest(action: string, detail: unknown): string {
  return sha256Hex(`${ACTION_DIGEST_DOMAIN}\n${canonicalize(action)}\n${canonicalize(detail)}`);
}

/** The digest of the resolved permission policy in force at approval time. */
export function policyDigest(policy: unknown): string {
  return sha256Hex(`${POLICY_DIGEST_DOMAIN}\n${canonicalize(policy)}`);
}

export type ApprovalRefusalReason =
  /** The action about to run is not the action that was approved. */
  | "digest_mismatch"
  /** The policy narrowed after the approval was granted. */
  | "policy_changed"
  /** The approval's answering window has passed. */
  | "expired"
  /** Answered, but not with a yes. */
  | "not_allowed";

export type ApprovalVerification = { ok: true } | { ok: false; reason: ApprovalRefusalReason };

export interface ApprovalVerificationInput {
  /** `WorkApproval.actionDigest`, as stored when the user was asked. */
  storedDigest: string;
  /** `WorkApproval.policyDigest`, as stored when the user was asked. */
  storedPolicyDigest: string;
  /** The action the executor is about to perform, right now. */
  action: string;
  /** That action's detail, in the same shape it was described to the user in. */
  detail: unknown;
  /** The resolved permission policy in force right now. */
  policy: unknown;
  decision: WorkApprovalDecision;
  expiresAt: Date;
  /** Injected rather than read from the clock, so the boundary is testable. */
  now: Date;
}

/**
 * The last gate before an approved action runs.
 *
 * Order matters, because the refusal reason is what lands in the audit log as a
 * `approval_replay_refused` and is the only thing an investigator will have.
 * The digest is checked first: an approval being spent on a different action is
 * a materially different finding from an approval that had simply lapsed, and
 * reporting the lapse first would hide the substitution behind it.
 *
 * Expiry applies to `allowed_always` as well. A standing "always allow" is a
 * policy fact, resolved by the policy layer for actions the user has not seen
 * yet; this row is a record of one answer to one question, and letting the
 * `allowed_always` case skip expiry would turn it into an immortal token for
 * that exact action.
 */
export function verifyApproval(input: ApprovalVerificationInput): ApprovalVerification {
  if (actionDigest(input.action, input.detail) !== input.storedDigest) {
    return { ok: false, reason: "digest_mismatch" };
  }
  if (policyDigest(input.policy) !== input.storedPolicyDigest) {
    return { ok: false, reason: "policy_changed" };
  }
  if (input.decision !== "allowed" && input.decision !== "allowed_always") {
    // `expired` is one of the decisions a sweeper writes, and it deserves its
    // own reason: "not_allowed" reads as "the user said no", which is a
    // different conversation to have with them afterwards.
    return { ok: false, reason: input.decision === "expired" ? "expired" : "not_allowed" };
  }
  if (input.now.getTime() >= input.expiresAt.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}
