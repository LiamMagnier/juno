/**
 * Whether a cloud Work executor is alive, as pure rules.
 *
 * Dispatch used to hold `CLOUD_WORK_AVAILABLE = true`, a constant, so a cloud
 * run was accepted whether or not `scripts/work-runner.ts` was running. With no
 * runner it sat `queued` for ever: the chat drew it as live, and three of them
 * filled the account's concurrency cap so nothing else could start either.
 *
 * Now the runner records a heartbeat (src/lib/work/executor-heartbeat.ts) and
 * "cloud is available" means "an executor reported in within the TTL". These
 * are the parts with no database in them, so they can be tested directly.
 */

/**
 * The `RateLimit` row the heartbeat lives in.
 *
 * `RateLimit` is the repo's existing key/expiry table (a key, a counter, and
 * `expiresAt`, swept by scripts/prune-sync.ts once long expired), which is
 * exactly the shape a heartbeat needs, so no table is added for it. One key
 * shared by every runner: any live executor can claim any cloud run, so the
 * question dispatch asks is "is at least one alive", and the freshest write
 * answers it.
 */
export const EXECUTOR_HEARTBEAT_KEY = "work-executor:heartbeat";

/**
 * How long one heartbeat keeps cloud open. The runner's idle tick drifts to
 * one a minute (IDLE_TICK_MAX_MS), so two minutes tolerates one slow or failed
 * write without flapping.
 */
export const EXECUTOR_HEARTBEAT_TTL_MS = 2 * 60_000;

/** The runner writes at most this often, however fast it ticks. */
export const EXECUTOR_HEARTBEAT_WRITE_MS = 20_000;

/** How long a dispatcher trusts one read of the heartbeat row. */
export const EXECUTOR_PRESENCE_CACHE_MS = 10_000;

/**
 * How long a cloud run may sit `queued` with no executor alive before it is
 * ended as `executor_unavailable`. Long enough to ride out a runner restart or
 * a deploy; short enough that the chat stops calling it live the same session.
 *
 * Both halves are measured: the executor must have been silent this long (its
 * last heartbeat written more than this long ago, or none at all) AND the run
 * must have been sitting in `queued` this long. See `unclaimedCloudRunCutoff`.
 */
export const QUEUED_CLOUD_RUN_TTL_MS = 10 * 60_000;

/** The sentence a run expired for want of an executor ends with. */
export const EXECUTOR_UNAVAILABLE_DETAIL =
  "No cloud worker was running to start this task, so it never began. Nothing was done; start it again when cloud work is back.";

/**
 * The sentence a resumed run that no executor picked back up ends with.
 *
 * Not `EXECUTOR_UNAVAILABLE_DETAIL`: a run resumed from a pause has already
 * worked, and its checkpoint is kept (it ends `interrupted`, which is
 * resumable) so "nothing was done" would be false and "start it again" would
 * throw its progress away.
 */
export const EXECUTOR_UNAVAILABLE_RESUME_DETAIL =
  "No cloud worker was running to pick this task back up, so it stopped where it was paused. Its progress is kept; continue it when cloud work is back.";

/** The refusal dispatch gives while no executor is alive (shown in the thread as-is). */
export const CLOUD_EXECUTOR_UNAVAILABLE_MESSAGE =
  "No cloud worker is running, so Cloud Work is not accepting tasks right now.";

/**
 * An explicit answer from the environment, or null to use the heartbeat.
 *
 * `WORK_CLOUD_AVAILABLE=1` is the fast path for tests, e2e and single-process
 * setups that dispatch without a runner on purpose; `=0` closes cloud (a kill
 * switch for a paused executor or a provider outage).
 */
export function cloudAvailabilityOverride(env: Record<string, string | undefined> = process.env): boolean | null {
  const raw = env.WORK_CLOUD_AVAILABLE?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "always") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "never") return false;
  return null;
}

/** Whether a heartbeat that expires at `expiresAt` still says an executor is alive. */
export function heartbeatIsFresh(expiresAt: Date | null | undefined, now: Date): boolean {
  return expiresAt instanceof Date && expiresAt.getTime() > now.getTime();
}

/** The `expiresAt` a heartbeat written at `now` carries. */
export function heartbeatExpiry(now: Date): Date {
  return new Date(now.getTime() + EXECUTOR_HEARTBEAT_TTL_MS);
}

/** When a heartbeat that expires at `expiresAt` was written. */
export function heartbeatWrittenAt(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() - EXECUTOR_HEARTBEAT_TTL_MS);
}

/** The oldest time a queued cloud run may have entered `queued` and still be left alone. */
export function queuedCloudRunCutoff(now: Date, ttlMs: number = QUEUED_CLOUD_RUN_TTL_MS): Date {
  return new Date(now.getTime() - ttlMs);
}

/**
 * What the expiry sweep read about the cloud executor.
 *
 * Deliberately not the boolean `cloudWorkAvailable` answers. That one guards
 * admission, so it fails closed (a read error is "unavailable"), caches for
 * EXECUTOR_PRESENCE_CACHE_MS and obeys WORK_CLOUD_AVAILABLE, and every one of
 * those is wrong for a sweep that ends runs for good: a timed-out read in a
 * small pool, or the kill switch closing intake while a live runner works
 * through its queue, would each read as "no executor" and end live work.
 */
export type ExecutorPresenceReading =
  /** The heartbeat row could not be read. Evidence of nothing; the sweep stands down. */
  | { kind: "unknown" }
  | {
      kind: "read";
      /** When the freshest heartbeat was written; null when there is no heartbeat row at all. */
      lastBeatAt: Date | null;
      /** An executor inside this very process beat within the heartbeat TTL. */
      localBeatFresh: boolean;
    };

/**
 * Whether the reading positively shows no executor alive right now: the row
 * was read and its heartbeat has lapsed (or never existed), and this process
 * is not an executor itself. An unknown reading is never "absent".
 */
export function executorKnownAbsent(reading: ExecutorPresenceReading, now: Date): boolean {
  if (reading.kind !== "read" || reading.localBeatFresh) return false;
  return reading.lastBeatAt === null || !heartbeatIsFresh(heartbeatExpiry(reading.lastBeatAt), now);
}

/**
 * The time a queued cloud run must have entered `queued` before for the sweep
 * to end it, or null when the sweep must end nothing.
 *
 * Positive evidence of a long outage only: null on a failed read, while this
 * process is itself beating, and while the last heartbeat was written less
 * than `ttlMs` ago. A runner restart or a two-minute lapse is ridden out.
 *
 * The run's own clock is the time it entered `queued` (its `updatedAt`, which
 * a resume moves; never `createdAt`, which a run resumed after an hour's pause
 * would carry from hours ago), taken as max(entered queued, last beat). With
 * the last beat already older than the cutoff whenever this returns one, that
 * max is older than the cutoff exactly when "entered queued" is, so the one
 * returned date is the whole test.
 */
export function unclaimedCloudRunCutoff(
  reading: ExecutorPresenceReading,
  now: Date,
  ttlMs: number = QUEUED_CLOUD_RUN_TTL_MS
): Date | null {
  if (reading.kind !== "read" || reading.localBeatFresh) return null;
  const cutoff = queuedCloudRunCutoff(now, ttlMs);
  if (reading.lastBeatAt !== null && reading.lastBeatAt.getTime() >= cutoff.getTime()) return null;
  return cutoff;
}
