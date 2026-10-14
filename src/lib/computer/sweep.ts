import "server-only";
import { env } from "@/lib/env";
import { stopStream } from "./live-view";
import { computerProvider, isAgentComputerConfigured } from "./provider";
import {
  computerStoreUsesDatabase,
  decodeHandle,
  diskFullError,
  getComputerStorePersistence,
  overDiskQuota,
  restComputer,
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

export async function sweepAgentComputers(opts?: {
  now?: Date;
}): Promise<SweepSummary> {
  const summary: SweepSummary = {
    reconciledAfterReboot: [],
    stoppedStreams: [],
    rested: [],
    slept: [],
    expiredLeases: [],
  };

  const provider = computerProvider();
  if (!provider || !(await isAgentComputerConfigured())) {
    return summary;
  }

  const now = opts?.now ?? new Date();
  const nowMs = now.getTime();
  const restThresholdMs = env.agentComputer.restMinutes * 60_000;
  const sleepThresholdMs = env.agentComputer.sleepHours * 3_600_000;
  const persistence = getComputerStorePersistence();

  const rows = await persistence.findAllActiveUnguarded();

  for (const row of rows) {
    const handle = decodeHandle(row.containerRef, row.agentId);
    const liveState = await provider.state(handle);

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
      continue;
    }
    if (midWake) continue;

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
      continue;
    }

    // An idle computer over its quota goes to sleep with a sentence saying
    // why; tasks will not attach it until files are deleted
    // (`resolveRunComputerSession`). The person can still open it.
    // Pausing or stopping goes through the idle claim: a run that leased and woke the computer
    // after this sweep read the row keeps it.
    const ifIdle = { status: row.status, lastActiveAt: row.lastActiveAt, lastViewedAt: row.lastViewedAt };
    if (liveState === "running" && overDiskQuota({ diskMb: measuredDiskMb })) {
      if (!(await sleepComputer(row.userId, row.agentId, { now, ifIdle }))) continue;
      await persistence.updateByAgent(row.userId, row.agentId, {
        lastError: diskFullError(measuredDiskMb ?? 0),
      });
      summary.slept.push(row.agentId);
      continue;
    }

    const idleMs = nowMs - lastMeaningfulTimestamp(row);

    // 5. Sleep after AGENT_COMPUTER_SLEEP_HOURS (default 24h)
    if (
      (row.status === "resting" || row.status === "awake") &&
      idleMs >= sleepThresholdMs
    ) {
      if (await sleepComputer(row.userId, row.agentId, { now, ifIdle })) summary.slept.push(row.agentId);
      continue;
    }

    // 6. Rest (pause) after AGENT_COMPUTER_REST_MINUTES (default 20m)
    if (row.status === "awake" && idleMs >= restThresholdMs) {
      if (await restComputer(row.userId, row.agentId, { now, ifIdle })) summary.rested.push(row.agentId);
    }
  }

  // Spent and expired single-use view links (src/lib/computer/handoff.ts).
  if (computerStoreUsesDatabase()) await purgeComputerHandoffs(now).catch(() => 0);

  return summary;
}
