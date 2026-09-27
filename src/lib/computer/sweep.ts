import "server-only";
import { env } from "@/lib/env";
import { stopStream } from "./live-view";
import { computerProvider, isAgentComputerConfigured } from "./provider";
import {
  decodeHandle,
  getComputerStorePersistence,
  restComputer,
  sleepComputer,
  type AgentComputerRow,
} from "./store";

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

    // 1. Reboot / out-of-band stop reconciliation
    if (
      (row.status === "awake" ||
        row.status === "starting" ||
        row.status === "resting" ||
        row.status === "stopping") &&
      (liveState === "exited" || liveState === "missing")
    ) {
      await persistence.updateByAgent(row.userId, row.agentId, {
        status: "asleep",
        streamOn: false,
        leaseRunId: null,
        leaseExpiresAt: null,
        lastResumedAt: null,
      });
      summary.reconciledAfterReboot.push(row.agentId);
      continue;
    }

    // 2. Expired lease cleanup
    let hasActiveLease = false;
    if (row.leaseRunId) {
      if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() <= nowMs) {
        await persistence.updateByAgent(row.userId, row.agentId, {
          leaseRunId: null,
          leaseExpiresAt: null,
        });
        summary.expiredLeases.push(row.agentId);
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

    // 4. Disk quota telemetry refresh for running containers
    if (liveState === "running") {
      const diskMb = await provider.diskUsageMb(handle).catch(() => row.diskMb);
      if (diskMb !== row.diskMb) {
        await persistence.updateByAgent(row.userId, row.agentId, { diskMb });
      }
    }

    if (hasActiveLease || streamActive) {
      continue;
    }

    const idleMs = nowMs - lastMeaningfulTimestamp(row);

    // 5. Sleep after AGENT_COMPUTER_SLEEP_HOURS (default 24h)
    if (
      (row.status === "resting" || row.status === "awake") &&
      idleMs >= sleepThresholdMs
    ) {
      await sleepComputer(row.userId, row.agentId, { now });
      summary.slept.push(row.agentId);
      continue;
    }

    // 6. Rest (pause) after AGENT_COMPUTER_REST_MINUTES (default 20m)
    if (row.status === "awake" && idleMs >= restThresholdMs) {
      await restComputer(row.userId, row.agentId, { now });
      summary.rested.push(row.agentId);
    }
  }

  return summary;
}
