/**
 * Wire types for the Juno native sync contract (`/api/v1`).
 *
 * Every shape here was read off `contracts/openapi/juno-native-v1.yaml` (v1.3.0)
 * and cross-checked against the route handlers in `src/app/api/v1/**` and the
 * shared server libraries (`src/lib/sync-feed.ts`, `src/lib/sync-entities.ts`,
 * `src/lib/sync-entity-envelope.ts`, `src/lib/sync-protocol.ts`). Where the
 * contract prose and the implementation disagreed, the implementation won and
 * the difference is recorded in `docs/SYNC.md`.
 *
 * Nothing in this module performs I/O. It is the validation boundary: a network
 * payload becomes a typed value here, or it becomes an error here. No unparsed
 * response is ever allowed to reach SQLite.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Cursors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A change-feed cursor.
 *
 * The server's cursor is a Postgres `BIGSERIAL` id rendered as a decimal string
 * (`src/lib/sync-protocol.ts` → `parseCursor`, which accepts `0` or a 1–31 digit
 * number with no leading zero). It is emphatically *not* a JavaScript number:
 * `BIGSERIAL` exceeds `Number.MAX_SAFE_INTEGER`, so it is carried as a string
 * everywhere and compared with `BigInt`. Numeric gaps between consecutive
 * cursors are normal — the sequence is global, not per-account.
 */
export type ChangeCursor = string;

const CURSOR_PATTERN = /^(0|[1-9][0-9]{0,30})$/;

export const cursorSchema = z.string().regex(CURSOR_PATTERN, 'invalid_cursor');

export function isChangeCursor(value: string): value is ChangeCursor {
  return CURSOR_PATTERN.test(value);
}

/** Ordering over cursors. Never use string or number comparison for these. */
export function compareCursors(a: ChangeCursor, b: ChangeCursor): -1 | 0 | 1 {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The keyset cursor for `/entities/index` is opaque base64url, not numeric. */
export const entityIndexCursorSchema = z.string().min(1).max(600).regex(/^[A-Za-z0-9_-]+$/);

/* -------------------------------------------------------------------------- */
/* Entity types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The 22 entity types the server's change feed emits and `/entities` hydrates.
 *
 * These strings are the `TG_ARGV[0]` names written by the Postgres change-capture
 * triggers, mirrored by the `loaders` map in `src/lib/sync-entities.ts`. They are
 * a closed set: `/entities?type=` rejects anything else with 400. An unknown type
 * arriving from `/changes` therefore means the server is newer than this client,
 * which is a condition to report, not to guess at.
 */
export const SYNC_ENTITY_TYPES = [
  'profile',
  'settings',
  'subscription',
  'folder',
  'conversation',
  'message',
  'message_version',
  'attachment',
  'artifact',
  'artifact_version',
  'project',
  'memory',
  'saved_prompt',
  'connection',
  'usage',
  'share',
  'announcement_dismissal',
  'scheduled_task',
  'code_device',
  'code_task',
  'code_task_event',
  'code_workspace',
  // `project_workspace` was missing here while the Swift client
  // (`NativeSyncAPIClient.entityTypes`) already carried it, so the two clients
  // disagreed about the closed set they are both supposed to mirror. Harmless
  // only because nothing writes that table yet — which is exactly the window in
  // which to fix it.
  'project_workspace',
  // Juno Work. These ship AHEAD of the triggers that emit them.
  //
  // Unlike `project_workspace`, every Work table already holds rows on live
  // accounts, so the first Work write after
  // `prisma/migrations/20260815141000_work_change_capture_triggers` is applied
  // emits a type older builds do not know. Per the note above, an unknown type
  // is "a condition to report, not to guess at" — which in practice ends that
  // account's sync on that install until it updates. This list must therefore
  // be the oldest build in the field before that migration is applied; shipping
  // the strings is necessary and not sufficient.
  //
  // The twelve match the trigger argument in the migration and the loader keys in
  // `src/lib/sync-entities.ts`. Four Work models are deliberately absent,
  // matching the loader file: WorkEvent (its own SSE transport), WorkCommand
  // (relay control plane — a replayed command is an action taken twice),
  // WorkRunIO (provenance meaningful only beside its artifact version) and
  // WorkAuditEvent (the security log, which outlives its session).
  'work_session',
  'work_run',
  'work_approval',
  'work_artifact',
  'work_artifact_version',
  'work_host',
  'work_file_grant',
  'work_session_connector',
  'work_skill',
  'work_skill_version',
  'work_schedule',
  'work_trigger',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

const SYNC_ENTITY_TYPE_SET: ReadonlySet<string> = new Set<string>(SYNC_ENTITY_TYPES);

export function isSyncEntityType(value: string): value is SyncEntityType {
  return SYNC_ENTITY_TYPE_SET.has(value);
}

/** Maximum ids per `/entities` request, enforced server-side (`MAX_ENTITY_IDS`). */
export const MAX_ENTITY_IDS_PER_REQUEST = 100;

/** Maximum page size accepted by `/changes` (`MAX_CHANGE_PAGE_SIZE`). */
export const MAX_CHANGE_PAGE_SIZE = 500;

/** Maximum page size accepted by `/entities/index` (`MAX_ENTITY_INDEX_LIMIT`). */
export const MAX_ENTITY_INDEX_LIMIT = 500;

/**
 * A `(type, id)` pair flattened into one string so it can key a `Map` and a
 * SQLite primary key identically. Unit separator (U+001F) cannot occur in a
 * cuid/uuid entity id or in a type name, so the encoding is unambiguous.
 */
export type EntityKey = string;

export const ENTITY_KEY_SEPARATOR = '';

export function entityKey(type: string, id: string): EntityKey {
  return `${type}${ENTITY_KEY_SEPARATOR}${id}`;
}

/* -------------------------------------------------------------------------- */
/* Error envelope                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The typed `/api/v1` error envelope. Legacy `/api` routes use a different,
 * looser shape (`GeneralRouteErrorEnvelope`); this client only speaks to the
 * `/api/v1` surface, where the typed envelope is guaranteed.
 */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    retryable: z.boolean().optional(),
    retryAfterMs: z.number().int().nullable().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/* -------------------------------------------------------------------------- */
/* /bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Only the synchronisation baseline is modelled strictly.
 *
 * `/bootstrap` also returns profile, subscription, usage, settings, feature
 * flags and announcements, but every one of those is *also* delivered as a
 * change-feed entity, so treating the bootstrap copy as authoritative would
 * create a second write path into the mirror for no benefit. The extra keys are
 * preserved (`looseObject`) rather than stripped so a diagnostics dump can show
 * what the server actually sent.
 */
export const bootstrapResponseSchema = z.looseObject({
  currentChangeCursor: cursorSchema,
  compactionFloorCursor: cursorSchema,
  modelManifestVersion: z.string().optional(),
  contractVersion: z.string().optional(),
});

export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

/* -------------------------------------------------------------------------- */
/* /changes                                                                    */
/* -------------------------------------------------------------------------- */

export const changeOperationSchema = z.enum(['upsert', 'delete']);
export type ChangeOperation = z.infer<typeof changeOperationSchema>;

export const accountChangeSchema = z.object({
  cursor: cursorSchema,
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  parentEntityId: z.string().nullable(),
  revision: z.number().int().min(1),
  operation: changeOperationSchema,
  changedAt: z.string(),
});

export type AccountChange = z.infer<typeof accountChangeSchema>;

export const changesResponseSchema = z
  .object({
    after: cursorSchema,
    changes: z.array(accountChangeSchema),
    nextCursor: cursorSchema,
    compactionFloorCursor: cursorSchema,
    hasMore: z.boolean(),
  })
  .refine(
    (page) =>
      page.changes.every(
        (change, index) =>
          compareCursors(change.cursor, page.after) > 0 &&
          (index === 0 ||
            compareCursors(change.cursor, page.changes[index - 1]!.cursor) > 0),
      ),
    { message: 'change_page_not_strictly_ascending' },
  )
  .refine(
    (page) =>
      page.changes.length === 0
        ? page.nextCursor === page.after
        : page.nextCursor === page.changes[page.changes.length - 1]!.cursor,
    { message: 'change_page_next_cursor_mismatch' },
  );

export type ChangesResponse = z.infer<typeof changesResponseSchema>;

/* -------------------------------------------------------------------------- */
/* /entities                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A hydrated entity.
 *
 * The server guarantees `data === null` **if and only if** `deletedAt !== null`
 * — see the long comment on `buildEntityEnvelopes` in
 * `src/lib/sync-entity-envelope.ts`, which exists because a release-blocking bug
 * once produced `{data: null, deletedAt: null}` for artifacts cascade-deleted by
 * Postgres. The refinement below is that invariant, enforced client-side: an
 * envelope that is neither live nor tombstoned is rejected rather than written.
 *
 * Note `revision` may be `0` here (entities that predate change capture), while
 * a `/changes` revision is always `>= 1`.
 */
export const entityEnvelopeSchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1),
    revision: z.number().int().min(0),
    deletedAt: z.string().nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
  })
  .refine((entity) => (entity.data === null) === (entity.deletedAt !== null), {
    message: 'entity_envelope_neither_live_nor_tombstoned',
  });

export type EntityEnvelope = z.infer<typeof entityEnvelopeSchema>;

export const entitiesResponseSchema = z.object({
  entities: z.array(entityEnvelopeSchema),
});

export type EntitiesResponse = z.infer<typeof entitiesResponseSchema>;

/* -------------------------------------------------------------------------- */
/* /entities/index                                                             */
/* -------------------------------------------------------------------------- */

export const entityIndexItemSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  revision: z.number().int().min(0),
});

export type EntityIndexItem = z.infer<typeof entityIndexItemSchema>;

export const entityIndexResponseSchema = z.object({
  items: z.array(entityIndexItemSchema),
  nextAfter: entityIndexCursorSchema.nullable(),
  hasMore: z.boolean(),
});

export type EntityIndexResponse = z.infer<typeof entityIndexResponseSchema>;

/* -------------------------------------------------------------------------- */
/* /mutations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The mutation operation union the server actually implements.
 *
 * Taken from `mutationRequestSchema` in `src/lib/sync-mutations.ts` and the
 * `switch` in `src/app/api/v1/mutations/route.ts`. Only five entity families are
 * mutable through this endpoint: conversation, folder, project, memory and
 * settings. Everything else in `SYNC_ENTITY_TYPES` is read-only to a native
 * client — see the API gaps section of `docs/SYNC.md`.
 */
export const MUTATION_OPERATION_TYPES = [
  'conversation.create',
  'conversation.rename',
  'conversation.update',
  'conversation.archive',
  'conversation.delete',
  'folder.create',
  'folder.rename',
  'folder.delete',
  'project.create',
  'project.update',
  'project.delete',
  'memory.create',
  'memory.update',
  'memory.delete',
  'settings.update',
] as const;

export type MutationOperationType = (typeof MUTATION_OPERATION_TYPES)[number];

const MUTATION_OPERATION_TYPE_SET: ReadonlySet<string> = new Set<string>(
  MUTATION_OPERATION_TYPES,
);

export function isMutationOperationType(value: string): value is MutationOperationType {
  return MUTATION_OPERATION_TYPE_SET.has(value);
}

/**
 * The `operation` object of a mutation request: a `type` discriminator plus
 * operation-specific fields. Deliberately loose about the payload — the server
 * owns that schema and rejects malformed operations with a typed 400, and
 * duplicating a 15-arm union here would mean this client silently blocks
 * operations the server has already learned.
 */
export const mutationOperationSchema = z.looseObject({
  type: z.string().refine(isMutationOperationType, 'unknown_mutation_operation'),
});

export type MutationOperation = z.infer<typeof mutationOperationSchema>;

/**
 * `POST /mutations` returns `{entity: {id, revision, deleted?}, entityMappings?}`
 * for every implemented operation, but the contract types the 200 body as a free
 * object. The strict-ish shape below is what the route actually returns; parsing
 * it is what lets the outbox rewrite an optimistic client id to a server id.
 */
export const mutationResultSchema = z.looseObject({
  entity: z.object({
    id: z.string().min(1).max(200),
    revision: z.number().int().min(0),
    deleted: z.boolean().optional(),
  }),
  entityMappings: z.record(z.string(), z.string()).optional(),
});

export type MutationResult = z.infer<typeof mutationResultSchema>;

/* -------------------------------------------------------------------------- */
/* /changes/stream (SSE wakeups)                                               */
/* -------------------------------------------------------------------------- */

/**
 * A frame from the realtime stream.
 *
 * VERIFIED AGAINST THE IMPLEMENTATION: `accountChangeStreamResponse` in
 * `src/lib/sync-feed.ts` emits exactly three named events — `ready {after}`,
 * `cursor {cursor}` and `done {}` — plus `: ping` heartbeat comments. A `cursor`
 * frame carries **a cursor and nothing else**: no entity id, no revision, no
 * payload. The stream is a doorbell, not a delivery. There is no shape of this
 * type that could be mistaken for canonical data, which is deliberate.
 */
export type ChangeWakeup =
  | { readonly kind: 'ready'; readonly after: ChangeCursor }
  | { readonly kind: 'cursor'; readonly cursor: ChangeCursor }
  | { readonly kind: 'done' };

export const readyEventSchema = z.object({ after: cursorSchema });
export const cursorEventSchema = z.object({ cursor: cursorSchema });

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SyncErrorCode =
  /** Transport failed, or the server answered 5xx/429. Retry with backoff. */
  | 'transport'
  /** 401: the access token is missing, expired or revoked. */
  | 'unauthorized'
  /** 410 `cursor_compacted`: the stored cursor predates the compaction floor. */
  | 'cursor_compacted'
  /** 409 `revision_conflict`: optimistic concurrency lost. */
  | 'revision_conflict'
  /** 409 `idempotency_key_reused`: same key, different body. Never retry. */
  | 'idempotency_key_reused'
  /** 409 `suppressed_by_memory`: the account asked Juno to forget this. Drop. */
  | 'suppressed_by_memory'
  /** The response did not match the contract. Never retried blindly. */
  | 'malformed_response'
  /** 4xx that is neither of the above. Not retryable. */
  | 'rejected';

/**
 * A sync failure carrying just enough structure to decide retry policy.
 *
 * `requestId` is the server's `X-Juno-Request-Id`, which is safe to log and is
 * the only handle support has on a failed call. The access token is never a
 * field on this type, and `SyncError` is the only error shape that crosses the
 * IPC boundary toward the renderer.
 */
export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly status: number | undefined;
  readonly serverCode: string | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: SyncErrorCode,
    message: string,
    /* Explicit `| undefined` on every member: under
       `exactOptionalPropertyTypes` an optional property does not accept an
       explicit `undefined`, and every one of these is built by spreading a
       header lookup that legitimately returns nothing. */
    options: {
      status?: number | undefined;
      serverCode?: string | undefined;
      requestId?: string | undefined;
      retryable?: boolean | undefined;
      retryAfterMs?: number | undefined;
      details?: Record<string, unknown> | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SyncError';
    this.code = code;
    this.status = options.status;
    this.serverCode = options.serverCode;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }

  /** A renderer-safe projection. Contains no credential material by construction. */
  toDiagnostic(): {
    code: SyncErrorCode;
    message: string;
    status: number | undefined;
    serverCode: string | undefined;
    requestId: string | undefined;
    retryable: boolean;
  } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      serverCode: this.serverCode,
      requestId: this.requestId,
      retryable: this.retryable,
    };
  }
}

function defaultRetryable(code: SyncErrorCode): boolean {
  return code === 'transport';
}
