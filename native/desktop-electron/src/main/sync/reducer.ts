/**
 * The pure half of sync.
 *
 * `reduceChangePage` takes a validated change page, the entities that page
 * referred to (already hydrated from `/entities`), and a snapshot of the local
 * rows those entities would touch — and returns a *plan*: the writes to perform,
 * the conflicts to surface, and the cursor to advance to. It performs no I/O,
 * opens no transaction, and holds no clock. That is what makes the interesting
 * cases — out-of-order pages, duplicate delivery, tombstones, a server write
 * racing an unsent local edit — testable as data, without a database or a
 * network.
 *
 * The caller applies the whole plan in one transaction. Nothing here decides
 * *when* to write; it decides *what* is correct to write.
 */

import {
  type AccountChange,
  type ChangeCursor,
  type ChangesResponse,
  compareCursors,
  type EntityEnvelope,
  type EntityKey,
  entityKey,
  isSyncEntityType,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the local database currently holds for one entity.
 *
 * `pendingMutation` is the interesting field. It is set when the outbox holds an
 * unacknowledged mutation for this entity — i.e. the user changed something and
 * the server has not confirmed it yet. `acknowledgedRevision` is filled in once
 * `POST /mutations` returned, and is the revision the server said the mutation
 * produced; until then it is null.
 */
export interface LocalEntityState {
  readonly revision: number;
  readonly deleted: boolean;
  readonly pendingMutation: PendingMutationRef | null;
}

export interface PendingMutationRef {
  /** `outbox.seq` — stable, monotonic, and what a conflict row points at. */
  readonly seq: number;
  /** The revision the mutation was composed against. */
  readonly baseRevision: number;
  /** The revision the server reported, once the mutation has been accepted. */
  readonly acknowledgedRevision: number | null;
}

export interface ReduceChangePageInput {
  /** The cursor already committed locally. `null` on a database with no baseline. */
  readonly storedCursor: ChangeCursor | null;
  /** A page from `GET /changes`, already schema-validated. */
  readonly page: ChangesResponse;
  /** The envelopes from `GET /entities` for the ids this page names. */
  readonly hydrated: readonly EntityEnvelope[];
  /** Local rows for the keys this page touches. Missing key ⇒ not stored yet. */
  readonly local: ReadonlyMap<EntityKey, LocalEntityState>;
}

/* -------------------------------------------------------------------------- */
/* Outputs                                                                     */
/* -------------------------------------------------------------------------- */

export type EntityWrite =
  | {
      readonly kind: 'upsert';
      readonly entityKey: EntityKey;
      readonly entityType: string;
      readonly entityId: string;
      readonly revision: number;
      readonly updatedAt: string | null;
      /** The hydrated `data` object. The caller serialises it. */
      readonly data: Readonly<Record<string, unknown>>;
      readonly sourceCursor: ChangeCursor;
      /** Clear the pending marker: this write is our own mutation echoing back. */
      readonly clearsPendingMutation: boolean;
    }
  | {
      readonly kind: 'tombstone';
      readonly entityKey: EntityKey;
      readonly entityType: string;
      readonly entityId: string;
      readonly revision: number;
      readonly deletedAt: string;
      readonly sourceCursor: ChangeCursor;
      readonly clearsPendingMutation: boolean;
    };

export type ConflictKind = 'revision_conflict' | 'server_deleted';

export interface ReducedConflict {
  readonly entityKey: EntityKey;
  readonly entityType: string;
  readonly entityId: string;
  readonly kind: ConflictKind;
  /** The outbox entry whose intent this conflicts with. */
  readonly outboxSeq: number;
  readonly localRevision: number;
  readonly serverRevision: number;
}

export type ReduceDisposition =
  /** The page moved the cursor forward and produced writes. */
  | 'applied'
  /** This exact page was already committed; a duplicate delivery. */
  | 'already-applied'
  /** The server reported no changes after our cursor. Nothing to write. */
  | 'up-to-date';

export interface ReducePlan {
  readonly disposition: ReduceDisposition;
  /** The cursor to commit alongside `writes`, in the same transaction. */
  readonly nextCursor: ChangeCursor;
  readonly compactionFloorCursor: ChangeCursor;
  readonly hasMore: boolean;
  readonly writes: readonly EntityWrite[];
  readonly conflicts: readonly ReducedConflict[];
  /** Changes deliberately not written: stale, duplicate, or already current. */
  readonly ignoredCount: number;
  /**
   * Entity types this build does not know. Recorded rather than fatal: a server
   * ahead of the client must not brick it. They cannot be hydrated (`/entities`
   * 400s on an unknown type), so they are skipped and reported — a client that
   * sees these needs a re-bootstrap after it is updated.
   */
  readonly unknownEntityTypes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ReducerErrorCode =
  /** The page does not start where the local cursor ended. */
  | 'cursor_gap'
  /** The page claims to advance but does not. */
  | 'non_advancing_cursor'
  /** `/changes` named an entity that `/entities` did not return. */
  | 'missing_entity'
  /** `/entities` returned an older revision than `/changes` advertised. */
  | 'stale_hydration'
  /** `/entities` returned something nobody asked for. */
  | 'unexpected_entity';

export class ReducerError extends Error {
  readonly code: ReducerErrorCode;
  readonly context: Readonly<Record<string, string | number>>;

  constructor(
    code: ReducerErrorCode,
    message: string,
    context: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = 'ReducerError';
    this.code = code;
    this.context = context;
  }
}

/* -------------------------------------------------------------------------- */
/* The reducer                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Reduce one change page to a write plan.
 *
 * ## Conflict policy, stated exactly
 *
 * The server is authoritative for entity *content*: the mirror always ends up
 * holding what `/entities` returned. What the reducer refuses to do is discard
 * the *user's intent* silently. When a page carries a server revision for an
 * entity that has an unacknowledged outbox mutation against it, and that
 * revision is not the echo of our own mutation, the reducer emits a
 * `ReducedConflict` alongside the write. The caller uses it to quarantine the
 * outbox entry (`conflicted`) and surface it. The user's text is never
 * destroyed — it is still sitting in `outbox.request_body`, which is why
 * `sync_conflicts.local_payload` can offer to reapply it.
 *
 * Anything else would be one of the two bad options: overwrite the local edit
 * and lose it, or hold the server's state back and let the mirror lie.
 */
export function reduceChangePage(input: ReduceChangePageInput): ReducePlan {
  const { page, storedCursor, local } = input;

  /* --- Duplicate delivery -------------------------------------------------
     The same page can arrive twice: a wakeup fires while a fetch is already in
     flight, or a retry re-sends a request whose response we already committed.
     Recognising it by the committed cursor makes apply idempotent without
     needing to compare row contents. */
  if (storedCursor !== null && page.nextCursor === storedCursor) {
    return {
      disposition: 'already-applied',
      nextCursor: storedCursor,
      compactionFloorCursor: page.compactionFloorCursor,
      hasMore: page.hasMore,
      writes: [],
      conflicts: [],
      ignoredCount: page.changes.length,
      unknownEntityTypes: [],
    };
  }

  /* --- Out-of-order pages -------------------------------------------------
     A page is only meaningful when it continues from exactly the cursor we hold.
     Applying a page that starts later would skip changes; applying one that
     starts earlier would replay changes we may have already collapsed. Either
     way the correct move is to refuse and refetch from the stored cursor, which
     is why this is an error and not a silent repair. */
  if (storedCursor !== null && page.after !== storedCursor) {
    throw new ReducerError(
      'cursor_gap',
      `The change page starts at ${page.after} but the local cursor is ${storedCursor}.`,
      { expected: storedCursor, received: page.after },
    );
  }

  /* --- Caught up ----------------------------------------------------------
     `listAccountChanges` sets nextCursor = after when there is nothing past the
     cursor. That is a legitimate "you are current" answer, not a stalled page —
     it still carries a fresh compaction floor worth persisting. */
  if (page.changes.length === 0 && page.nextCursor === page.after) {
    return {
      disposition: 'up-to-date',
      nextCursor: page.nextCursor,
      compactionFloorCursor: page.compactionFloorCursor,
      hasMore: page.hasMore,
      writes: [],
      conflicts: [],
      ignoredCount: 0,
      unknownEntityTypes: [],
    };
  }

  if (compareCursors(page.nextCursor, page.after) <= 0) {
    throw new ReducerError(
      'non_advancing_cursor',
      `The change page carries ${page.changes.length} changes but does not advance past ${page.after}.`,
      { after: page.after, nextCursor: page.nextCursor },
    );
  }

  /* --- Collapse ----------------------------------------------------------- */
  const { collapsed, unknownEntityTypes } = collapseChanges(page.changes);

  /* --- Index the hydrated envelopes --------------------------------------- */
  const envelopes = new Map<EntityKey, EntityEnvelope>();
  for (const envelope of input.hydrated) {
    const key = entityKey(envelope.type, envelope.id);
    if (!collapsed.has(key)) {
      throw new ReducerError(
        'unexpected_entity',
        `Hydration returned ${envelope.type}/${envelope.id}, which this page did not name.`,
        { type: envelope.type, id: envelope.id },
      );
    }
    const previous = envelopes.get(key);
    /* A duplicate id in one hydration batch is server-side nonsense, but if it
       happens the newest revision is the only defensible pick. */
    if (!previous || envelope.revision > previous.revision) envelopes.set(key, envelope);
  }

  const writes: EntityWrite[] = [];
  const conflicts: ReducedConflict[] = [];
  let ignoredCount = page.changes.length - collapsed.size;

  for (const [key, change] of collapsed) {
    const envelope = envelopes.get(key);
    const existing = local.get(key);

    /* --- Hydration gaps -------------------------------------------------- */
    if (!envelope) {
      if (change.operation === 'delete') {
        /* `/entities` omits ids it cannot resolve at all. For a delete that is
           unambiguous — the row is gone — and treating it as a tombstone loses
           nothing. Doing otherwise would wedge the cursor behind a deletion the
           server can no longer describe. */
        writes.push(
          tombstoneWrite(change, change.changedAt, existing, /* revision */ change.revision),
        );
        continue;
      }
      /* For an upsert it is not recoverable: we would be advancing the cursor
         past a change whose content we never received. */
      throw new ReducerError(
        'missing_entity',
        `Hydration omitted ${change.entityType}/${change.entityId}, which the change feed reported as an upsert.`,
        { type: change.entityType, id: change.entityId, cursor: change.cursor },
      );
    }

    /* --- Stale hydration -------------------------------------------------
       `/changes` and `/entities` are separate reads. If the entity read came
       from a replica behind the feed, the envelope can be older than the change
       that pointed at it. Writing it would pin the mirror to stale content while
       advancing the cursor past the change that would have fixed it. */
    if (envelope.revision < change.revision) {
      throw new ReducerError(
        'stale_hydration',
        `Hydration returned revision ${envelope.revision} for ${change.entityType}/${change.entityId}, but the change feed reported ${change.revision}.`,
        {
          type: change.entityType,
          id: change.entityId,
          expected: change.revision,
          received: envelope.revision,
        },
      );
    }

    /* --- Already current -------------------------------------------------
       Revisions are monotonic per entity, so a revision at or below what we hold
       carries nothing new. This is what makes replaying a page a no-op and what
       absorbs a page that overlaps one already applied. The one exception is a
       row we hold optimistically: `existing.revision` there may be a local guess
       rather than a server fact, so it is not allowed to suppress a server write.
    */
    const pending = existing?.pendingMutation ?? null;
    if (existing && pending === null && envelope.revision <= existing.revision) {
      const tombstoneFlips = existing.deleted !== (envelope.deletedAt !== null);
      if (!tombstoneFlips) {
        ignoredCount += 1;
        continue;
      }
    }

    /* --- Conflict detection ---------------------------------------------- */
    let clearsPending = false;
    if (pending !== null) {
      const isOurOwnEcho =
        pending.acknowledgedRevision !== null && envelope.revision <= pending.acknowledgedRevision;

      if (isOurOwnEcho) {
        /* The server confirmed this mutation and the feed is now delivering the
           canonical result. Apply it and drop the optimistic marker. */
        clearsPending = true;
      } else {
        conflicts.push({
          entityKey: key,
          entityType: change.entityType,
          entityId: change.entityId,
          kind: envelope.deletedAt !== null ? 'server_deleted' : 'revision_conflict',
          outboxSeq: pending.seq,
          localRevision: pending.baseRevision,
          serverRevision: envelope.revision,
        });
        /* The marker stays set. The caller quarantines the outbox entry, and the
           entity remains flagged until the user resolves it. */
      }
    }

    if (envelope.deletedAt !== null || envelope.data === null) {
      /* The schema refinement in `types.ts` guarantees these two agree; the
         second half of the condition is here so the narrowing is total rather
         than trusting a refinement at a distance. */
      writes.push({
        kind: 'tombstone',
        entityKey: key,
        entityType: change.entityType,
        entityId: change.entityId,
        revision: envelope.revision,
        deletedAt: envelope.deletedAt ?? change.changedAt,
        sourceCursor: change.cursor,
        clearsPendingMutation: clearsPending,
      });
    } else {
      writes.push({
        kind: 'upsert',
        entityKey: key,
        entityType: change.entityType,
        entityId: change.entityId,
        revision: envelope.revision,
        updatedAt: readTimestamp(envelope.data) ?? change.changedAt,
        data: envelope.data,
        sourceCursor: change.cursor,
        clearsPendingMutation: clearsPending,
      });
    }
  }

  return {
    disposition: 'applied',
    nextCursor: page.nextCursor,
    compactionFloorCursor: page.compactionFloorCursor,
    hasMore: page.hasMore,
    writes,
    conflicts,
    ignoredCount,
    unknownEntityTypes,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One change per entity, keeping the newest.
 *
 * A page routinely contains several changes for the same entity — rename, then
 * move, then archive. Only the final state matters, and hydration returns
 * current state anyway, so fetching and writing the intermediate revisions would
 * be pure waste. Insertion order is preserved so the write plan is deterministic
 * and therefore diffable in tests.
 */
function collapseChanges(changes: readonly AccountChange[]): {
  collapsed: Map<EntityKey, AccountChange>;
  unknownEntityTypes: string[];
} {
  const collapsed = new Map<EntityKey, AccountChange>();
  const unknown = new Set<string>();

  for (const change of changes) {
    if (!isSyncEntityType(change.entityType)) {
      unknown.add(change.entityType);
      continue;
    }
    const key = entityKey(change.entityType, change.entityId);
    const previous = collapsed.get(key);
    if (
      !previous ||
      change.revision > previous.revision ||
      (change.revision === previous.revision && compareCursors(change.cursor, previous.cursor) > 0)
    ) {
      collapsed.set(key, change);
    }
  }

  return { collapsed, unknownEntityTypes: [...unknown] };
}

function tombstoneWrite(
  change: AccountChange,
  deletedAt: string,
  existing: LocalEntityState | undefined,
  revision: number,
): EntityWrite {
  const pending = existing?.pendingMutation ?? null;
  const clears =
    pending !== null &&
    pending.acknowledgedRevision !== null &&
    revision <= pending.acknowledgedRevision;
  return {
    kind: 'tombstone',
    entityKey: entityKey(change.entityType, change.entityId),
    entityType: change.entityType,
    entityId: change.entityId,
    revision,
    deletedAt,
    sourceCursor: change.cursor,
    clearsPendingMutation: clears,
  };
}

/**
 * The entity's own `updatedAt`, if it has one.
 *
 * 46 of the server's 85 models have no `updatedAt` at all, so this is genuinely
 * optional and the caller falls back to the change's `changedAt`. The value is
 * passed through as the exact string the server sent — never re-parsed and
 * re-formatted, so that two hydrations of an unchanged entity stay identical.
 */
function readTimestamp(data: Readonly<Record<string, unknown>>): string | null {
  const value = data['updatedAt'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/* -------------------------------------------------------------------------- */
/* Entity-id extraction for hydration                                          */
/* -------------------------------------------------------------------------- */

export interface HydrationRequest {
  readonly entityType: string;
  readonly ids: readonly string[];
}

/**
 * The `/entities` calls a page requires: one batch per type, at most
 * `maxIdsPerBatch` ids each (the server rejects more than 100).
 *
 * Pure, and therefore the one place the batching rule is tested rather than
 * hoped for. Types are emitted in a stable order so a failed sync retries the
 * same request sequence — which matters when debugging against server logs.
 */
export function hydrationRequestsForPage(
  changes: readonly AccountChange[],
  maxIdsPerBatch: number,
): readonly HydrationRequest[] {
  const byType = new Map<string, Set<string>>();
  for (const change of changes) {
    if (!isSyncEntityType(change.entityType)) continue;
    let ids = byType.get(change.entityType);
    if (!ids) {
      ids = new Set<string>();
      byType.set(change.entityType, ids);
    }
    ids.add(change.entityId);
  }

  const batchSize = Math.max(1, Math.trunc(maxIdsPerBatch));
  const requests: HydrationRequest[] = [];
  for (const entityType of [...byType.keys()].sort()) {
    const ids = [...byType.get(entityType)!].sort();
    for (let index = 0; index < ids.length; index += batchSize) {
      requests.push({ entityType, ids: ids.slice(index, index + batchSize) });
    }
  }
  return requests;
}
