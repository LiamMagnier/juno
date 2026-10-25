import "server-only";
import { prismaUnguarded } from "@/lib/db";
import {
  EXECUTOR_HEARTBEAT_KEY,
  EXECUTOR_HEARTBEAT_TTL_MS,
  EXECUTOR_HEARTBEAT_WRITE_MS,
  EXECUTOR_PRESENCE_CACHE_MS,
  cloudAvailabilityOverride,
  heartbeatExpiry,
  heartbeatIsFresh,
  heartbeatWrittenAt,
  type ExecutorPresenceReading,
} from "@/lib/work/executor-presence";

/**
 * The cloud executor's heartbeat, and the availability check dispatch makes.
 *
 * The rules are in executor-presence.ts; this is the I/O. `prismaUnguarded`
 * because the row is global (no userId), which is what the ownership guard
 * exists to notice.
 */

/** When this process last beat. Set only inside a running executor. */
let lastLocalBeatMs = 0;
let lastWrittenMs = 0;
let cached: { available: boolean; readAtMs: number } | null = null;

/**
 * Records that an executor is alive. Called by scripts/work-runner.ts every
 * tick; writes at most every EXECUTOR_HEARTBEAT_WRITE_MS. Never throws: a
 * failed write only lets cloud lapse after the TTL, which is the honest
 * outcome for an executor that cannot reach its database.
 */
export async function recordExecutorHeartbeat(now: Date = new Date()): Promise<void> {
  lastLocalBeatMs = now.getTime();
  if (now.getTime() - lastWrittenMs < EXECUTOR_HEARTBEAT_WRITE_MS) return;
  const expiresAt = heartbeatExpiry(now);
  try {
    await prismaUnguarded.rateLimit.upsert({
      where: { key: EXECUTOR_HEARTBEAT_KEY },
      create: { key: EXECUTOR_HEARTBEAT_KEY, count: 0, expiresAt },
      update: { expiresAt },
    });
    lastWrittenMs = now.getTime();
  } catch (error) {
    console.warn("[work] executor heartbeat write failed", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Whether cloud Work is accepting runs: an override from the environment, an
 * executor in this very process, or a heartbeat younger than the TTL.
 *
 * Fails closed on a read error: refusing with a sentence is recoverable, a run
 * queued for an executor that is not there is the bug this exists to remove.
 */
export async function cloudWorkAvailable(now: Date = new Date()): Promise<boolean> {
  const override = cloudAvailabilityOverride();
  if (override !== null) return override;
  if (lastLocalBeatMs > 0 && now.getTime() - lastLocalBeatMs < EXECUTOR_HEARTBEAT_TTL_MS) return true;
  if (cached && now.getTime() - cached.readAtMs < EXECUTOR_PRESENCE_CACHE_MS) return cached.available;
  let available = false;
  try {
    const row = await prismaUnguarded.rateLimit.findUnique({
      where: { key: EXECUTOR_HEARTBEAT_KEY },
      select: { expiresAt: true },
    });
    available = heartbeatIsFresh(row?.expiresAt, now);
  } catch {
    available = false;
  }
  cached = { available, readAtMs: now.getTime() };
  return available;
}

/**
 * When a cloud executor last reported in, for the queued-run expiry sweep
 * (`expireUnclaimedCloudRuns`) and nothing that admits work.
 *
 * Not `cloudWorkAvailable`, on purpose (see `ExecutorPresenceReading`): no
 * WORK_CLOUD_AVAILABLE override, because the kill switch closes intake and
 * says nothing about whether a runner is still working through its queue; no
 * cache, because a stale "absent" here ends runs for good; and a failed read
 * is "unknown", never "absent", so a sweeper whose pool timed out stands down
 * instead of ending live work.
 */
export async function readExecutorPresence(now: Date = new Date()): Promise<ExecutorPresenceReading> {
  if (lastLocalBeatMs > 0 && now.getTime() - lastLocalBeatMs < EXECUTOR_HEARTBEAT_TTL_MS) {
    return { kind: "read", lastBeatAt: new Date(lastLocalBeatMs), localBeatFresh: true };
  }
  try {
    const row = await prismaUnguarded.rateLimit.findUnique({
      where: { key: EXECUTOR_HEARTBEAT_KEY },
      select: { expiresAt: true },
    });
    return { kind: "read", lastBeatAt: row ? heartbeatWrittenAt(row.expiresAt) : null, localBeatFresh: false };
  } catch {
    return { kind: "unknown" };
  }
}
