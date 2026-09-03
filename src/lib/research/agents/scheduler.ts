/**
 * The small scheduler the research agents run on.
 *
 * `AgentSwarmCoordinator` (src/lib/agent/swarm.ts) is a DAG scheduler for
 * dependent tasks, polls on a 15 ms timer, and reports through the Work
 * runtime's event shape. A research round has no dependencies — every worker
 * is independent by construction, that is what makes them parallel — and what
 * it needs instead is two things the coordinator does not have: a limit that is
 * per-HOST as well as per-run, because a dozen workers opening pages on the
 * same site is a scraper as far as that site is concerned, and cancellation at
 * the granularity of a single tool call rather than a whole wave.
 *
 * Nothing here polls. A slot is a promise the next waiter awaits, so a freed
 * slot is taken the moment the holder settles.
 *
 * Free of `server-only` so tests/research-agents.test.ts can exercise the
 * concurrency and the abort paths with no network.
 */

/** A counting semaphore whose waiters are served in arrival order. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    this.available = Math.max(1, Math.floor(limit));
  }

  /** Slots in use right now — what a test asserts a limit against. */
  get inUse(): number {
    return this.limit - this.available;
  }

  /**
   * Waits for a slot. Rejects with the signal's reason if it aborts first, and
   * does so WITHOUT consuming a slot — a waiter woken by an abort must not
   * leave the semaphore one short for everybody behind it.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.available > 0) {
      this.available -= 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        this.available -= 1;
        resolve(this.releaser());
      };
      const onAbort = () => {
        const at = this.waiters.indexOf(wake);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(wake);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

/**
 * One semaphore per hostname, created on demand.
 *
 * The per-host limit is the smaller of the two guards and the one that keeps
 * a run from looking hostile: a global limit of ten still lets ten workers
 * hit one domain at once if that is where the answers are.
 */
export class HostLimiter {
  private readonly hosts = new Map<string, Semaphore>();

  constructor(readonly perHost: number) {}

  async acquire(url: string, signal?: AbortSignal): Promise<() => void> {
    const host = hostOf(url);
    let gate = this.hosts.get(host);
    if (!gate) {
      gate = new Semaphore(this.perHost);
      this.hosts.set(host, gate);
    }
    return gate.acquire(signal);
  }

  /** How many fetches are open against `url`'s host — for tests. */
  inFlight(url: string): number {
    return this.hosts.get(hostOf(url))?.inUse ?? 0;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs `work` over `items` with at most `limit` in flight, and returns every
 * outcome in input order.
 *
 * Settled rather than thrown: one worker failing must not take the other
 * seven down with it, and the caller wants the successes AND the failures to
 * narrate. An abort stops new items being started; the ones already running
 * see the same signal and are expected to stop themselves.
 */
export async function runAll<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<Array<Settled<R>>> {
  const gate = new Semaphore(limit);
  return Promise.all(
    items.map(async (item, index): Promise<Settled<R>> => {
      let release: (() => void) | null = null;
      try {
        release = await gate.acquire(signal);
        if (signal?.aborted) throw abortError(signal);
        return { ok: true, value: await work(item, index) };
      } catch (error) {
        return { ok: false, error };
      } finally {
        release?.();
      }
    })
  );
}

/**
 * A signal that aborts with its parent OR after `ms`, whichever comes first.
 *
 * The same helper tools.ts keeps privately; duplicated here rather than
 * imported because tools.ts is `server-only`.
 */
export function timeboxSignal(
  parent: AbortSignal | undefined,
  ms: number
): { signal: AbortSignal; release: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new DOMException("Timed out", "TimeoutError"));
  }, Math.max(1, ms));
  const onAbort = () => ctrl.abort(parent?.reason);
  if (parent?.aborted) ctrl.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctrl.signal,
    release: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
    timedOut: () => timedOut,
  };
}
