import "server-only";
import { prismaUnguarded } from "@/lib/db";
import type { WorkActor, WorkAuditKind, WorkAuditSeverity } from "@/lib/work/domain";

/**
 * The security and compliance log for Juno Work.
 *
 * This is not the user's transcript. `WorkEvent` is that, and it is
 * cascade-deleted with the session it belongs to. This table answers the
 * questions asked after an incident — who granted access to what folder, which
 * host claimed which command, what was refused and on what grounds — and those
 * are asked months later, often about a session the user has since deleted.
 *
 * Retaining it for longer than the work is therefore the point, and it is only
 * defensible if the log never contains the work. That is what
 * `sanitizeAuditDetail` enforces: a hard allowlist of keys, and scalars only.
 * Not a denylist of the obviously dangerous fields, because a denylist has to
 * be extended every time somebody invents a new name for a file path, and the
 * one that gets missed is the one that ends up in a five-year retention bucket.
 */

/**
 * The only keys a `detail` may carry.
 *
 * Identifiers, counts, verdicts, capability names, host state and durations.
 * Anything that could hold a fragment of the user's work — a path, a filename,
 * a subject line, a cell value, a prompt, a model sentence — has no key here
 * and is dropped without comment.
 */
const ALLOWED_AUDIT_KEYS: ReadonlySet<string> = new Set([
  // Identifiers. Opaque row ids and stable names, never display text.
  "sessionId",
  "runId",
  "hostId",
  "deviceId",
  "grantId",
  "commandId",
  "approvalId",
  "artifactId",
  "scheduleId",
  "triggerId",
  "skillId",
  "skillSlug",
  "skillVersion",
  "executorId",
  "connectorId",
  "requestId",
  "eventKey",
  "idempotencyKey",
  "model",

  // What was attempted, named in the vocabulary of domain.ts.
  "action",
  "kind",
  "capability",
  "capabilities",
  "tool",
  "toolTier",
  "grantKind",
  "artifactKind",
  "commandKind",
  "triggerKind",
  "target",
  "effectiveTarget",
  "risk",
  "sensitivity",

  // Verdicts. What was decided and under which rules.
  "decision",
  "verdict",
  "outcome",
  "reason",
  "severity",
  "scanStatus",
  "findingCount",
  "requiresConsent",
  "permissionAdditions",
  "allowed",
  "refused",
  // Whether a skill's instructions went into the system prompt inside the
  // untrusted-content envelope. A boolean about how Juno framed the text, not
  // about the text — see `skillSystemSuffix`. Answering "was a stranger's
  // wording in the prompt in the clear for this run" later has to come from
  // here, because `WorkSkill.trust` is a column the user can change afterwards
  // and reading it back would rewrite the history of every run that used it.
  "untrusted",
  "accessMode",
  "policy",
  "policyBefore",
  "policyAfter",
  "unattendedPolicy",
  "terminalReason",
  // Hashes, not contents: these are what make a replay refusal provable
  // without storing the action that was replayed.
  "actionDigest",
  "policyDigest",
  "contentHash",

  // Host state, as the host advertised it.
  "hostState",
  "enabled",
  "revoked",
  "platform",
  "appVersion",
  "protocolVersion",

  // Counts and sizes.
  "count",
  "attempt",
  "attempts",
  "seq",
  "lastSeq",
  "fileCount",
  "matchCount",
  "byteSize",
  "activeRunCount",
  "queuedRunCount",

  // Durations, always milliseconds.
  "durationMs",
  "leaseMs",
  "ageMs",
  "ttlMs",
  "expiresInMs",
]);

/**
 * Caps on allowlisted values.
 *
 * The allowlist is a check on keys, so an allowlisted key holding a forty
 * kilobyte string is the same leak arriving through an open door: `reason` is
 * exactly where somebody would eventually put a model's explanation. A short
 * cap makes the column unusable for that without making it useless for the
 * verdicts it is for.
 */
const MAX_AUDIT_STRING_CHARS = 200;
const MAX_AUDIT_ARRAY_ENTRIES = 32;

type AuditScalar = string | number | boolean | null;

/** A sanitized detail: flat, scalar, and small enough to keep forever. */
export type WorkAuditDetail = Record<string, AuditScalar | AuditScalar[]>;

function scalar(value: unknown): AuditScalar | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, MAX_AUDIT_STRING_CHARS);
  return undefined;
}

/**
 * Reduces a caller's `detail` to the subset this log may hold.
 *
 * Nested objects are dropped whole rather than walked. A nested shape cannot be
 * key-checked usefully — the allowlist would have to know every path through
 * every payload any caller might pass — and the flat form is also the one an
 * investigator can query. A caller with structure to record should name the
 * pieces it actually needs.
 *
 * Exported for its own tests: the retention argument above rests entirely on
 * this function, so it is the one piece here that must be provable without a
 * database.
 */
export function sanitizeAuditDetail(detail: unknown): WorkAuditDetail {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return {};
  const clean: WorkAuditDetail = {};
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    if (!ALLOWED_AUDIT_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      const entries = value
        .slice(0, MAX_AUDIT_ARRAY_ENTRIES)
        .map(scalar)
        .filter((entry): entry is AuditScalar => entry !== undefined);
      clean[key] = entries;
      continue;
    }
    const single = scalar(value);
    if (single !== undefined) clean[key] = single;
  }
  return clean;
}

export interface WorkAuditInput {
  /** The account the event is ABOUT, which is not always the caller's. */
  userId: string;
  kind: WorkAuditKind;
  severity?: WorkAuditSeverity;
  actor?: WorkActor;
  sessionId?: string | null;
  runId?: string | null;
  hostId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Appends one row to the compliance log.
 *
 * Never throws. That is a deliberate trade and worth naming, because "fail
 * closed" is the usual instinct for a security log. It is the wrong instinct
 * here: every event this function records has already happened. The folder was
 * granted, the host was revoked, the replayed approval was refused. Failing the
 * caller would not un-happen any of them — it would stack a second failure on
 * the first, and in the refusal cases it would turn "Juno said no and wrote it
 * down" into "Juno crashed", which is strictly worse for the user and no better
 * for whoever reads the log later. The cost is that a database outage loses
 * records silently, so the failure goes to the operator console, which is the
 * one place that does not depend on the database being up.
 */
export async function recordWorkAudit(input: WorkAuditInput): Promise<void> {
  try {
    // Unguarded on purpose. `userId` here is the subject of the audit, not the
    // requesting user: the host relay and the scheduler both write these while
    // sweeping across accounts, with no session user to scope to. The guarded
    // client would not object today — `create` is outside GUARDED_OPERATIONS —
    // and that is exactly the accident worth avoiding, because the day `create`
    // joins the set is the day the audit writer starts throwing inside the
    // paths that need it most.
    await prismaUnguarded.workAuditEvent.create({
      data: {
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        hostId: input.hostId ?? null,
        kind: input.kind,
        severity: input.severity ?? "info",
        actor: input.actor ?? "cloud_runner",
        detail: sanitizeAuditDetail(input.detail),
      },
    });
  } catch (err) {
    console.error("[work-audit] failed to record event", {
      kind: input.kind,
      severity: input.severity ?? "info",
      sessionId: input.sessionId ?? null,
      hostId: input.hostId ?? null,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
