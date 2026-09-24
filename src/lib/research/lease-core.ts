/**
 * Keeping a research run's worker lease while something long happens
 * (SPEC §9.3 B1–B3). Pure: the renewal and the timers are injected, so
 * `tests/research-lease.test.ts` can drive a whole keep-alive with a fake
 * clock. `lease.ts` binds the renewal to Prisma; the engine uses
 * `withHeartbeat` directly.
 *
 * The lease is what fences drivers: the PM2 worker adopts any working run
 * whose lease has lapsed, with the full engine — writer included. A stage that
 * outlives the lease (a planner retry, the writer, the audit) or a chat stream
 * that outlives it (the native hand-off) is therefore a second driver running
 * the same stage and billing it twice. Renewing every 45 s against a 2-minute
 * lease leaves two missed beats of slack.
 */

/** How often a held lease is renewed; the lease itself is `RESEARCH_WORKER_LEASE_MS` (2 min). */
export const RESEARCH_LEASE_RENEW_MS = 45_000;

export interface LeaseTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: LeaseTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // A keep-alive must never be the reason a process cannot exit.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Renews now and then every `intervalMs` until the returned stop is called.
 * A renewal that fails is logged and the next beat tries again: a database
 * blip must not end a chat stream, and the lease has slack for it.
 */
export function createLeaseKeeper(
  renew: () => Promise<unknown>,
  opts: { intervalMs?: number; timers?: LeaseTimers; onError?: (error: unknown) => void } = {}
): () => void {
  const timers = opts.timers ?? REAL_TIMERS;
  const beat = () => {
    void renew().catch((error: unknown) => (opts.onError ?? ((e) => console.error("[research] lease renewal failed", e)))(error));
  };
  beat();
  const handle = timers.setInterval(beat, opts.intervalMs ?? RESEARCH_LEASE_RENEW_MS);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(handle);
  };
}

/**
 * Runs `fn` while calling `heartbeat` every `intervalMs` (B3). Every model
 * stage — clarify, plan, review, synthesize, validate, the coverage expander
 * — runs inside one, so no single call can outlive the lease it runs under.
 * Without a heartbeat (a driver with no lease) it is just `fn()`.
 */
export async function withHeartbeat<T>(
  fn: () => Promise<T>,
  heartbeat: (() => Promise<void>) | undefined,
  intervalMs: number = RESEARCH_LEASE_RENEW_MS,
  timers: LeaseTimers = REAL_TIMERS
): Promise<T> {
  if (!heartbeat) return fn();
  const handle = timers.setInterval(() => void heartbeat().catch(() => undefined), intervalMs);
  try {
    return await fn();
  } finally {
    timers.clearInterval(handle);
  }
}

/** The drive owner of a web run: stable per run, so a nudge after a gate can reclaim its own lease (B1). */
export function researchWebOwner(runId: string): string {
  return `research-web:${runId}`;
}

/** The drive owner of a native in-chat run: per turn, so the route can renew and release exactly its own (B2). */
export function researchChatOwner(runId: string, nowMs: number): string {
  return `research-chat:${runId}:${nowMs}`;
}
