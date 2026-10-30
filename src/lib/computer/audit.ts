/**
 * The operator audit for agents' computers (docs/design/agents-v2/COMPUTERS_2026-10.md
 * §4.4, D2): one row per thing that happened to a computer, in its own table
 * (`AgentComputerAudit`), not in the person's visible agent log (rest and wake
 * every few minutes would flood it) and not in `WorkAuditEvent`.
 *
 * Identifiers and verdicts only. The detail keeps the keys listed in
 * `ALLOWED_DETAIL_KEYS` and drops everything else, so a caller cannot put a
 * path, a command, a container id, an address, a password or a token in it by
 * accident. A write never throws: the audit is a record, never a precondition.
 *
 * No `server-only` import: the store's tests reach it, and the database is
 * only loaded when a row is written.
 */

export const COMPUTER_AUDIT_KINDS = [
  "enabled",
  "disabled",
  "reset",
  "policy_changed",
  "start_requested",
  "started",
  "rested",
  "slept",
  "woke",
  "takeover_started",
  "takeover_handed_back",
  "takeover_lapsed",
  "freeze_failed",
  "freeze_unavailable",
  "thaw_failed",
  /** A thaw met a take over that opened while it was in flight, and the agent was stopped again. */
  "refrozen",
  "rotate_failed",
  "refused",
  "retention_deleted",
  "rebuilt",
  "image_stale",
  "sandbox_check_failed",
  "host_unreachable",
  "host_reachable",
  "file_uploaded",
  "file_published",
  "browser_sandbox",
] as const;

export type ComputerAuditKind = (typeof COMPUTER_AUDIT_KINDS)[number];
export type ComputerAuditActor = "web" | "app" | "runner" | "sweep" | "chat" | "system";

export interface ComputerAuditDetail {
  by?: "run" | "person" | "view";
  reason?: string;
  via?: "web" | "app" | "access_lost";
  heldSeconds?: number;
  runId?: string;
  bytes?: number;
  state?: string;
  minutes?: number;
  days?: number;
  policyFrom?: string;
  policyTo?: string;
}

const ALLOWED_DETAIL_KEYS = new Set<keyof ComputerAuditDetail>([
  "by",
  "reason",
  "via",
  "heldSeconds",
  "runId",
  "bytes",
  "state",
  "minutes",
  "days",
  "policyFrom",
  "policyTo",
]);

const ACTORS = new Set<ComputerAuditActor>(["web", "app", "runner", "sweep", "chat", "system"]);
const KINDS = new Set<string>(COMPUTER_AUDIT_KINDS);

export interface ComputerAuditRow {
  userId: string;
  agentId: string;
  kind: ComputerAuditKind;
  actor: ComputerAuditActor;
  detail: ComputerAuditDetail;
}

/** Strings in a detail are short identifiers or verdicts; anything longer is cut. */
const MAX_DETAIL_STRING = 64;

/** Only the allowed keys, with string values clipped and numbers kept finite. */
export function cleanComputerAuditDetail(detail: ComputerAuditDetail | undefined): ComputerAuditDetail {
  const clean: Record<string, string | number> = {};
  if (!detail) return clean;
  for (const [key, value] of Object.entries(detail)) {
    if (!ALLOWED_DETAIL_KEYS.has(key as keyof ComputerAuditDetail)) continue;
    if (typeof value === "string") clean[key] = value.slice(0, MAX_DETAIL_STRING);
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = Math.round(value);
  }
  return clean as ComputerAuditDetail;
}

type AuditSink = (row: ComputerAuditRow) => Promise<void>;

let testSink: AuditSink | null = null;

/** Test seam: route rows to memory instead of the database (null restores the database). */
export function setComputerAuditSinkForTest(sink: AuditSink | null): void {
  testSink = sink;
}

async function databaseSink(row: ComputerAuditRow): Promise<void> {
  const { prisma } = await import("@/lib/db");
  await prisma.agentComputerAudit.create({
    data: { userId: row.userId, agentId: row.agentId, kind: row.kind, actor: row.actor, detail: row.detail as object },
  });
}

/** Never throws: a failed write logs the kind and the ids, and is swallowed. Unknown detail keys are dropped. */
export async function recordComputerAudit(input: {
  userId: string;
  agentId: string;
  kind: ComputerAuditKind;
  actor: ComputerAuditActor;
  detail?: ComputerAuditDetail;
}): Promise<void> {
  if (!KINDS.has(input.kind) || !ACTORS.has(input.actor)) {
    console.error("[agent-computer] audit row refused", { kind: String(input.kind), actor: String(input.actor) });
    return;
  }
  const row: ComputerAuditRow = {
    userId: input.userId,
    agentId: input.agentId,
    kind: input.kind,
    actor: input.actor,
    detail: cleanComputerAuditDetail(input.detail),
  };
  try {
    await (testSink ?? databaseSink)(row);
  } catch {
    console.error("[agent-computer] audit write failed", { kind: row.kind, userId: row.userId, agentId: row.agentId });
  }
}

export type ComputerAuditWriter = typeof recordComputerAudit;
