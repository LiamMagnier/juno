/**
 * Cross-process Stop for chat generations: the durable half of the registry.
 *
 * A generation lives inside the HTTP request of ONE backend process, and its
 * AbortController lives in that process's memory (`generation-cancel.ts`).
 * `POST /api/chat/cancel` can land on any process — a second instance, the
 * replacement during a zero-downtime reload, a process that started after the
 * Stop was pressed — so an in-memory map alone turned those Stops into a
 * silent `{ cancelled: false }` while the answer kept writing (and billing).
 *
 * The fix is two durable rows and one loop per process:
 *
 *  - A CANCEL row, written by whichever process receives the Stop. Idempotent
 *    (a second Stop refreshes the same row), owner-scoped by construction (the
 *    key carries the authenticated user's id, and a generation only honours
 *    rows under its own owner), and short-lived (CANCEL_TTL_MS) so it outlives
 *    the delivery window — including a Stop pressed before the turn has even
 *    registered — and nothing else.
 *  - A LIVE lease per saved generation, renewed by the process that holds it.
 *    It is what lets another process answer "is this generation running
 *    anywhere?" — the cancel route's honest `cancelled`, and the resume
 *    route's liveness — without asking every process. Private turns take no
 *    lease: they persist nothing on their own (stream-log.ts), and a Stop
 *    still reaches them through the cancel row their owner writes.
 *  - The PUMP: while a process holds at least one generation it reads the
 *    cancel rows of all of them in ONE query every POLL_MS and renews all of
 *    their leases in ONE write every LIVE_RENEW_MS. With nothing registered it
 *    is idle — no timer, no query.
 *
 * Why polling and not LISTEN/NOTIFY: Prisma cannot hold a LISTEN session, and
 * the repo has no raw `pg` driver; a NOTIFY that nobody is listening to (the
 * listener reconnecting, the process starting up) is lost, so a durable row
 * would be needed underneath it anyway. One indexed primary-key read per
 * second per busy process bounds the Stop latency at ~POLL_MS plus a round
 * trip, inside the 3 s the product promises, at a cost that does not grow
 * with the number of generations.
 *
 * Pure: the database is behind `GenerationSignalStore` and the clock behind
 * `schedule`, so the rules are testable. `generation-signals-store.ts` is the
 * Prisma side; `generation-cancel.ts` owns the per-process instance.
 */

/** How often a busy process reads the cancel rows of the generations it holds. */
export const GENERATION_CANCEL_POLL_MS = 1_000;
/** How often a busy process renews the live leases of the generations it holds. */
export const GENERATION_LIVE_RENEW_MS = 5_000;
/**
 * How long a live lease survives without renewal. Four missed renewals: long
 * enough that a GC pause or a slow write never reads as a dead process, short
 * enough that a process that really died stops looking alive within seconds.
 */
export const GENERATION_LIVE_TTL_MS = 20_000;
/**
 * How long a cancel row stays readable. Covers the delivery window — the next
 * poll, a turn still in admission when Stop was pressed, a process mid-reload —
 * with a wide margin. Bounded so a client that reused a generation id much
 * later could not be cancelled by an old Stop.
 */
export const GENERATION_CANCEL_TTL_MS = 10 * 60_000;
/** A failing store is logged at most this often per process, not once per poll. */
export const GENERATION_SIGNAL_ERROR_LOG_MS = 30_000;
/**
 * The closest two ticks may run when registrations pull the next one forward.
 * A burst of new turns is leased and polled together, so a busy process stays
 * near one read per poll rather than one per registration.
 */
export const GENERATION_KICK_SPACING_MS = 100;

/*
 * Row-key namespaces in `RateLimit`. Not `chat:` — the chat route's own rate
 * limiter buckets are `chat:<userId>` — so no other caller's key, and no
 * cleanup aimed at another prefix, can ever touch these.
 */
export const CANCEL_KEY_PREFIX = "generation:cancel:";
export const LIVE_KEY_PREFIX = "generation:live:";

/** One generation, identified the way every durable signal is scoped: by its owner too. */
export interface GenerationRef {
  generationId: string;
  userId: string;
}

/**
 * The row key of a generation's cancel signal.
 *
 * Unambiguous although a generation id may contain `:` (the request schema
 * only bounds its length): user ids are cuids, which never do, so the owner
 * is always exactly the segment after the prefix.
 */
export function cancelSignalKey(ref: GenerationRef): string {
  return `${CANCEL_KEY_PREFIX}${ref.userId}:${ref.generationId}`;
}

/** The row key of a generation's live lease. Same shape, same reasoning. */
export function liveLeaseKey(ref: GenerationRef): string {
  return `${LIVE_KEY_PREFIX}${ref.userId}:${ref.generationId}`;
}

export function sameGeneration(a: GenerationRef, b: GenerationRef): boolean {
  return a.generationId === b.generationId && a.userId === b.userId;
}

export interface GenerationSignalStore {
  /**
   * Record a Stop for this user's generation. Idempotent: a repeat refreshes
   * the same row. Expiry is computed by the store (the database clock, so
   * instances with drifting clocks agree).
   */
  requestCancel(ref: GenerationRef, ttlMs: number): Promise<void>;
  /** Which of these generations have a Stop waiting. One round trip for all of them. */
  pendingCancels(refs: readonly GenerationRef[]): Promise<GenerationRef[]>;
  /** Extend (or create) the live lease of every generation listed. One write for all of them. */
  renewLive(refs: readonly GenerationRef[], ttlMs: number): Promise<void>;
  /** Whether some process holds a live lease on this user's generation. */
  isLive(ref: GenerationRef): Promise<boolean>;
  /** Drop leases whose generations ended. */
  releaseLive(refs: readonly GenerationRef[]): Promise<void>;
}

/** What the pump needs to see of the process's registry on each tick. */
export interface HeldGeneration extends GenerationRef {
  /** Already aborted (any cause): still tearing down, nothing left to cancel. */
  aborted: boolean;
  /** Takes a live lease. False for private turns. */
  leased: boolean;
}

export interface GenerationSignalPumpOptions {
  store: GenerationSignalStore;
  /** The process's registered generations, read fresh on every tick. */
  held: () => readonly HeldGeneration[];
  /** Deliver a Stop found in the store. Routed through the registry so the terminal state is "user stopped". */
  onCancel: (ref: GenerationRef) => void;
  pollMs?: number;
  renewMs?: number;
  liveTtlMs?: number;
  errorLogMs?: number;
  kickSpacingMs?: number;
  now?: () => number;
  /** Injectable timer for tests. Must return something `clearTimer` accepts. */
  schedule?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (stage: "poll" | "renew" | "release", error: unknown) => void;
}

export interface GenerationSignalPump {
  /** A generation registered: make sure the loop runs, and lease it promptly. */
  kick(): void;
  /** A generation ended: drop its lease (when it took one). Serialised after any in-flight tick. */
  release(ref: GenerationRef, leased: boolean): void;
  /** Run one tick now. Resolves when it has settled. For tests and for a drain. */
  tick(): Promise<void>;
  /** Stop scheduling. Pending writes still settle. */
  stop(): void;
  /** True while a tick is scheduled or running. */
  readonly running: boolean;
}

export function createGenerationSignalPump(options: GenerationSignalPumpOptions): GenerationSignalPump {
  const pollMs = Math.max(10, options.pollMs ?? GENERATION_CANCEL_POLL_MS);
  const renewMs = Math.max(pollMs, options.renewMs ?? GENERATION_LIVE_RENEW_MS);
  const liveTtlMs = Math.max(renewMs * 2, options.liveTtlMs ?? GENERATION_LIVE_TTL_MS);
  const errorLogMs = options.errorLogMs ?? GENERATION_SIGNAL_ERROR_LOG_MS;
  const kickSpacingMs = Math.max(0, options.kickSpacingMs ?? GENERATION_KICK_SPACING_MS);
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      // The loop must never be the thing that holds a draining process open.
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  /** The tick in progress, if any. Ticks never overlap. */
  let inflight: Promise<void> | null = null;
  /** A generation registered while a tick was running: run the next one at once. */
  let rerun = false;
  let stopped = false;
  let lastTickAt = Number.NEGATIVE_INFINITY;
  let lastRenewAt = Number.NEGATIVE_INFINITY;
  /** Leases written since the last full renewal, so a new generation is leased at once, not in 5 s. */
  const leased = new Set<string>();
  /** Stops already handed to the registry, so a row that outlives the abort is not delivered twice. */
  const delivered = new Set<string>();
  const lastErrorAt: Record<"poll" | "renew" | "release", number> = {
    poll: Number.NEGATIVE_INFINITY,
    renew: Number.NEGATIVE_INFINITY,
    release: Number.NEGATIVE_INFINITY,
  };
  // Every store write is chained, so a release can never land before the
  // renewal that was already in flight and resurrect a finished lease.
  let chain: Promise<void> = Promise.resolve();

  const report = (stage: "poll" | "renew" | "release", error: unknown) => {
    const at = now();
    if (at - lastErrorAt[stage] < errorLogMs) return;
    lastErrorAt[stage] = at;
    options.onError?.(stage, error);
  };

  const scheduleNext = (ms: number) => {
    if (stopped || timer !== null) return;
    timer = schedule(() => {
      timer = null;
      void runTick();
    }, ms);
  };

  const runTick = (): Promise<void> => {
    if (inflight) return inflight;
    lastTickAt = now();
    inflight = tickOnce().finally(() => {
      inflight = null;
      const delay = rerun ? kickSpacingMs : pollMs;
      rerun = false;
      if (options.held().length > 0) scheduleNext(delay);
    });
    return inflight;
  };

  const tickOnce = async (): Promise<void> => {
    const held = options.held();
    // Forget bookkeeping for generations that are gone.
    const heldKeys = new Set(held.map((generation) => cancelSignalKey(generation)));
    for (const key of delivered) if (!heldKeys.has(key)) delivered.delete(key);
    for (const key of leased) if (!heldKeys.has(key)) leased.delete(key);
    if (held.length === 0) return;
    // The two halves are independent; the Stop read never waits on a write.
    await Promise.all([renewLeases(held), pollCancels(held)]);
  };

  const renewLeases = async (held: readonly HeldGeneration[]): Promise<void> => {
    const toLease = held.filter((generation) => generation.leased);
    if (toLease.length === 0) return;
    const renewDue = now() - lastRenewAt >= renewMs;
    const batch = renewDue ? toLease : toLease.filter((generation) => !leased.has(cancelSignalKey(generation)));
    if (batch.length === 0) return;
    const write = chain.then(() => options.store.renewLive(batch.map(toRef), liveTtlMs));
    chain = write.catch(() => {});
    try {
      await write;
      for (const generation of batch) leased.add(cancelSignalKey(generation));
      if (renewDue) lastRenewAt = now();
    } catch (error) {
      report("renew", error);
    }
  };

  const pollCancels = async (held: readonly HeldGeneration[]): Promise<void> => {
    const cancellable = held.filter((generation) => !generation.aborted && !delivered.has(cancelSignalKey(generation)));
    if (cancellable.length === 0) return;
    try {
      const pending = await options.store.pendingCancels(cancellable.map(toRef));
      for (const ref of pending) {
        // Only a generation this process holds, under the owner that holds
        // it: the store filters by owner already, and this checks anyway.
        const match = cancellable.find((generation) => sameGeneration(generation, ref));
        if (!match || delivered.has(cancelSignalKey(match))) continue;
        delivered.add(cancelSignalKey(match));
        options.onCancel(toRef(match));
      }
    } catch (error) {
      // A failed read is not a Stop. The in-process fast path is unaffected,
      // and the next tick reads again.
      report("poll", error);
    }
  };

  return {
    kick() {
      if (stopped) return;
      // Run soon rather than on the next full interval: the lease should exist
      // before anyone asks, and a Stop pressed before the turn registered
      // should land before the provider has produced much.
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (inflight) {
        rerun = true; // the running tick reschedules itself when it settles
        return;
      }
      scheduleNext(Math.max(0, lastTickAt + kickSpacingMs - now()));
    },
    release(ref, wasLeased) {
      const key = cancelSignalKey(ref);
      delivered.delete(key);
      leased.delete(key);
      if (!wasLeased) return;
      const write = chain.then(() => options.store.releaseLive([ref]));
      chain = write.catch((error: unknown) => report("release", error));
    },
    tick: () => runTick().then(() => chain),
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    get running() {
      return timer !== null || inflight !== null;
    },
  };
}

function toRef(generation: GenerationRef): GenerationRef {
  return { generationId: generation.generationId, userId: generation.userId };
}

/**
 * An in-memory store with the Prisma store's semantics, for tests and for the
 * labelled two-instance simulation: several pumps sharing one of these behave
 * like several processes sharing one database.
 */
export function createMemoryGenerationSignalStore(now: () => number = Date.now): GenerationSignalStore & {
  rows: Map<string, { count: number; expiresAt: number }>;
} {
  const rows = new Map<string, { count: number; expiresAt: number }>();
  const live = (key: string) => {
    const row = rows.get(key);
    return row !== undefined && row.expiresAt > now();
  };
  return {
    rows,
    async requestCancel(ref, ttlMs) {
      const key = cancelSignalKey(ref);
      const row = rows.get(key);
      const expiresAt = now() + ttlMs;
      rows.set(key, { count: (row?.count ?? 0) + 1, expiresAt: Math.max(row?.expiresAt ?? 0, expiresAt) });
    },
    async pendingCancels(refs) {
      return refs.filter((ref) => live(cancelSignalKey(ref))).map(toRef);
    },
    async renewLive(refs, ttlMs) {
      for (const ref of refs) rows.set(liveLeaseKey(ref), { count: 1, expiresAt: now() + ttlMs });
    },
    async isLive(ref) {
      return live(liveLeaseKey(ref));
    },
    async releaseLive(refs) {
      for (const ref of refs) rows.delete(liveLeaseKey(ref));
    },
  };
}
