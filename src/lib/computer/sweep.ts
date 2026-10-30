import "server-only";
import { env } from "@/lib/env";
import { ComputerError, scrubComputerText } from "./errors";
import { stopStream } from "./live-view";
import { computerProvider, isAgentComputerConfigured } from "./provider";
import { recordComputerAudit } from "./audit";
import {
  LEGACY_RETENTION_IGNORED,
  computerRetentionPolicy,
  retentionCandidates,
  type RetentionAuditWriter,
  type RetentionPolicy,
} from "./retention";
import {
  computerStoreUsesDatabase,
  computerUsageBudgetRefusal,
  decodeHandle,
  disableComputer,
  diskFullError,
  getComputerStorePersistence,
  isHostUnreachable,
  noteComputerContact,
  overDiskQuota,
  restComputer,
  settleComputerOutage,
  sleepComputer,
  type AgentComputerRow,
} from "./store";
import { purgeComputerHandoffs } from "./handoff";

/** How long a computer may sit in "starting" (create, start, token provisioning) before the sweep treats it as stuck. */
const STARTING_GRACE_MS = 5 * 60_000;

export interface SweepSummary {
  reconciledAfterReboot: string[];
  stoppedStreams: string[];
  rested: string[];
  slept: string[];
  expiredLeases: string[];
  /** Containers and volumes with no computer row, removed. */
  reapedOrphans: string[];
  /** Computers this pass could not reach (their state() or a provider call threw); retried next pass. */
  skipped: string[];
  /** Computers deleted by retention (only when the owner turned it on). */
  retentionDeleted: string[];
}

/** Rows whose last pass failed, so an outage is logged once per row, not every minute. */
const unreachableRows = new Set<string>();

export interface RetentionSweepOptions {
  /** Default: computerRetentionPolicy(process.env). */
  policy?: RetentionPolicy;
  /**
   * Asleep computers to consider. Default: the database's asleep rows; none
   * for the in-memory store (tests pass their rows). Only read when enforcing.
   */
  listAsleep?: () => Promise<AgentComputerRow[]>;
  /** Default: the operator audit (recordComputerAudit, `retention_deleted`). */
  audit?: RetentionAuditWriter;
  /** Default: the same path as Delete (disableComputer: the container and both volumes). */
  destroy?: (row: AgentComputerRow) => Promise<void>;
}

const retentionLogged = new Set<string>();

function logRetentionOnce(message: string): void {
  if (retentionLogged.has(message)) return;
  retentionLogged.add(message);
  console.warn(`[agent-computer] ${message}`);
}

/** Test seam: forget what earlier sweeps logged. */
export function resetSweepLogsForTest(): void {
  unreachableRows.clear();
  retentionLogged.clear();
}

async function asleepRowsFromDatabase(): Promise<AgentComputerRow[]> {
  if (!computerStoreUsesDatabase()) return [];
  const { prismaUnguarded } = await import("@/lib/db");
  const rows = await prismaUnguarded.agentComputer.findMany({
    where: { status: "asleep", leaseRunId: null, streamOn: false },
  });
  // retentionCandidates reads only the status, lease, stream, take-over,
  // creation and activity fields, which the table carries under these names.
  return rows as unknown as AgentComputerRow[];
}

const auditRetentionDeletion: RetentionAuditWriter = async (input) => {
  console.warn("[agent-computer] retention deleted a computer", { agentId: input.agentId, days: input.detail?.days });
  await recordComputerAudit(input);
};

/**
 * Retention (COMPUTERS_2026-10.md D14): off unless the owner set both
 * AGENT_COMPUTER_RETENTION_ENFORCE=1 and AGENT_COMPUTER_RETENTION_DAYS (at
 * least 7). The old COMPUTER_RETENTION_DAYS is logged once as ignored and
 * never deletes anything. Each deletion first claims the row as still idle
 * exactly as it was read (a wake or a view in between wins), then goes
 * through the same path as Delete.
 */
async function sweepRetention(
  persistence: ReturnType<typeof getComputerStorePersistence>,
  now: Date,
  summary: SweepSummary,
  options: RetentionSweepOptions | undefined,
): Promise<void> {
  const policy = options?.policy ?? computerRetentionPolicy();
  if (policy.legacyIgnored) logRetentionOnce(LEGACY_RETENTION_IGNORED);
  if (policy.problem) logRetentionOnce(policy.problem);
  if (!policy.enforce || !policy.days) return;
  let rows: AgentComputerRow[];
  try {
    rows = await (options?.listAsleep ?? asleepRowsFromDatabase)();
  } catch {
    return;
  }
  const audit = options?.audit ?? auditRetentionDeletion;
  const destroy = options?.destroy ?? ((row: AgentComputerRow) => disableComputer(row.userId, row.agentId));
  for (const row of retentionCandidates(rows, now, policy)) {
    try {
      const claimed = await persistence.claimIdleCas(
        row.userId,
        row.agentId,
        { status: row.status, lastActiveAt: row.lastActiveAt, lastViewedAt: row.lastViewedAt },
        now
      );
      if (!claimed) continue;
      await destroy(row);
      summary.retentionDeleted.push(row.agentId);
      await audit({ userId: row.userId, agentId: row.agentId, kind: "retention_deleted", actor: "sweep", detail: { days: policy.days } });
    } catch {
      // Left for the next pass; a failed teardown leaves no row and the orphan check finishes it.
    }
  }
}

/**
 * When the sweep first saw each container or volume with no row. One is removed
 * only once it has stayed rowless this long, so a computer being created (its
 * container can exist a moment before its row) is never taken for an orphan.
 */
const ORPHAN_GRACE_MS = 10 * 60_000;
const orphanSince = new Map<string, number>();

/** Removes what a failed teardown or a deleted account left behind (security audit: teardown leak). */
async function reapOrphans(
  provider: NonNullable<ReturnType<typeof computerProvider>>,
  persistence: ReturnType<typeof getComputerStorePersistence>,
  nowMs: number,
  summary: SweepSummary,
): Promise<void> {
  const owned = await provider.listOwned();
  const known = await persistence.listAgentIdsUnguarded();
  const agentOf = (name: string) => name.replace(/^juno-agent-/, "").replace(/-browser$/, "");
  const rowless = new Set(
    [...owned.containers.map((c) => c.name), ...owned.volumes].filter((name) => !known.has(agentOf(name))),
  );
  for (const name of [...orphanSince.keys()]) if (!rowless.has(name)) orphanSince.delete(name);
  for (const name of rowless) {
    const since = orphanSince.get(name);
    if (since === undefined) {
      orphanSince.set(name, nowMs);
      continue;
    }
    if (nowMs - since < ORPHAN_GRACE_MS) continue;
    const agentId = agentOf(name);
    // The deterministic handle covers the container and both volumes.
    await provider
      .destroy({ name: `juno-agent-${agentId}`, volume: `juno-agent-${agentId}` }, { removeVolume: true })
      .then(() => {
        orphanSince.delete(name);
        summary.reapedOrphans.push(name);
      })
      .catch(() => undefined);
  }
}

/** Test seam: forget what earlier sweeps saw. */
export function resetOrphanTrackingForTest(): void {
  orphanSince.clear();
  staleImageAudited.clear();
}

/** The image ids already reported stale today (UTC), so each is audited once a day. */
const staleImageAudited = new Set<string>();

/**
 * Image freshness (D16): once a day per host image past
 * AGENT_COMPUTER_MAX_IMAGE_AGE_DAYS, a log line and an `image_stale` audit on
 * every computer the pass found awake (the audit needs an owner; a stale image
 * with nothing awake is logged only). Nothing is refused: rebuilding is the
 * owner's (deploy/computer-host/setup.sh --rebuild-image, or setup-vm.sh).
 */
async function auditStaleImage(
  provider: NonNullable<ReturnType<typeof computerProvider>>,
  rows: AgentComputerRow[],
  summary: SweepSummary,
  now: Date,
): Promise<void> {
  const image = await provider.imageInfo();
  const built = Date.parse(image.createdAt);
  if (!Number.isFinite(built)) return;
  const days = Math.floor((now.getTime() - built) / 86_400_000);
  if (days <= env.agentComputer.maxImageAgeDays) return;
  const key = `${image.id}:${now.toISOString().slice(0, 10)}`;
  if (staleImageAudited.has(key)) return;
  staleImageAudited.add(key);
  console.warn("[agent-computer] the computer image is older than AGENT_COMPUTER_MAX_IMAGE_AGE_DAYS; rebuild it", { days });
  const skipped = new Set(summary.skipped);
  for (const row of rows) {
    if (row.status === "awake" && !skipped.has(row.agentId)) {
      await recordComputerAudit({ userId: row.userId, agentId: row.agentId, kind: "image_stale", actor: "sweep", detail: { days } });
    }
  }
}

function lastMeaningfulTimestamp(row: AgentComputerRow): number {
  const candidates = [
    row.lastActiveAt?.getTime() ?? 0,
    row.lastViewedAt?.getTime() ?? 0,
    row.lastResumedAt?.getTime() ?? 0,
  ];
  const max = Math.max(...candidates);
  return max > 0 ? max : (row.createdAt?.getTime() ?? 0);
}

/** What one row's pass needs from the sweep around it. */
interface RowPass {
  provider: NonNullable<ReturnType<typeof computerProvider>>;
  persistence: ReturnType<typeof getComputerStorePersistence>;
  now: Date;
  nowMs: number;
  restThresholdMs: number;
  sleepThresholdMs: number;
  summary: SweepSummary;
}

async function sweepRow(read: AgentComputerRow, pass: RowPass): Promise<void> {
  let row = read;
  const { provider, persistence, now, nowMs, restThresholdMs, sleepThresholdMs, summary } = pass;
  if (row.creationToken && row.creationExpiresAt && row.creationExpiresAt.getTime() > nowMs) return;
  if (row.billingStoppedAt) {
    await sleepComputer(row.userId, row.agentId, { now });
    summary.slept.push(row.agentId);
    return;
  }
  // Viewing-only computers have no run heartbeat. The sweep covers them as
  // well as a run that stopped renewing; account spend includes accrued time.
  if (row.status === "awake" && await computerUsageBudgetRefusal(row.userId, row.agentId, now)) {
    await sleepComputer(row.userId, row.agentId, { now });
    summary.slept.push(row.agentId);
    return;
  }
  const handle = decodeHandle(row.containerRef, row.agentId);
  let liveState: Awaited<ReturnType<typeof provider.state>>;
  try {
    liveState = await provider.state(handle);
  } catch (error) {
    // Losing the host (S3.3): an awake computer's open interval is settled at
    // its last contact and nothing accrues until the host answers again. The
    // row is otherwise left alone: never missing, never recreated.
    if (isHostUnreachable(error)) await settleComputerOutage(row, now).catch(() => false);
    throw error;
  }
  // Reached: the contact time moves, and after an outage metering resumes now.
  row = await noteComputerContact(row, now);

  // 1. Reboot / out-of-band stop reconciliation. A computer marked "starting" is mid-wake:
  // `ensureAwake` writes the status before `docker start` returns, so a fresh one is skipped.
  // The write applies only if nothing changed the row since it was read.
  const midWake = row.status === "starting" && nowMs - row.updatedAt.getTime() < STARTING_GRACE_MS;
  if (
    !midWake &&
    (row.status === "awake" ||
      row.status === "starting" ||
      row.status === "resting" ||
      row.status === "stopping") &&
    (liveState === "exited" || liveState === "missing")
  ) {
    if (await persistence.reconcileStoppedCas(row.userId, row.agentId, { status: row.status, updatedAt: row.updatedAt })) {
      summary.reconciledAfterReboot.push(row.agentId);
    }
    return;
  }
  if (midWake) return;

  // 2. Expired lease cleanup: only the lease that was read, and only while still expired.
  let hasActiveLease = false;
  if (row.leaseRunId) {
    if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() <= nowMs) {
      if (await persistence.clearExpiredLeaseCas(row.userId, row.agentId, row.leaseRunId, now)) {
        summary.expiredLeases.push(row.agentId);
      } else {
        hasActiveLease = true;
      }
    } else {
      hasActiveLease = true;
    }
  }

  // 3. Stream idle shutoff after 60s without viewer heartbeat
  let streamActive = row.streamOn;
  if (row.streamOn) {
    const viewedMs = row.lastViewedAt?.getTime() ?? 0;
    if (nowMs - viewedMs > 60_000) {
      await stopStream({ handle, provider }).catch(() => {});
      await persistence.updateByAgent(row.userId, row.agentId, {
        streamOn: false,
      });
      streamActive = false;
      summary.stoppedStreams.push(row.agentId);
    }
  }

  // 4. Disk quota: measured for running containers, and enforced below.
  let measuredDiskMb = row.diskMb;
  if (liveState === "running") {
    const diskMb = await provider.diskUsageMb(handle).catch(() => row.diskMb);
    measuredDiskMb = diskMb;
    if (diskMb !== row.diskMb) {
      await persistence.updateByAgent(row.userId, row.agentId, { diskMb });
    }
  }

  if (hasActiveLease || streamActive) {
    return;
  }

  // An idle computer over its quota goes to sleep with a sentence saying
  // why; tasks will not attach it until files are deleted
  // (`resolveRunComputerSession`). The person can still open it.
  // Pausing or stopping goes through the idle claim: a run that leased and woke the computer
  // after this sweep read the row keeps it.
  const ifIdle = { status: row.status, lastActiveAt: row.lastActiveAt, lastViewedAt: row.lastViewedAt };
  if (liveState === "running" && overDiskQuota({ diskMb: measuredDiskMb })) {
    if (!(await sleepComputer(row.userId, row.agentId, { now, ifIdle }))) return;
    await persistence.updateByAgent(row.userId, row.agentId, {
      lastError: diskFullError(measuredDiskMb ?? 0),
    });
    summary.slept.push(row.agentId);
    return;
  }

  const idleMs = nowMs - lastMeaningfulTimestamp(row);

  // 5. Sleep after env.agentComputer.sleepHours (AGENT_COMPUTER_SLEEP_HOURS, default 0.5h)
  if (
    (row.status === "resting" || row.status === "awake") &&
    idleMs >= sleepThresholdMs
  ) {
    if (await sleepComputer(row.userId, row.agentId, { now, ifIdle })) summary.slept.push(row.agentId);
    return;
  }

  // 6. Rest (pause) after env.agentComputer.restMinutes (AGENT_COMPUTER_REST_MINUTES, default 3m)
  if (row.status === "awake" && idleMs >= restThresholdMs) {
    if (await restComputer(row.userId, row.agentId, { now, ifIdle })) summary.rested.push(row.agentId);
  }
}

export async function sweepAgentComputers(opts?: {
  now?: Date;
  retention?: RetentionSweepOptions;
}): Promise<SweepSummary> {
  const summary: SweepSummary = {
    reconciledAfterReboot: [],
    stoppedStreams: [],
    rested: [],
    slept: [],
    expiredLeases: [],
    reapedOrphans: [],
    skipped: [],
    retentionDeleted: [],
  };

  const provider = computerProvider();
  if (!provider) return summary;
  // A remote host that does not answer still gets its pass: every awake row's
  // metering stops at its last contact (state() throws for each), and nothing
  // is reaped or deleted. A same-host provider that is not set up does nothing.
  const configured = await isAgentComputerConfigured();
  if (!configured && provider.name !== "remote") {
    return summary;
  }

  const now = opts?.now ?? new Date();
  const nowMs = now.getTime();
  const restThresholdMs = env.agentComputer.restMinutes * 60_000;
  const sleepThresholdMs = env.agentComputer.sleepHours * 3_600_000;
  const persistence = getComputerStorePersistence();

  const rows = await persistence.findAllActiveUnguarded();

  const pass: RowPass = { provider, persistence, now, nowMs, restThresholdMs, sleepThresholdMs, summary };
  for (const row of rows) {
    // One computer that cannot be reached (its state() or a provider call
    // throws: a daemon or broker hiccup, a host outage) is skipped for this
    // pass, never treated as missing, and never stops the rows after it: each
    // of them still gets its access, allowance, idle and disk checks.
    try {
      await sweepRow(row, pass);
      unreachableRows.delete(row.agentId);
    } catch (error) {
      summary.skipped.push(row.agentId);
      if (!unreachableRows.has(row.agentId)) {
        unreachableRows.add(row.agentId);
        console.warn("[agent-computer] sweep skipped a computer it could not reach", {
          agentId: row.agentId,
          detail: error instanceof ComputerError ? error.detail || error.message : scrubComputerText(String(error)),
        });
      }
    }
  }

  if (configured) {
    await sweepRetention(persistence, now, summary, opts?.retention);
    await reapOrphans(provider, persistence, nowMs, summary).catch(() => undefined);
    await auditStaleImage(provider, rows, summary, now).catch(() => undefined);
  }

  // Spent and expired single-use view links (src/lib/computer/handoff.ts).
  if (computerStoreUsesDatabase()) await purgeComputerHandoffs(now).catch(() => 0);

  return summary;
}
