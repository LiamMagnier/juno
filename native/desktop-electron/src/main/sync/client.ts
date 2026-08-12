/**
 * The sync engine.
 *
 * ```
 *   authenticate
 *     └─ bootstrap ──────────── capture cursor BEFORE enumerating
 *          └─ /entities/index ─ walk the keyset
 *               └─ /entities ── hydrate in batches of 100
 *                    └─ commit baseline + captured cursor, atomically
 *   subscribe /changes/stream  (a doorbell, not a delivery)
 *     └─ on `cursor` event
 *          └─ GET /changes     the authoritative page
 *               └─ /entities   hydrate what it names
 *                    └─ reduce, apply + advance cursor in one transaction
 *                         └─ drain the outbox
 * ```
 *
 * ## The one semantic that must not be got wrong
 *
 * `/api/v1/changes/stream` is a **wakeup channel**. This was verified against
 * the implementation, not inferred from the contract prose: in
 * `src/lib/sync-feed.ts`, `accountChangeStreamResponse` polls the account's
 * maximum cursor every ~2s and, on an advance, emits `event: cursor` with the
 * body `{"cursor":"N"}`. That is the entire payload. There is no entity id, no
 * revision, no operation and no data anywhere in the stream, so there is nothing
 * a client *could* mistake for canonical state. Every byte that reaches the
 * database comes from `GET /changes` followed by `GET /entities`.
 *
 * Two further details of that endpoint shape this client:
 *
 *  - It uses **named SSE events** (`event: ready` / `event: cursor` /
 *    `event: done`), unlike Juno's chat SSE routes which send anonymous `data:`
 *    frames carrying a `type` field. The reader below speaks the named dialect.
 *  - It holds for ~55s and then sends `done` so the client reconnects. A `done`
 *    is a normal end of cycle and must reconnect immediately — backing off after
 *    one would add a minute of latency to every change.
 *
 * Bearer tokens are held only for the lifetime of a single request, are never
 * logged, never stored in this module, and never appear on any type that leaves
 * it. `EventSource` is unusable here precisely because it cannot carry an
 * Authorization header, which is why the stream is read with `fetch`.
 */

import {
  bootstrapResponseSchema,
  type ChangeCursor,
  type ChangesResponse,
  changesResponseSchema,
  compareCursors,
  cursorEventSchema,
  type EntityEnvelope,
  entitiesResponseSchema,
  type EntityIndexItem,
  entityIndexResponseSchema,
  entityKey,
  errorEnvelopeSchema,
  MAX_CHANGE_PAGE_SIZE,
  MAX_ENTITY_IDS_PER_REQUEST,
  MAX_ENTITY_INDEX_LIMIT,
  mutationResultSchema,
  readyEventSchema,
  SyncError,
  type ChangeWakeup,
} from './types.js';
import {
  hydrationRequestsForPage,
  type LocalEntityState,
  reduceChangePage,
  type ReducePlan,
  ReducerError,
} from './reducer.js';
import type { AccountDatabase } from '../storage/database.js';
import { MutationOutbox, type OutboxEntry } from '../storage/outbox.js';

/* -------------------------------------------------------------------------- */
/* Collaborators                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Supplies credentials without surrendering them.
 *
 * The sync client asks for a token per request and forgets it. It never caches
 * one, never puts one in an error, and never hands one to a callback. Refresh
 * and storage are the auth module's business.
 */
export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  /** Called on 401 so the next attempt refreshes rather than reusing. */
  invalidateAccessToken(): void;
  /**
   * The current device session id. Load-bearing: the server's mutation
   * idempotency receipt is keyed on it, so the outbox must know when it changes.
   */
  getDeviceSessionId(): string;
}

export type SyncPhase =
  | 'idle'
  | 'bootstrapping'
  | 'catching-up'
  | 'live'
  | 'offline'
  | 'signed-out'
  | 'error';

export interface SyncStatus {
  readonly phase: SyncPhase;
  readonly cursor: ChangeCursor | null;
  readonly lastSyncedAt: number | null;
  readonly pendingMutations: number;
  readonly deadLetters: number;
  readonly conflicts: number;
  /** Never carries credential material — `SyncError.toDiagnostic()` only. */
  readonly lastError: ReturnType<SyncError['toDiagnostic']> | null;
}

export interface SyncClientOptions {
  readonly baseUrl: string;
  readonly accountId: string;
  readonly database: AccountDatabase;
  readonly tokens: AccessTokenProvider;
  readonly outbox?: MutationOutbox;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly onStatus?: (status: SyncStatus) => void;
  readonly logger?: Pick<Console, 'warn' | 'error' | 'info'>;
  /** Page size for `/changes`. */
  readonly changePageSize?: number;
  readonly requestTimeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Sync state keys                                                             */
/* -------------------------------------------------------------------------- */

const CURSOR_KEY = 'sync.changeCursor';
const FLOOR_KEY = 'sync.compactionFloorCursor';
const BOOTSTRAPPED_AT_KEY = 'sync.bootstrappedAt';
const DEVICE_SESSION_KEY = 'sync.deviceSessionId';

/* -------------------------------------------------------------------------- */
/* Backoff                                                                     */
/* -------------------------------------------------------------------------- */

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/* The server holds the stream ~55s; allow generous headroom before assuming
   the connection is wedged rather than merely quiet. */
const STREAM_IDLE_TIMEOUT_MS = 90_000;
/**
 * How long a wakeup stream must survive to count as a healthy cycle.
 *
 * Below this, an immediate reconnect would be a hot loop rather than the
 * server's normal 55-second rhythm, so the reconnect backs off instead.
 */
const MIN_HEALTHY_STREAM_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* SyncClient                                                                  */
/* -------------------------------------------------------------------------- */

export class SyncClient {
  readonly #baseUrl: string;
  readonly #db: AccountDatabase;
  readonly #tokens: AccessTokenProvider;
  readonly #outbox: MutationOutbox;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #onStatus: (status: SyncStatus) => void;
  readonly #log: Pick<Console, 'warn' | 'error' | 'info'>;
  readonly #changePageSize: number;
  readonly #requestTimeoutMs: number;

  #running = false;
  /** Lifecycle: aborted only by `stop()`. Cancels everything. */
  #abort: AbortController | null = null;
  /**
   * The current SSE connection, aborted independently of the lifecycle.
   *
   * Two controllers rather than one because "drop this connection and redial"
   * and "shut the engine down" are different intentions, and conflating them
   * means a wake-from-sleep quietly terminates sync until the app restarts.
   */
  #streamAbort: AbortController | null = null;
  #loop: Promise<void> | null = null;
  #wakeSignal: (() => void) | null = null;
  #phase: SyncPhase = 'idle';
  #lastSyncedAt: number | null = null;
  #lastError: SyncError | null = null;

  constructor(options: SyncClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#db = options.database;
    this.#tokens = options.tokens;
    this.#outbox = options.outbox ?? new MutationOutbox(options.database);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#onStatus = options.onStatus ?? (() => {});
    this.#log = options.logger ?? console;
    this.#changePageSize = Math.min(
      MAX_CHANGE_PAGE_SIZE,
      Math.max(1, options.changePageSize ?? 200),
    );
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#abort = new AbortController();

    /* An entry stranded `inflight` by a crash is replayed. Safe because the
       server deduplicates on the idempotency key within the device session. */
    try {
      const recovered = this.#outbox.recoverInflight();
      if (recovered > 0) this.#log.info(`[sync] recovered ${recovered} in-flight mutations`);
    } catch (error) {
      this.#log.error('[sync] could not recover in-flight mutations', describe(error));
    }

    this.#loop = this.#run().catch((error: unknown) => {
      this.#log.error('[sync] loop exited', describe(error));
    });

    void this.#attachPowerHooks();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#abort?.abort();
    this.#wakeSignal?.();
    const loop = this.#loop;
    this.#loop = null;
    this.#setPhase('idle');
    if (loop) await loop;
  }

  /**
   * Force a sync now.
   *
   * The path for "the network came back", "the machine woke up", and "the user
   * pressed refresh". It never bypasses the stored cursor — a forced sync is
   * still a resume, not a restart.
   */
  wake(): void {
    this.#wakeSignal?.();
  }

  /**
   * Publish a phase change.
   *
   * Only ever emits `SyncStatus`, which by construction carries no credential
   * material: the renderer learns that sync is offline, never what it is
   * offline *with*.
   */
  #setPhase(phase: SyncPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    try {
      this.#onStatus(this.status());
    } catch (error) {
      /* A subscriber throwing must not take the sync loop with it. */
      this.#log.error('[sync] status subscriber threw', describe(error));
    }
  }

  status(): SyncStatus {
    const stats = this.#outbox.stats();
    return {
      phase: this.#phase,
      cursor: this.#readCursor(),
      lastSyncedAt: this.#lastSyncedAt,
      pendingMutations: stats.pending + stats.inflight,
      deadLetters: stats.dead,
      conflicts: stats.conflicted,
      lastError: this.#lastError?.toDiagnostic() ?? null,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* The loop                                                                */
  /* ---------------------------------------------------------------------- */

  async #run(): Promise<void> {
    let reconnectAttempt = 0;

    while (this.#running) {
      const lifecycle = this.#abort;
      if (!lifecycle || lifecycle.signal.aborted) return;
      const signal = lifecycle.signal;

      /* A fresh controller per connection, so a wake-from-sleep can drop the
         dead socket without touching an in-flight page fetch or the loop. */
      this.#streamAbort = new AbortController();
      const streamSignal = AbortSignal.any([signal, this.#streamAbort.signal]);

      try {
        await this.#syncToHead(signal);
        await this.#drainOutbox(signal);
        this.#setPhase('live');

        /* Subscribe from the cursor we have actually committed, so a change that
           landed between the last page and this subscribe produces an immediate
           catch-up event rather than being missed. */
        const cursor = this.#readCursor() ?? '0';
        const streamStartedAt = this.#now();
        for await (const wakeup of this.#wakeups(cursor, streamSignal)) {
          if (!this.#running) return;
          if (wakeup.kind === 'done') break; // Normal 55s cycle end.
          if (wakeup.kind === 'ready') continue;

          /* A `cursor` frame says only "something moved". The cursor it carries
             is deliberately NOT trusted as a place to jump to — the client reads
             the authoritative pages from its own committed cursor. The catch-up
             runs on the lifecycle signal so that dropping the stream mid-page
             does not abandon a half-applied sync. */
          this.#setPhase('catching-up');
          await this.#syncToHead(signal);
          await this.#drainOutbox(signal);
          this.#setPhase('live');
        }
        /*
         * `done`, or the stream ended.
         *
         * A stream that ran for a healthy stretch is the server's normal
         * ~55-second cycle, and reconnecting instantly is right — a backoff here
         * would add dead air to every single change.
         *
         * A stream that ended immediately is a different animal: a proxy closing
         * the connection, a 200 with an empty body, a load balancer draining.
         * Reconnecting instantly on *that* is an unthrottled request loop
         * against the server, which is both a self-inflicted outage and a good
         * way to get rate-limited. So the reset of the attempt counter is
         * earned by duration, not granted by reaching this line.
         */
        if (this.#now() - streamStartedAt >= MIN_HEALTHY_STREAM_MS) {
          reconnectAttempt = 0;
        } else {
          this.#log.warn('[sync] the wakeup stream closed immediately; backing off');
          await this.#sleep(this.#backoff(reconnectAttempt++), signal);
        }
      } catch (error) {
        if (!this.#running || signal.aborted) return;

        /* The stream was dropped deliberately — a resume, or a forced refresh.
           Redial at once; backing off here would add a minute of dead air to
           the exact moment the user came back to the machine. */
        if (this.#streamAbort?.signal.aborted) {
          this.#setPhase('catching-up');
          continue;
        }

        const syncError = toSyncError(error);
        this.#lastError = syncError;

        if (syncError.code === 'unauthorized') {
          /* The auth module owns recovery. Sitting in a tight reconnect loop
             against a revoked credential is how an account gets rate-limited. */
          this.#tokens.invalidateAccessToken();
          this.#setPhase('signed-out');
          this.#log.warn('[sync] unauthorized; waiting for re-authentication');
          await this.#sleep(this.#backoff(reconnectAttempt++), signal);
          continue;
        }

        this.#setPhase(syncError.code === 'transport' ? 'offline' : 'error');
        this.#log.warn(`[sync] ${syncError.code}: ${syncError.message}`, {
          requestId: syncError.requestId,
          status: syncError.status,
        });

        const delay = syncError.retryAfterMs ?? this.#backoff(reconnectAttempt++);
        await this.#sleep(delay, signal);
      }
    }
  }

  #backoff(attempt: number): number {
    const exponential = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt));
    /* Full jitter: every client on a recovering network must not retry in step. */
    return Math.round(exponential * (0.5 + this.#random() * 0.5));
  }

  /** Interruptible sleep — a wake() or a stop() cuts it short. */
  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        this.#wakeSignal = null;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      this.#wakeSignal = finish;
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Bootstrap                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Build a complete local baseline.
   *
   * Order matters and is not negotiable: `/bootstrap` is read **first** and its
   * `currentChangeCursor` is the cursor committed with the baseline. Enumerating
   * first and reading the cursor afterwards would silently drop every write that
   * happened during the enumeration, because the later cursor claims to cover
   * changes the snapshot never saw.
   *
   * Taking the cursor first can only cause the opposite, harmless error: a
   * change already reflected in the snapshot is replayed from the feed, and the
   * reducer discards it as already-current.
   */
  async bootstrap(signal: AbortSignal): Promise<ChangeCursor> {
    this.#setPhase('bootstrapping');

    const bootstrapResponse = await this.#request('/bootstrap', bootstrapResponseSchema, signal);
    const baselineCursor = bootstrapResponse.currentChangeCursor;

    const references = await this.#walkEntityIndex(signal);
    const hydrated: EntityEnvelope[] = [];
    for (const batch of batchReferences(references, MAX_ENTITY_IDS_PER_REQUEST)) {
      hydrated.push(...(await this.#hydrate(batch.entityType, batch.ids, signal)));
    }

    this.#db.transaction(() => {
      /* A rebuild replaces the mirror wholesale. The outbox is deliberately NOT
         cleared: it holds intent the server has not yet accepted, and a
         re-bootstrap (typically after a compaction 410) is not a reason to
         discard the user's unsent work. */
      this.#db.exec('DELETE FROM entities');

      for (const envelope of hydrated) {
        this.#writeEntity({
          entityKey: entityKey(envelope.type, envelope.id),
          entityType: envelope.type,
          entityId: envelope.id,
          revision: envelope.revision,
          deletedAt: envelope.deletedAt,
          data: envelope.data,
          sourceCursor: baselineCursor,
          clearPending: false,
        });
      }

      this.#writeSyncState(CURSOR_KEY, baselineCursor);
      this.#writeSyncState(FLOOR_KEY, bootstrapResponse.compactionFloorCursor);
      this.#writeSyncState(BOOTSTRAPPED_AT_KEY, String(this.#now()));
      this.#writeSyncState(DEVICE_SESSION_KEY, this.#tokens.getDeviceSessionId());
    });

    this.#log.info(
      `[sync] bootstrapped ${hydrated.length} entities at cursor ${baselineCursor}`,
    );
    return baselineCursor;
  }

  async #walkEntityIndex(signal: AbortSignal): Promise<EntityIndexItem[]> {
    const items: EntityIndexItem[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;

    for (;;) {
      const query = new URLSearchParams({ limit: String(MAX_ENTITY_INDEX_LIMIT) });
      if (after !== null) query.set('after', after);

      const page = await this.#request(
        `/entities/index?${query.toString()}`,
        entityIndexResponseSchema,
        signal,
      );
      items.push(...page.items);

      if (!page.hasMore) break;
      if (page.nextAfter === null) {
        throw new SyncError(
          'malformed_response',
          'The entity index reported more pages but returned no cursor.',
        );
      }
      /* A repeated keyset cursor is an infinite loop waiting to happen. */
      if (seenCursors.has(page.nextAfter)) {
        throw new SyncError(
          'malformed_response',
          'The entity index repeated a keyset cursor; refusing to loop.',
        );
      }
      seenCursors.add(page.nextAfter);
      after = page.nextAfter;
    }

    return items;
  }

  /* ---------------------------------------------------------------------- */
  /* Incremental sync                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Fetch and apply pages until the account is current.
   *
   * The cursor is re-read from the database on every iteration rather than
   * carried in a local variable. That is what makes a crash, a sleep, or a
   * process restart resumable: memory is not a source of truth about what has
   * been committed.
   */
  async #syncToHead(signal: AbortSignal): Promise<void> {
    let rebuilt = false;

    for (;;) {
      if (!this.#running || signal.aborted) return;

      let cursor = this.#readCursor();
      if (cursor === null) {
        cursor = await this.bootstrap(signal);
        rebuilt = true;
      }

      let page: ChangesResponse;
      try {
        page = await this.#fetchChangePage(cursor, signal);
      } catch (error) {
        if (error instanceof SyncError && error.code === 'cursor_compacted') {
          /*
           * Not an error condition — the expected outcome of being offline for
           * longer than the server's 30-day retention window. The changes
           * between our cursor and the compaction floor have been pruned, so an
           * incremental catch-up would silently lose data. Rebuild.
           */
          if (rebuilt) {
            throw new SyncError(
              'cursor_compacted',
              'The change cursor was compacted again immediately after a rebuild.',
            );
          }
          this.#log.info('[sync] cursor below the compaction floor; rebuilding from bootstrap');
          this.#clearCursor();
          rebuilt = true;
          continue;
        }
        throw error;
      }

      const plan = await this.#reducePage(cursor, page, signal);
      this.#applyPlan(plan);
      this.#lastSyncedAt = this.#now();
      this.#lastError = null;

      if (!page.hasMore || plan.disposition === 'up-to-date') return;
    }
  }

  async #fetchChangePage(after: ChangeCursor, signal: AbortSignal): Promise<ChangesResponse> {
    const query = new URLSearchParams({ after, limit: String(this.#changePageSize) });
    return this.#request(`/changes?${query.toString()}`, changesResponseSchema, signal);
  }

  async #reducePage(
    cursor: ChangeCursor,
    page: ChangesResponse,
    signal: AbortSignal,
  ): Promise<ReducePlan> {
    const hydrated: EntityEnvelope[] = [];
    for (const request of hydrationRequestsForPage(page.changes, MAX_ENTITY_IDS_PER_REQUEST)) {
      hydrated.push(...(await this.#hydrate(request.entityType, request.ids, signal)));
    }

    const local = this.#readLocalState(page);

    try {
      return reduceChangePage({ storedCursor: cursor, page, hydrated, local });
    } catch (error) {
      if (error instanceof ReducerError) {
        /* A gap or a stale hydration means the two reads disagreed. Both are
           resolved by refetching from the committed cursor, so they surface as
           retryable transport-class failures rather than as corruption. */
        const retryable =
          error.code === 'cursor_gap' ||
          error.code === 'stale_hydration' ||
          error.code === 'missing_entity';
        throw new SyncError(retryable ? 'transport' : 'malformed_response', error.message, {
          retryable,
          details: { ...error.context, reducer: error.code },
        });
      }
      throw error;
    }
  }

  /**
   * Everything the reducer needs to know about local rows, in two queries.
   *
   * The pending-mutation view comes from the outbox, not from a flag someone
   * remembered to set: unacknowledged intent *is* the set of outbox entries in a
   * non-terminal state.
   */
  #readLocalState(page: ChangesResponse): Map<string, LocalEntityState> {
    const local = new Map<string, LocalEntityState>();
    if (page.changes.length === 0) return local;

    const pending = this.#outbox.pendingByEntity();
    const keys = new Set(page.changes.map((change) => entityKey(change.entityType, change.entityId)));

    /* Chunked so a 500-change page does not build a 500-term IN list. */
    const all = [...keys];
    for (let index = 0; index < all.length; index += 200) {
      const chunk = all.slice(index, index + 200);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.#db
        .statement(
          `SELECT entity_key, revision, deleted_at FROM entities WHERE entity_key IN (${placeholders})`,
        )
        .all(...chunk);

      for (const row of rows) {
        const key = String(row['entity_key'] ?? '');
        const intent = pending.get(key) ?? null;
        local.set(key, {
          revision: Number(row['revision'] ?? 0),
          deleted: row['deleted_at'] !== null && row['deleted_at'] !== undefined,
          pendingMutation:
            intent === null
              ? null
              : {
                  seq: intent.seq,
                  baseRevision: intent.baseRevision,
                  acknowledgedRevision: intent.serverRevision,
                },
        });
      }
    }

    /* Entities we have never seen, but that already carry local intent — a
       create whose server row is arriving for the first time. */
    for (const key of keys) {
      if (local.has(key)) continue;
      const intent = pending.get(key);
      if (!intent) continue;
      local.set(key, {
        revision: 0,
        deleted: false,
        pendingMutation: {
          seq: intent.seq,
          baseRevision: intent.baseRevision,
          acknowledgedRevision: intent.serverRevision,
        },
      });
    }

    return local;
  }

  /**
   * Commit a plan.
   *
   * One transaction covering the entity writes, the projections, the conflict
   * records and the cursor. The cursor moving in the same transaction as the
   * rows it describes is the whole basis of crash-safety: there is no instant at
   * which the cursor claims coverage the data does not have.
   */
  #applyPlan(plan: ReducePlan): void {
    if (plan.disposition === 'already-applied') return;

    this.#db.transaction(() => {
      for (const write of plan.writes) {
        this.#writeEntity({
          entityKey: write.entityKey,
          entityType: write.entityType,
          entityId: write.entityId,
          revision: write.revision,
          deletedAt: write.kind === 'tombstone' ? write.deletedAt : null,
          data: write.kind === 'upsert' ? write.data : null,
          sourceCursor: write.sourceCursor,
          clearPending: write.clearsPendingMutation,
        });
      }

      for (const conflict of plan.conflicts) {
        this.#db
          .statement(
            `INSERT INTO sync_conflicts
               (entity_key, entity_type, entity_id, outbox_seq, kind,
                local_revision, server_revision, local_payload, detected_at)
             SELECT ?,?,?,?,?,?,?, o.request_body, ?
               FROM outbox o WHERE o.seq = ?`,
          )
          .run(
            conflict.entityKey,
            conflict.entityType,
            conflict.entityId,
            conflict.outboxSeq,
            conflict.kind,
            conflict.localRevision,
            conflict.serverRevision,
            this.#now(),
            conflict.outboxSeq,
          );

        /* Quarantine the intent rather than let the drainer send a mutation
           whose base revision the server has already moved past. */
        this.#db
          .statement(
            `UPDATE outbox SET state='conflicted', last_error_code=?, server_revision=?, updated_at=?
              WHERE seq=? AND state IN ('pending','inflight')`,
          )
          .run(conflict.kind, conflict.serverRevision, this.#now(), conflict.outboxSeq);
      }

      this.#writeSyncState(CURSOR_KEY, plan.nextCursor);
      this.#writeSyncState(FLOOR_KEY, plan.compactionFloorCursor);
    });

    if (plan.unknownEntityTypes.length > 0) {
      this.#log.warn(
        `[sync] the server sent entity types this build does not know: ${plan.unknownEntityTypes.join(', ')}. Update Juno Desktop.`,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Outbox drain                                                            */
  /* ---------------------------------------------------------------------- */

  async #drainOutbox(signal: AbortSignal): Promise<void> {
    const deviceSessionId = this.#tokens.getDeviceSessionId();

    for (;;) {
      if (!this.#running || signal.aborted) return;

      const batch = this.#outbox.claimBatch(deviceSessionId, 10);
      if (batch.length === 0) return;

      for (const entry of batch) {
        if (!this.#running || signal.aborted) return;
        await this.#submitMutation(entry, signal);
      }
    }
  }

  async #submitMutation(entry: OutboxEntry, signal: AbortSignal): Promise<void> {
    let body: string;
    try {
      body = this.#outbox.requestBodyFor(entry);
    } catch (error) {
      this.#outbox.markConflicted(entry.seq, 'rejected', {
        errorCode: 'body_tampered',
        errorMessage: describe(error),
      });
      return;
    }

    try {
      const result = await this.#request('/mutations', mutationResultSchema, signal, {
        method: 'POST',
        body,
      });

      this.#db.transaction(() => {
        /* A create returns the server id for the optimistic local id. Recording
           it is what lets the next mutation against the same entity carry a real
           entityId instead of a client one. */
        if (entry.clientEntityId !== null && result.entityMappings) {
          const serverId = result.entityMappings[entry.clientEntityId];
          if (typeof serverId === 'string' && serverId.length > 0) {
            this.#db
              .statement('UPDATE outbox SET entity_id=?, updated_at=? WHERE seq=?')
              .run(serverId, this.#now(), entry.seq);
          }
        }
      });

      this.#outbox.markDone(entry.seq, {
        serverRevision: result.entity.revision,
        raw: result,
      });
    } catch (error) {
      const syncError = toSyncError(error);

      switch (syncError.code) {
        case 'revision_conflict': {
          /* Never merged server-side. The user decides; `rebase()` mints a fresh
             idempotency key because the same key with a different baseRevision
             is exactly what the server rejects. */
          const currentRevision = readNumber(syncError.details?.['currentRevision']);
          this.#outbox.markConflicted(entry.seq, 'revision_conflict', {
            errorCode: syncError.serverCode ?? 'revision_conflict',
            errorMessage: syncError.message,
            serverRevision: currentRevision,
          });
          return;
        }
        case 'idempotency_key_reused': {
          this.#outbox.markConflicted(entry.seq, 'key_reused', {
            errorCode: 'idempotency_key_reused',
            errorMessage:
              'This change was already submitted with different content. It needs to be reviewed rather than resent.',
          });
          return;
        }
        case 'suppressed_by_memory':
        case 'rejected': {
          /* `retryable:false` from the server means retrying forever is the
             wrong answer — a memory the account asked Juno to forget will never
             be accepted, however many times it is offered. */
          this.#outbox.markConflicted(entry.seq, 'rejected', {
            errorCode: syncError.serverCode ?? 'rejected',
            errorMessage: syncError.message,
          });
          return;
        }
        case 'unauthorized': {
          this.#tokens.invalidateAccessToken();
          /* Not a failure of this mutation. Leave it claimable and let the loop
             handle re-authentication. */
          this.#outbox.markRetryable(entry.seq, 'unauthorized', syncError.message);
          throw syncError;
        }
        default: {
          const state = this.#outbox.markRetryable(
            entry.seq,
            syncError.serverCode ?? syncError.code,
            syncError.message,
          );
          if (state === 'dead') {
            this.#log.error(
              `[sync] mutation ${entry.operation} dead-lettered after ${entry.attemptCount} attempts`,
              { requestId: syncError.requestId },
            );
          }
          return;
        }
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* HTTP                                                                    */
  /* ---------------------------------------------------------------------- */

  async #request<T>(
    path: string,
    schema: { parse: (value: unknown) => T },
    signal: AbortSignal,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    const response = await this.#send(path, signal, init, 'application/json');

    let payload: unknown;
    const text = await response.text();
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new SyncError('malformed_response', `${path} did not return JSON.`, {
        status: response.status,
        requestId: requestIdOf(response),
      });
    }

    if (!response.ok) throw errorFor(response, payload, path);

    try {
      /* The validation boundary. Nothing reaches SQLite that has not been
         through a schema — a malformed payload becomes an error here rather than
         a corrupt row discovered three releases later. */
      return schema.parse(payload);
    } catch (cause) {
      throw new SyncError('malformed_response', `${path} did not match the contract.`, {
        status: response.status,
        requestId: requestIdOf(response),
        cause,
      });
    }
  }

  async #send(
    path: string,
    signal: AbortSignal,
    init: { method?: string; body?: string },
    accept: string,
  ): Promise<Response> {
    const token = await this.#tokens.getAccessToken();

    const headers: Record<string, string> = {
      /* Held for exactly the duration of this call. Never stored on `this`,
         never placed on an error, never given to a callback. */
      Authorization: `Bearer ${token}`,
      Accept: accept,
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    /*
     * Deliberately NO `Origin` header.
     *
     * `src/middleware.ts` rejects any mutating `/api/` request whose `Origin`
     * does not match the host, with a 403 and no CORS relief anywhere. A request
     * with no Origin at all is the intended native path. Running in the main
     * process means nothing adds one for us — but it also means nothing stops us
     * adding one by accident, hence the note.
     */

    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    const composed = AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/v1${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: composed,
        /* A redirect off this origin would carry the Authorization header to
           wherever it pointed. `error` makes that impossible rather than
           unlikely. */
        redirect: 'error',
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      /* Network-class failure: DNS, TLS, reset, timeout. Retryable, and reported
         without the URL's query string so a cursor never lands in a log line
         beside an error the user might paste somewhere. */
      throw new SyncError('transport', `Could not reach Juno (${redactPath(path)}).`, {
        retryable: true,
        cause,
      });
    }

    return response;
  }

  async #hydrate(
    entityType: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<EntityEnvelope[]> {
    if (ids.length === 0) return [];
    if (ids.length > MAX_ENTITY_IDS_PER_REQUEST) {
      throw new SyncError(
        'malformed_response',
        `Refusing to request ${ids.length} ids; the server accepts at most ${MAX_ENTITY_IDS_PER_REQUEST}.`,
      );
    }
    const query = new URLSearchParams({ type: entityType, ids: ids.join(',') });
    const response = await this.#request(
      `/entities?${query.toString()}`,
      entitiesResponseSchema,
      signal,
    );
    return response.entities;
  }

  /* ---------------------------------------------------------------------- */
  /* SSE wakeups                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Read the wakeup stream.
   *
   * `fetch` rather than `EventSource`, because the bearer credential must travel
   * in a header and `EventSource` cannot set one.
   *
   * The dialect here is *named* SSE events, which is specific to this endpoint —
   * Juno's chat stream uses anonymous `data:` frames with a `type` field inside
   * the JSON. Frames beginning with `:` are heartbeat comments and carry no
   * data; they exist so that a proxy does not reap an idle connection, and are
   * discarded after resetting the idle timer.
   */
  async *#wakeups(after: ChangeCursor, signal: AbortSignal): AsyncGenerator<ChangeWakeup> {
    const query = new URLSearchParams({ after });
    const response = await this.#send(
      `/changes/stream?${query.toString()}`,
      signal,
      {},
      'text/event-stream',
    );

    if (!response.ok) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(await response.text()) as unknown;
      } catch {
        /* Non-JSON error body; the status alone drives the decision. */
      }
      throw errorFor(response, payload, '/changes/stream');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('text/event-stream')) {
      throw new SyncError(
        'malformed_response',
        `The wakeup stream returned ${contentType || 'no content type'}.`,
        { requestId: requestIdOf(response) },
      );
    }
    if (!response.body) {
      throw new SyncError('transport', 'The wakeup stream had no body.', { retryable: true });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName: string | null = null;
    let dataLines: string[] = [];
    let lastActivity = this.#now();

    try {
      for (;;) {
        if (signal.aborted || !this.#running) return;

        const { done, value } = await reader.read();
        if (done) return;

        if (this.#now() - lastActivity > STREAM_IDLE_TIMEOUT_MS) {
          throw new SyncError('transport', 'The wakeup stream went silent.', { retryable: true });
        }
        lastActivity = this.#now();

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);

          if (line.length === 0) {
            const event = takeEvent(eventName, dataLines);
            eventName = null;
            dataLines = [];
            if (event) yield event;
            continue;
          }

          if (line.startsWith(':')) continue; // heartbeat comment

          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
          if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);

          if (field === 'event') eventName = fieldValue;
          else if (field === 'data') dataLines.push(fieldValue);
          /* `id` and `retry` are unused by this endpoint. */
        }
      }
    } finally {
      /* Release the connection whichever way we leave — a generator abandoned by
         a `break` in the consumer must not leak a socket. */
      try {
        await reader.cancel();
      } catch {
        /* Already torn down. */
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Local state helpers                                                     */
  /* ---------------------------------------------------------------------- */

  #readCursor(): ChangeCursor | null {
    const row = this.#db.statement('SELECT value FROM sync_state WHERE key = ?').get(CURSOR_KEY);
    const value = row?.['value'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  #clearCursor(): void {
    this.#db.transaction(() => {
      this.#db.statement('DELETE FROM sync_state WHERE key = ?').run(CURSOR_KEY);
    });
  }

  #writeSyncState(key: string, value: string): void {
    this.#db
      .statement(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(key, value, this.#now());
  }

  /**
   * Write one entity and its projection.
   *
   * `entities` is the authoritative row; the typed table is a derived index.
   * Both move in the same statement pair inside the caller's transaction, and
   * the projection cascades from the entity, so the two cannot diverge.
   */
  #writeEntity(write: {
    entityKey: string;
    entityType: string;
    entityId: string;
    revision: number;
    deletedAt: string | null;
    data: Readonly<Record<string, unknown>> | null;
    sourceCursor: string;
    clearPending: boolean;
  }): void {
    const isTombstone = write.deletedAt !== null;
    const data = isTombstone ? null : JSON.stringify(write.data ?? {});
    const updatedAt = isTombstone
      ? write.deletedAt
      : readString(write.data, 'updatedAt') ?? write.deletedAt;

    this.#db
      .statement(
        `INSERT INTO entities
           (entity_key, entity_type, entity_id, revision, deleted_at, updated_at, data,
            source_cursor, pending_mutation_id)
         VALUES (?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(entity_key) DO UPDATE SET
           revision = excluded.revision,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at,
           data = excluded.data,
           source_cursor = excluded.source_cursor,
           pending_mutation_id = CASE WHEN ? THEN NULL ELSE entities.pending_mutation_id END`,
      )
      .run(
        write.entityKey,
        write.entityType,
        write.entityId,
        write.revision,
        write.deletedAt,
        updatedAt,
        data,
        write.sourceCursor,
        write.clearPending ? 1 : 0,
      );

    this.#project(write.entityType, write.entityKey, write.entityId, write.revision, isTombstone ? null : write.data);
  }

  /**
   * Maintain the typed projection for an entity, if it has one.
   *
   * A tombstone deletes the projection row: the typed tables carry live rows
   * only, so `SELECT * FROM conversations` never needs a `WHERE deleted_at IS
   * NULL` that someone will one day forget. The tombstone itself is retained in
   * `entities`, which is what makes deletion converge across devices.
   *
   * Types without a projection (there are 17 of them) live only in `entities`,
   * which is why the mirror is generic in the first place.
   */
  #project(
    entityType: string,
    key: string,
    id: string,
    revision: number,
    data: Readonly<Record<string, unknown>> | null,
  ): void {
    const table = PROJECTION_TABLES[entityType];
    if (!table) return;

    if (data === null) {
      this.#db.statement(`DELETE FROM ${table.name} WHERE entity_key = ?`).run(key);
      return;
    }

    const columns = ['entity_key', 'id', 'revision', ...table.columns.map(([column]) => column)];
    const placeholders = columns.map(() => '?').join(',');
    const assignments = columns
      .slice(1)
      .map((column) => `${column}=excluded.${column}`)
      .join(', ');

    const values: (string | number | null)[] = [
      key,
      id,
      revision,
      ...table.columns.map(([, read]) => read(data)),
    ];

    this.#db
      .statement(
        `INSERT INTO ${table.name} (${columns.join(',')}) VALUES (${placeholders})
           ON CONFLICT(entity_key) DO UPDATE SET ${assignments}`,
      )
      .run(...values);
  }

  /**
   * Resync on wake and on regaining the network.
   *
   * A laptop lid closing suspends the SSE connection without closing it; the
   * socket is dead but neither end knows until a write fails. Rather than
   * waiting for the idle timeout, the resume event forces a sync from the stored
   * cursor. Attached defensively so this module still runs under plain Node in
   * tests.
   */
  async #attachPowerHooks(): Promise<void> {
    try {
      const { powerMonitor } = await import('electron');
      const redial = (reason: string) => (): void => {
        if (!this.#running) return;
        this.#log.info(`[sync] ${reason}; reconnecting`);
        /* Drop only the stream. The lifecycle controller is untouched, so the
           loop continues and resumes from the stored cursor. */
        this.#streamAbort?.abort();
        this.wake();
      };
      powerMonitor.on('resume', redial('system resumed'));
      powerMonitor.on('unlock-screen', redial('screen unlocked'));
    } catch {
      /* Not running under Electron. */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Projections                                                                 */
/* -------------------------------------------------------------------------- */

type ProjectionColumn = readonly [string, (data: Readonly<Record<string, unknown>>) => string | number | null];

interface ProjectionTable {
  readonly name: string;
  readonly columns: readonly ProjectionColumn[];
}

const text =
  (field: string) =>
  (data: Readonly<Record<string, unknown>>): string | null =>
    readString(data, field);

const bool =
  (field: string) =>
  (data: Readonly<Record<string, unknown>>): number =>
    data[field] === true ? 1 : 0;

const int =
  (field: string) =>
  (data: Readonly<Record<string, unknown>>): number | null => {
    const value = data[field];
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
  };

const intOrZero =
  (field: string) =>
  (data: Readonly<Record<string, unknown>>): number => {
    const value = data[field];
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
  };

/**
 * Which entity types get a typed table, and how their JSON maps onto it.
 *
 * `scheduled_task` projects to `work_tasks` and `code_task` to `code_sessions`
 * — the names the product uses. Note that the Juno "Work" surface is *not* the
 * `scheduled_task` entity; Work has no entity type in the change feed at all.
 * See the contract-gaps section of `docs/SYNC.md`.
 */
const PROJECTION_TABLES: Readonly<Record<string, ProjectionTable>> = {
  conversation: {
    name: 'conversations',
    columns: [
      ['title', text('title')],
      ['kind', text('kind')],
      ['model', text('model')],
      ['origin', text('origin')],
      ['pinned', bool('pinned')],
      ['archived_at', text('archivedAt')],
      ['folder_id', text('folderId')],
      ['project_id', text('projectId')],
      ['forked_from_id', text('forkedFromId')],
      ['created_at', text('createdAt')],
      ['updated_at', text('updatedAt')],
      ['last_message_at', text('lastMessageAt')],
      ['deleted_at', () => null],
    ],
  },
  message: {
    name: 'messages',
    columns: [
      ['conversation_id', text('conversationId')],
      ['client_id', text('clientId')],
      ['role', text('role')],
      ['content', text('content')],
      ['reasoning', text('reasoning')],
      ['model', text('model')],
      ['prompt_tokens', int('promptTokens')],
      ['completion_tokens', int('completionTokens')],
      ['created_at', text('createdAt')],
      ['updated_at', text('updatedAt')],
      ['deleted_at', () => null],
    ],
  },
  project: {
    name: 'projects',
    columns: [
      ['name', text('name')],
      ['instructions', text('instructions')],
      ['starred', bool('starred')],
      ['created_at', text('createdAt')],
      ['updated_at', text('updatedAt')],
      ['deleted_at', () => null],
    ],
  },
  scheduled_task: {
    name: 'work_tasks',
    columns: [
      ['name', text('name')],
      ['prompt', text('prompt')],
      ['model', text('model')],
      ['cadence', text('cadence')],
      ['timezone', text('timezone')],
      ['enabled', bool('enabled')],
      ['last_run_at', text('lastRunAt')],
      ['next_run_at', text('nextRunAt')],
      ['conversation_id', text('conversationId')],
      ['created_at', text('createdAt')],
      ['updated_at', text('updatedAt')],
      ['deleted_at', () => null],
    ],
  },
  code_task: {
    name: 'code_sessions',
    columns: [
      ['device_id', text('deviceId')],
      ['workspace_key', text('workspaceKey')],
      ['workspace_name', text('workspaceName')],
      ['title', text('title')],
      ['prompt', text('prompt')],
      ['status', text('status')],
      ['last_seq', intOrZero('lastSeq')],
      ['conversation_id', text('conversationId')],
      ['created_at', text('createdAt')],
      ['updated_at', text('updatedAt')],
      ['deleted_at', () => null],
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function takeEvent(name: string | null, dataLines: readonly string[]): ChangeWakeup | null {
  if (name === null || dataLines.length === 0) return null;
  const raw = dataLines.join('\n');

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    /* A frame we cannot parse is a frame we ignore. The next authoritative
       fetch is what actually moves state, so a dropped doorbell costs at most
       one 55-second cycle — far better than tearing down a healthy stream. */
    return null;
  }

  switch (name) {
    case 'ready': {
      const parsed = readyEventSchema.safeParse(payload);
      return parsed.success ? { kind: 'ready', after: parsed.data.after } : null;
    }
    case 'cursor': {
      const parsed = cursorEventSchema.safeParse(payload);
      return parsed.success ? { kind: 'cursor', cursor: parsed.data.cursor } : null;
    }
    case 'done':
      return { kind: 'done' };
    default:
      return null;
  }
}

function batchReferences(
  items: readonly EntityIndexItem[],
  batchSize: number,
): readonly { entityType: string; ids: string[] }[] {
  const byType = new Map<string, string[]>();
  for (const item of items) {
    const ids = byType.get(item.type);
    if (ids) ids.push(item.id);
    else byType.set(item.type, [item.id]);
  }

  const batches: { entityType: string; ids: string[] }[] = [];
  for (const [entityType, ids] of [...byType.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (let index = 0; index < ids.length; index += batchSize) {
      batches.push({ entityType, ids: ids.slice(index, index + batchSize) });
    }
  }
  return batches;
}

function requestIdOf(response: Response): string | undefined {
  return response.headers.get('x-juno-request-id') ?? undefined;
}

/** Map an HTTP failure onto the typed error the retry policy reads. */
function errorFor(response: Response, payload: unknown, path: string): SyncError {
  const parsed = errorEnvelopeSchema.safeParse(payload);
  const envelope = parsed.success ? parsed.data.error : null;
  const requestId = requestIdOf(response) ?? envelope?.requestId;
  const serverCode = envelope?.code;
  const message = envelope?.message ?? `${redactPath(path)} failed with ${response.status}.`;

  const base = {
    status: response.status,
    ...(serverCode === undefined ? {} : { serverCode }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(envelope?.retryAfterMs === undefined || envelope.retryAfterMs === null
      ? {}
      : { retryAfterMs: envelope.retryAfterMs }),
    ...(envelope?.details === undefined ? {} : { details: envelope.details }),
  };

  if (response.status === 401) return new SyncError('unauthorized', message, base);
  if (response.status === 410 && serverCode === 'cursor_compacted') {
    return new SyncError('cursor_compacted', message, base);
  }
  if (response.status === 409) {
    if (serverCode === 'idempotency_key_reused') {
      return new SyncError('idempotency_key_reused', message, base);
    }
    if (serverCode === 'suppressed_by_memory') {
      return new SyncError('suppressed_by_memory', message, base);
    }
    return new SyncError('revision_conflict', message, base);
  }
  if (response.status === 429 || response.status >= 500) {
    return new SyncError('transport', message, { ...base, retryable: true });
  }
  return new SyncError('rejected', message, {
    ...base,
    retryable: envelope?.retryable ?? false,
  });
}

function toSyncError(error: unknown): SyncError {
  if (error instanceof SyncError) return error;
  return new SyncError('transport', describe(error), { retryable: true, cause: error });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Strips the query string, which is where cursors and ids live. */
function redactPath(path: string): string {
  const index = path.indexOf('?');
  return index === -1 ? path : path.slice(0, index);
}

function readString(
  data: Readonly<Record<string, unknown>> | null | undefined,
  field: string,
): string | null {
  if (!data) return null;
  const value = data[field];
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}
