/**
 * Retention of agent computers: implemented, and OFF unless the owner turns it on
 * (docs/design/agents-v2/COMPUTERS_2026-10.md D14, S2.6).
 *
 * Deleting a computer deletes the person's files and every site they signed in
 * to in its browser, so it is an owner decision that needs a notice to users
 * first. It takes BOTH:
 *   AGENT_COMPUTER_RETENTION_ENFORCE=1   (exactly "1"; anything else is off)
 *   AGENT_COMPUTER_RETENTION_DAYS=<n>    (a whole number of days, at least 7)
 * Then a computer that has been asleep, with no lease, no stream and nobody in
 * control, and that nobody used or watched for n days, is deleted with its
 * volumes through the same path as Delete.
 *
 * The old COMPUTER_RETENTION_DAYS is never read for deletion. Three docs once
 * gave it a default of 30, so an owner may already have it in a production env
 * file; honouring it would start deleting the day computers are enabled, with
 * no decision. When it is set the sweep says once that it is ignored.
 *
 * This is the only parser of these variables. Pure (no `server-only`), so a
 * test can reach it.
 */
import type { AgentComputerRow } from "./store";

export interface RetentionPolicy {
  /** True only with the switch AND a valid number of days. */
  enforce: boolean;
  days: number | null;
  /** COMPUTER_RETENTION_DAYS is set (and ignored). */
  legacyIgnored: boolean;
  /** Why nothing is deleted although something was set, for one log line. */
  problem: string | null;
}

export const RETENTION_MIN_DAYS = 7;

export const LEGACY_RETENTION_IGNORED =
  "COMPUTER_RETENTION_DAYS is ignored. Deleting computers needs AGENT_COMPUTER_RETENTION_ENFORCE=1 and AGENT_COMPUTER_RETENTION_DAYS; see OPERATIONS.md.";

/** The retention audit writer's shape (S3 passes `recordComputerAudit`; until then, a log line). */
export type RetentionAuditWriter = (input: {
  userId: string;
  agentId: string;
  kind: "retention_deleted";
  actor: "sweep";
  detail?: { days?: number };
}) => Promise<void>;

export function computerRetentionPolicy(env: Readonly<Record<string, string | undefined>> = process.env): RetentionPolicy {
  const legacyIgnored = (env.COMPUTER_RETENTION_DAYS ?? "").trim() !== "";
  const rawDays = (env.AGENT_COMPUTER_RETENTION_DAYS ?? "").trim();
  if (env.AGENT_COMPUTER_RETENTION_ENFORCE !== "1") {
    return {
      enforce: false,
      days: null,
      legacyIgnored,
      problem: rawDays
        ? "AGENT_COMPUTER_RETENTION_DAYS is set but AGENT_COMPUTER_RETENTION_ENFORCE is not 1, so no computer is deleted for age."
        : null,
    };
  }
  if (!/^\d{1,6}$/.test(rawDays)) {
    return {
      enforce: false,
      days: null,
      legacyIgnored,
      problem:
        "AGENT_COMPUTER_RETENTION_ENFORCE is 1 but AGENT_COMPUTER_RETENTION_DAYS is not a whole number of days, so no computer is deleted for age.",
    };
  }
  const days = Number(rawDays);
  if (days < RETENTION_MIN_DAYS) {
    return {
      enforce: false,
      days: null,
      legacyIgnored,
      problem: `AGENT_COMPUTER_RETENTION_DAYS must be at least ${RETENTION_MIN_DAYS}, so no computer is deleted for age.`,
    };
  }
  return { enforce: true, days, legacyIgnored, problem: null };
}

type RetentionRow = Pick<
  AgentComputerRow,
  | "userId"
  | "agentId"
  | "status"
  | "leaseRunId"
  | "streamOn"
  | "lastActiveAt"
  | "lastViewedAt"
  | "createdAt"
  | "takeoverBy"
  | "takeoverUntil"
  | "creationExpiresAt"
>;

/**
 * The computers retention would delete now: none unless enforcing; otherwise
 * asleep, unleased, not streaming, nobody in control, not mid-creation, and
 * neither used (lastActiveAt, or its creation when it was never used) nor
 * watched (lastViewedAt; never counts as long ago) within the last N days.
 */
export function retentionCandidates<T extends RetentionRow>(rows: T[], now: Date, policy: RetentionPolicy): T[] {
  if (!policy.enforce || !policy.days || policy.days < RETENTION_MIN_DAYS) return [];
  const cutoff = now.getTime() - policy.days * 86_400_000;
  return rows.filter((row) => {
    if (row.status !== "asleep" || row.leaseRunId || row.streamOn) return false;
    if (row.takeoverBy || (row.takeoverUntil && row.takeoverUntil.getTime() > now.getTime())) return false;
    if (row.creationExpiresAt && row.creationExpiresAt.getTime() > now.getTime()) return false;
    const lastUsed = (row.lastActiveAt ?? row.createdAt)?.getTime() ?? now.getTime();
    const lastViewed = row.lastViewedAt?.getTime() ?? 0;
    return lastUsed < cutoff && lastViewed < cutoff;
  });
}
