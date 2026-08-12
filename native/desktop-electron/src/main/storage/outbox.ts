/**
 * The durable mutation outbox.
 *
 * Every change the user makes locally is two facts that must be one fact: the
 * new local state, and the intent to tell the server about it. Written
 * separately, a crash between them either loses the mutation (state written,
 * intent lost) or double-applies it (intent written, state rolled back and
 * re-entered by the user). So they are written in a single SQLite transaction —
 * `commit()` is the only supported way in, and `enqueue()` refuses to run
 * outside a transaction rather than trusting callers to remember.
 *
 * ## The delivery guarantee, precisely
 *
 * Delivery is *at least once* on the wire and *at most once in effect*, and the
 * second half is the server's doing, not ours. `POST /api/v1/mutations` writes a
 * `MutationReceipt` keyed `(accountId, authenticatedDeviceId, clientMutationId)`
 * inside the same Serializable transaction as the mutation itself. A retry
 * carrying the same key and the same body gets the stored result back and the
 * work is not repeated. A retry carrying the same key and a *different* body is
 * rejected 409 `idempotency_key_reused`.
 *
 * Two consequences drive this module's design:
 *
 *  1. **The request body is frozen at enqueue time.** It is stored, hashed and
 *     resent byte-identical. In particular `baseRevision` is part of the body,
 *     so a mutation that loses an optimistic-concurrency race can NOT be retried
 *     with a fresh base revision under the same key — that is precisely the
 *     "same key, different work" the server rejects. Re-basing therefore mints a
 *     new key: see `rebase()`.
 *
 *  2. **The receipt is scoped to the device session.** The key includes
 *     `authenticatedDeviceId`. If the device session changes — a re-authentication
 *     that issues a new session rather than refreshing the old one — a replayed
 *     mutation is a *new* mutation to the server and executes again. Handled in
 *     `claimBatch()`; see `isSafeToReplayAcrossDeviceSessions`.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { AccountDatabase, SqlRow, SqlValue } from './database.js';

/* -------------------------------------------------------------------------- */
/* Model                                                                       */
/* -------------------------------------------------------------------------- */

export type OutboxState =
  /** Waiting for its turn, or for its backoff to elapse. */
  | 'pending'
  /** Leased by a drainer and either in flight or awaiting its outcome. */
  | 'inflight'
  /** Lost a race or was refused; needs a decision from the user. */
  | 'conflicted'
  /** Exhausted its retries. Surfaced, never silently dropped. */
  | 'dead'
  /** Accepted by the server. */
  | 'done'
  /** Replaced by a re-based copy carrying a new idempotency key. */
  | 'superseded';

const TERMINAL_STATES: ReadonlySet<OutboxState> = new Set<OutboxState>([
  'done',
  'superseded',
]);

/** States that block later mutations against the same entity from overtaking. */
const BLOCKING_STATES: readonly OutboxState[] = ['pending', 'inflight', 'conflicted', 'dead'];

export interface OutboxDraft {
  readonly entityType: string;
  /** The server id. `null` for a create, which has no server id yet. */
  readonly entityId: string | null;
  /** The optimistic local id used for a create; echoed back in `entityMappings`. */
  readonly clientEntityId?: string;
  /** e.g. `conversation.rename`. Must be one of the 15 the server implements. */
  readonly operation: string;
  /** The revision this intent was composed against. Creates use 0. */
  readonly baseRevision: number;
  /** The `operation` object of the request body, minus `type`. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxEntry {
  readonly seq: number;
  readonly clientMutationId: string;
  readonly deviceSessionId: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly clientEntityId: string | null;
  readonly operation: string;
  readonly baseRevision: number;
  readonly requestBody: string;
  readonly requestHash: string;
  readonly state: OutboxState;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly serverRevision: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OutboxStats {
  readonly pending: number;
  readonly inflight: number;
  readonly conflicted: number;
  readonly dead: number;
  readonly done: number;
  readonly oldestPendingAgeMs: number | null;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface OutboxOptions {
  /** Failures before an entry is dead-lettered. */
  readonly maxAttempts?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** How long a claimed entry stays leased before another drainer may reclaim it. */
  readonly leaseDurationMs?: number;
  /** Injectable for deterministic tests. Returns a value in [0, 1). */
  readonly random?: () => number;
  /** Injectable clock. Epoch milliseconds. */
  readonly now?: () => number;
}

const DEFAULTS = {
  maxAttempts: 8,
  initialBackoffMs: 1_000,
  maxBackoffMs: 5 * 60_000,
  leaseDurationMs: 60_000,
} as const;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class OutboxError extends Error {
  readonly code:
    | 'not_in_transaction'
    | 'not_found'
    | 'invalid_state'
    | 'invalid_draft'
    | 'body_tampered';

  constructor(code: OutboxError['code'], message: string) {
    super(message);
    this.name = 'OutboxError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Replay safety across device sessions                                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether replaying this operation under a *different* device session is safe.
 *
 * The server's idempotency receipt does not span device sessions, so a replay
 * after re-authentication is, to the server, a brand-new mutation. Whether that
 * is harmful depends entirely on whether the operation is conditional:
 *
 *  - **Creates are not.** `conversation.create` and friends require
 *    `baseRevision === 0` and then unconditionally insert a row. Replaying one
 *    produces a duplicate conversation, folder, project or memory — a visible,
 *    confusing, user-facing defect. These are quarantined instead of replayed.
 *
 *  - **Everything else is.** `rename`, `update`, `archive`, `delete` and
 *    `settings.update` all pass through `requireRevision()`, which demands
 *    strict equality with the current server revision and answers 409
 *    `revision_conflict` otherwise. So a replay of an already-applied mutation
 *    finds the revision moved on and fails harmlessly, while a replay of one
 *    that never landed does exactly what the user asked. The `baseRevision`
 *    check is itself the deduplication.
 *
 * This is why the destructive operations are the *safe* ones here and the
 * creates are not, which is the opposite of the usual intuition.
 */
export function isSafeToReplayAcrossDeviceSessions(operation: string): boolean {
  return !operation.endsWith('.create');
}

/* -------------------------------------------------------------------------- */
/* Outbox                                                                      */
/* -------------------------------------------------------------------------- */

export class MutationOutbox {
  #db: AccountDatabase;
  #maxAttempts: number;
  #initialBackoffMs: number;
  #maxBackoffMs: number;
  #leaseDurationMs: number;
  #random: () => number;
  #now: () => number;

  constructor(db: AccountDatabase, options: OutboxOptions = {}) {
    this.#db = db;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULTS.maxAttempts);
    this.#initialBackoffMs = Math.max(1, options.initialBackoffMs ?? DEFAULTS.initialBackoffMs);
    this.#maxBackoffMs = Math.max(
      this.#initialBackoffMs,
      options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
    );
    this.#leaseDurationMs = Math.max(1_000, options.leaseDurationMs ?? DEFAULTS.leaseDurationMs);
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  /* ---------------------------------------------------------------------- */
  /* Writing                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Apply a local state change and enqueue its mutation atomically.
   *
   * This is the only correct way to mutate anything. `applyLocal` runs inside
   * the transaction; if it throws, nothing is written and no mutation is queued.
   * If it succeeds, the local row and the outbox entry commit together or not at
   * all.
   *
   * Runs in a `durableTransaction`, which raises `synchronous` to FULL: an
   * outbox entry is the only copy of the user's intent until the server has it,
   * so unlike the mirror it is not reconstructible and is worth the fsync.
   */
  commit<T>(deviceSessionId: string, draft: OutboxDraft, applyLocal: () => T): { local: T; entry: OutboxEntry } {
    return this.#db.durableTransaction(() => {
      const local = applyLocal();
      const entry = this.enqueue(deviceSessionId, draft);
      return { local, entry };
    });
  }

  /**
   * Append one mutation. **Must** be called inside a transaction.
   *
   * The assertion is the guarantee. A comment saying "call this in a
   * transaction" is a comment; a throw is a design.
   */
  enqueue(deviceSessionId: string, draft: OutboxDraft): OutboxEntry {
    if (!this.#db.isTransaction) {
      throw new OutboxError(
        'not_in_transaction',
        'Outbox entries must be written in the same transaction as the local state change they describe. Use commit().',
      );
    }
    if (draft.entityType.length === 0 || draft.operation.length === 0) {
      throw new OutboxError('invalid_draft', 'A mutation needs an entity type and an operation.');
    }
    if (!Number.isInteger(draft.baseRevision) || draft.baseRevision < 0) {
      throw new OutboxError('invalid_draft', 'baseRevision must be a non-negative integer.');
    }
    if (deviceSessionId.length === 0) {
      throw new OutboxError('invalid_draft', 'A mutation must record the device session it was composed under.');
    }

    /* The server requires a UUID here — `mutationRequestSchema` declares
       `clientMutationId: z.string().uuid()` and 400s anything else. */
    const clientMutationId = randomUUID();

    /* The complete request body, frozen now and never rebuilt. `type` is folded
       into the operation object because that is where the server's discriminated
       union expects it. */
    const requestBody = JSON.stringify({
      clientMutationId,
      baseRevision: draft.baseRevision,
      operation: { type: draft.operation, ...draft.payload },
    });

    const now = this.#now();
    const entry: Omit<OutboxEntry, 'seq'> = {
      clientMutationId,
      deviceSessionId,
      entityType: draft.entityType,
      entityId: draft.entityId,
      clientEntityId: draft.clientEntityId ?? null,
      operation: draft.operation,
      baseRevision: draft.baseRevision,
      requestBody,
      requestHash: hashBody(requestBody),
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      lastErrorCode: null,
      lastErrorMessage: null,
      serverRevision: null,
      createdAt: now,
      updatedAt: now,
    };

    const result = this.#db
      .statement(
        `INSERT INTO outbox (
           client_mutation_id, device_session_id, entity_type, entity_id, client_entity_id,
           operation, base_revision, request_body, request_hash, state, attempt_count,
           next_attempt_at, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        entry.clientMutationId,
        entry.deviceSessionId,
        entry.entityType,
        entry.entityId,
        entry.clientEntityId,
        entry.operation,
        entry.baseRevision,
        entry.requestBody,
        entry.requestHash,
        entry.state,
        entry.attemptCount,
        entry.nextAttemptAt,
        entry.createdAt,
        entry.updatedAt,
      );

    return { ...entry, seq: Number(result.lastInsertRowid) };
  }

  /* ---------------------------------------------------------------------- */
  /* Draining                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Claim the next entries to send, in order.
   *
   * Ordering is global by `seq`, but an entry is skipped while an *earlier*
   * entry for the same entity is unresolved. That gives strict per-entity
   * ordering — a rename must not overtake the create that produced the id —
   * without letting one stuck entity halt the whole queue, which is what a
   * strictly serial drain would do the first time something dead-letters.
   *
   * Entries created under a different device session are diverted here rather
   * than sent, when replaying them would not be safe.
   */
  claimBatch(currentDeviceSessionId: string, limit = 10): OutboxEntry[] {
    const now = this.#now();

    return this.#db.durableTransaction(() => {
      /* Reclaim leases from a drainer that died mid-flight. Safe by
         construction: a replay under the same device session is deduplicated by
         the server's receipt. */
      this.#db
        .statement(
          `UPDATE outbox SET state='pending', lease_owner=NULL, lease_token=NULL,
             lease_expires_at=NULL, updated_at=?
           WHERE state='inflight' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        )
        .run(now, now);

      const blocking = BLOCKING_STATES.map((state) => `'${state}'`).join(',');
      const rows = this.#db
        .statement(
          `SELECT * FROM outbox o
            WHERE o.state='pending' AND o.next_attempt_at <= ?
              AND NOT EXISTS (
                SELECT 1 FROM outbox b
                 WHERE b.seq < o.seq
                   AND b.entity_type = o.entity_type
                   AND COALESCE(b.entity_id, b.client_entity_id, b.client_mutation_id)
                     = COALESCE(o.entity_id, o.client_entity_id, o.client_mutation_id)
                   AND b.state IN (${blocking})
              )
            ORDER BY o.seq
            LIMIT ?`,
        )
        .all(now, Math.max(1, Math.trunc(limit)));

      const claimed: OutboxEntry[] = [];
      const leaseToken = randomUUID();

      for (const row of rows) {
        const entry = rowToEntry(row);

        /*
         * The device-session hazard.
         *
         * The server's idempotency receipt is keyed on the device session, so an
         * entry queued under a previous session is not deduplicated. Conditional
         * operations are still safe — `baseRevision` makes them no-ops if they
         * already landed — but a create would insert a duplicate row.
         */
        if (
          entry.deviceSessionId !== currentDeviceSessionId &&
          !isSafeToReplayAcrossDeviceSessions(entry.operation)
        ) {
          this.#transition(entry.seq, 'conflicted', {
            lastErrorCode: 'device_session_changed',
            lastErrorMessage:
              'This change was queued under a previous sign-in. Sending it now could create a duplicate, so it needs confirmation.',
          });
          this.#recordConflict(entry, 'device_session_changed', null);
          continue;
        }

        this.#db
          .statement(
            `UPDATE outbox SET state='inflight', attempt_count = attempt_count + 1,
               lease_owner=?, lease_token=?, lease_expires_at=?, updated_at=?
             WHERE seq=? AND state='pending'`,
          )
          .run(currentDeviceSessionId, leaseToken, now + this.#leaseDurationMs, now, entry.seq);

        claimed.push({ ...entry, state: 'inflight', attemptCount: entry.attemptCount + 1 });
      }

      return claimed;
    });
  }

  /**
   * The body to POST for a claimed entry.
   *
   * Re-hashed and compared before it goes out. The stored hash is a *local*
   * integrity check — it is not, and cannot be, the server's `requestHash`,
   * which is computed over the server's own re-serialisation after Zod parsing
   * and so depends on that schema's key order. What this catches is the case
   * that matters locally: a body that changed between attempts, which would earn
   * a 409 `idempotency_key_reused` and confuse everyone.
   */
  requestBodyFor(entry: OutboxEntry): string {
    if (hashBody(entry.requestBody) !== entry.requestHash) {
      throw new OutboxError(
        'body_tampered',
        `Outbox entry ${entry.seq} no longer matches its hash; refusing to send it.`,
      );
    }
    return entry.requestBody;
  }

  /** The server accepted it. */
  markDone(seq: number, result: { serverRevision: number | null; raw: unknown }): void {
    this.#db.durableTransaction(() => {
      this.#transition(seq, 'done', {
        serverRevision: result.serverRevision,
        resultJson: JSON.stringify(result.raw ?? null),
      });
    });
  }

  /**
   * A retryable failure: schedule the next attempt, or dead-letter.
   *
   * Exponential backoff with full jitter. The jitter is not decoration — a
   * network partition ends for every queued mutation at the same instant, and
   * without it they would all retry in lockstep and do it again on the next
   * failure.
   */
  markRetryable(seq: number, errorCode: string, errorMessage: string): OutboxState {
    return this.#db.durableTransaction(() => {
      const entry = this.get(seq);
      if (!entry) throw new OutboxError('not_found', `Outbox entry ${seq} does not exist.`);

      if (entry.attemptCount >= this.#maxAttempts) {
        /* Dead-lettered, not dropped. It stays in the table, it is counted in
           `stats()`, and `listDeadLetters()` puts it in front of the user. A
           mutation that vanishes silently is a bug report nobody can file. */
        this.#transition(seq, 'dead', {
          lastErrorCode: errorCode,
          lastErrorMessage: errorMessage,
        });
        return 'dead';
      }

      const delay = this.backoffDelayMs(entry.attemptCount);
      this.#transition(seq, 'pending', {
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
        nextAttemptAt: this.#now() + delay,
      });
      return 'pending';
    });
  }

  /** A permanent refusal, or a lost optimistic-concurrency race. */
  markConflicted(
    seq: number,
    kind: 'revision_conflict' | 'rejected' | 'key_reused',
    options: { errorCode: string; errorMessage: string; serverRevision?: number | null } = {
      errorCode: 'conflict',
      errorMessage: 'The server refused this change.',
    },
  ): void {
    this.#db.durableTransaction(() => {
      const entry = this.get(seq);
      if (!entry) throw new OutboxError('not_found', `Outbox entry ${seq} does not exist.`);
      this.#transition(seq, 'conflicted', {
        lastErrorCode: options.errorCode,
        lastErrorMessage: options.errorMessage,
        serverRevision: options.serverRevision ?? null,
      });
      this.#recordConflict(entry, kind, options.serverRevision ?? null);
    });
  }

  /**
   * Re-base a conflicted mutation onto the revision the server now holds.
   *
   * This mints a **new** entry with a **new** `clientMutationId`, and marks the
   * old one `superseded`. Reusing the key would send the same identifier with a
   * different `baseRevision`, and the server compares a hash of the whole body:
   * that is 409 `idempotency_key_reused`, permanently. The new key is also
   * correct on the merits — a mutation composed against revision 7 is genuinely
   * a different intent from the same edit composed against revision 9.
   *
   * The new entry inherits the original's position in the queue only in the
   * sense that it is appended; per-entity ordering still holds because the
   * superseded row stops blocking once it leaves the blocking states.
   */
  rebase(seq: number, newBaseRevision: number, deviceSessionId: string): OutboxEntry {
    return this.#db.durableTransaction(() => {
      const entry = this.get(seq);
      if (!entry) throw new OutboxError('not_found', `Outbox entry ${seq} does not exist.`);
      if (entry.state !== 'conflicted' && entry.state !== 'dead') {
        throw new OutboxError(
          'invalid_state',
          `Only a conflicted or dead-lettered mutation can be re-based; entry ${seq} is ${entry.state}.`,
        );
      }

      const parsed = JSON.parse(entry.requestBody) as {
        operation: Record<string, unknown> & { type: string };
      };
      const { type, ...payload } = parsed.operation;

      this.#transition(seq, 'superseded', {});
      this.#resolveConflicts(seq, 'rebased');

      const draft: OutboxDraft = {
        entityType: entry.entityType,
        entityId: entry.entityId,
        ...(entry.clientEntityId === null ? {} : { clientEntityId: entry.clientEntityId }),
        operation: type,
        baseRevision: newBaseRevision,
        payload,
      };
      return this.enqueue(deviceSessionId, draft);
    });
  }

  /** Abandon a conflicted or dead entry at the user's request. */
  discard(seq: number, reason: string): void {
    this.#db.durableTransaction(() => {
      const entry = this.get(seq);
      if (!entry) throw new OutboxError('not_found', `Outbox entry ${seq} does not exist.`);
      if (TERMINAL_STATES.has(entry.state)) return;
      this.#transition(seq, 'superseded', { lastErrorMessage: reason });
      this.#resolveConflicts(seq, `discarded: ${reason}`);
    });
  }

  /**
   * Return entries stranded `inflight` by a crash to `pending`.
   *
   * Call once at startup, before the first drain. Replaying an entry whose
   * request may already have reached the server is exactly what the idempotency
   * key exists for: same key, same body, same device session ⇒ the server
   * returns the stored result rather than repeating the work.
   */
  recoverInflight(): number {
    return this.#db.durableTransaction(() => {
      const result = this.#db
        .statement(
          `UPDATE outbox SET state='pending', lease_owner=NULL, lease_token=NULL,
             lease_expires_at=NULL, updated_at=?
           WHERE state='inflight'`,
        )
        .run(this.#now());
      return Number(result.changes);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Backoff                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Full-jitter exponential backoff, exposed so it can be tested directly.
   *
   * `attempt` is the number of attempts already made.
   */
  backoffDelayMs(attempt: number): number {
    const exponential = Math.min(
      this.#maxBackoffMs,
      this.#initialBackoffMs * 2 ** Math.max(0, attempt),
    );
    return Math.round(exponential * (0.5 + this.#random() * 0.5));
  }

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  get(seq: number): OutboxEntry | undefined {
    const row = this.#db.statement('SELECT * FROM outbox WHERE seq = ?').get(seq);
    return row ? rowToEntry(row) : undefined;
  }

  /** Unacknowledged intent per entity — what the reducer needs to spot conflicts. */
  pendingByEntity(): Map<string, { seq: number; baseRevision: number; serverRevision: number | null }> {
    const rows = this.#db
      .statement(
        `SELECT seq, entity_type, entity_id, base_revision, server_revision
           FROM outbox
          WHERE state IN ('pending','inflight','conflicted','dead') AND entity_id IS NOT NULL
          ORDER BY seq`,
      )
      .all();

    const result = new Map<string, { seq: number; baseRevision: number; serverRevision: number | null }>();
    for (const row of rows) {
      const key = `${asString(row['entity_type'])}${asString(row['entity_id'])}`;
      /* Earliest unresolved intent wins: it is the one a conflict should name. */
      if (!result.has(key)) {
        result.set(key, {
          seq: asNumber(row['seq']),
          baseRevision: asNumber(row['base_revision']),
          serverRevision: asNullableNumber(row['server_revision']),
        });
      }
    }
    return result;
  }

  listDeadLetters(): OutboxEntry[] {
    return this.#db
      .statement(`SELECT * FROM outbox WHERE state='dead' ORDER BY seq`)
      .all()
      .map(rowToEntry);
  }

  listConflicted(): OutboxEntry[] {
    return this.#db
      .statement(`SELECT * FROM outbox WHERE state='conflicted' ORDER BY seq`)
      .all()
      .map(rowToEntry);
  }

  stats(): OutboxStats {
    const rows = this.#db.statement('SELECT state, COUNT(*) AS n FROM outbox GROUP BY state').all();
    const counts: Record<string, number> = {};
    for (const row of rows) counts[asString(row['state'])] = asNumber(row['n']);

    const oldest = this.#db
      .statement(`SELECT MIN(created_at) AS t FROM outbox WHERE state IN ('pending','inflight')`)
      .get();
    const oldestCreatedAt = oldest ? asNullableNumber(oldest['t']) : null;

    return {
      pending: counts['pending'] ?? 0,
      inflight: counts['inflight'] ?? 0,
      conflicted: counts['conflicted'] ?? 0,
      dead: counts['dead'] ?? 0,
      done: counts['done'] ?? 0,
      oldestPendingAgeMs: oldestCreatedAt === null ? null : Math.max(0, this.#now() - oldestCreatedAt),
    };
  }

  /**
   * Drop acknowledged entries older than `olderThanMs`.
   *
   * Not immediately after acknowledgement: a `done` row is the local proof that
   * a mutation already succeeded, and keeping it briefly means a confused replay
   * can be recognised rather than re-sent.
   */
  pruneCompleted(olderThanMs: number): number {
    return this.#db.durableTransaction(() => {
      const cutoff = this.#now() - Math.max(0, olderThanMs);
      const result = this.#db
        .statement(`DELETE FROM outbox WHERE state IN ('done','superseded') AND updated_at < ?`)
        .run(cutoff);
      return Number(result.changes);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  #transition(
    seq: number,
    state: OutboxState,
    fields: {
      lastErrorCode?: string | null;
      lastErrorMessage?: string | null;
      serverRevision?: number | null;
      nextAttemptAt?: number;
      resultJson?: string;
    },
  ): void {
    this.#db
      .statement(
        `UPDATE outbox SET
           state = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error_code = COALESCE(?, last_error_code),
           last_error_message = COALESCE(?, last_error_message),
           server_revision = COALESCE(?, server_revision),
           next_attempt_at = COALESCE(?, next_attempt_at),
           result_json = COALESCE(?, result_json),
           updated_at = ?
         WHERE seq = ?`,
      )
      .run(
        state,
        fields.lastErrorCode ?? null,
        fields.lastErrorMessage ?? null,
        fields.serverRevision ?? null,
        fields.nextAttemptAt ?? null,
        fields.resultJson ?? null,
        this.#now(),
        seq,
      );
  }

  #recordConflict(
    entry: OutboxEntry,
    kind: 'revision_conflict' | 'rejected' | 'key_reused' | 'device_session_changed',
    serverRevision: number | null,
  ): void {
    this.#db
      .statement(
        `INSERT INTO sync_conflicts
           (entity_key, entity_type, entity_id, outbox_seq, kind,
            local_revision, server_revision, local_payload, detected_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `${entry.entityType}${entry.entityId ?? entry.clientEntityId ?? entry.clientMutationId}`,
        entry.entityType,
        entry.entityId ?? entry.clientEntityId ?? '',
        entry.seq,
        kind,
        entry.baseRevision,
        serverRevision,
        /* The user's intent, kept verbatim. Nothing they typed is destroyed by a
           conflict; the UI can offer to reapply it. */
        entry.requestBody,
        this.#now(),
      );
  }

  #resolveConflicts(seq: number, resolution: string): void {
    this.#db
      .statement(
        `UPDATE sync_conflicts SET resolved_at = ?, resolution = ?
          WHERE outbox_seq = ? AND resolved_at IS NULL`,
      )
      .run(this.#now(), resolution, seq);
  }
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                 */
/* -------------------------------------------------------------------------- */

function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function asString(value: SqlValue | undefined): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function asNullableString(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: SqlValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function asNullableNumber(value: SqlValue | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function rowToEntry(row: SqlRow): OutboxEntry {
  return {
    seq: asNumber(row['seq']),
    clientMutationId: asString(row['client_mutation_id']),
    deviceSessionId: asString(row['device_session_id']),
    entityType: asString(row['entity_type']),
    entityId: asNullableString(row['entity_id']),
    clientEntityId: asNullableString(row['client_entity_id']),
    operation: asString(row['operation']),
    baseRevision: asNumber(row['base_revision']),
    requestBody: asString(row['request_body']),
    requestHash: asString(row['request_hash']),
    state: asString(row['state']) as OutboxState,
    attemptCount: asNumber(row['attempt_count']),
    nextAttemptAt: asNumber(row['next_attempt_at']),
    lastErrorCode: asNullableString(row['last_error_code']),
    lastErrorMessage: asNullableString(row['last_error_message']),
    serverRevision: asNullableNumber(row['server_revision']),
    createdAt: asNumber(row['created_at']),
    updatedAt: asNumber(row['updated_at']),
  };
}
