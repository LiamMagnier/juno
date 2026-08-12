/**
 * Versioned, forward-only schema migrations.
 *
 * The version lives in SQLite's own `user_version` header field. It is
 * transactional (it sits in the database header, written under the same commit
 * as the DDL beside it), it needs no table of its own, and it cannot drift from
 * the file the way a `schema_migrations` row can when someone restores a
 * database from a backup taken mid-migration.
 *
 * Rules this module enforces:
 *
 *  - **Forward only.** A database from a newer build is not downgraded, it is
 *    refused. Silently running an old binary against a new schema is how you get
 *    a client writing rows the new code will later misread.
 *  - **One transaction per migration.** Each step commits on its own so a
 *    failure at step 4 leaves a valid database at version 3 rather than a
 *    half-applied version 4.
 *  - **Append only.** Never edit a shipped migration; add the next number. The
 *    array index is the contract.
 *
 * ## Schema shape, and why it is what it is
 *
 * The authoritative table is `entities` — a direct mirror of the server's
 * hydration envelope (`type`, `id`, `revision`, `deletedAt`, `data`). That is
 * not laziness: on the server, revisions and tombstones do not live on the
 * domain rows at all. They live in a single `EntityRevision` side table written
 * by Postgres triggers, and 46 of the 85 domain models do not even carry an
 * `updatedAt`. There is therefore no per-table watermark to sync against, and
 * the cursor feed is the only correct mechanism. Mirroring the envelope keeps
 * the client's model identical to the server's.
 *
 * The typed tables (`conversations`, `messages`, ...) are **projections**:
 * derived, indexed views of the same rows, written in the same transaction and
 * rebuildable from `entities` alone. They exist so the UI can `ORDER BY
 * last_message_at` without deserialising every JSON blob. `entities` is the
 * source of truth; a projection is a cache with a foreign key.
 */

import type { SqlDatabase } from './database.js';

/* -------------------------------------------------------------------------- */
/* Migration table                                                             */
/* -------------------------------------------------------------------------- */

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

/**
 * Migration 1 — initial schema.
 *
 * Note what is TEXT and what is INTEGER:
 *
 *  - Change cursors are TEXT. They are Postgres `BIGSERIAL` values and routinely
 *    exceed `Number.MAX_SAFE_INTEGER`; `node:sqlite` throws `ERR_OUT_OF_RANGE`
 *    when reading such an INTEGER unless BigInt mode is on for that statement.
 *    Storing them as decimal strings makes every read total, and comparison is
 *    done with `BigInt` in `sync/types.ts`, never with `<` on the string.
 *  - Timestamps from the server are kept as the ISO-8601 strings the server
 *    sent, byte for byte. Re-parsing and re-serialising a timestamp is a way to
 *    make two hydrations of an unchanged entity differ, which would defeat the
 *    "did this actually change" comparisons.
 *  - Local clock timestamps (outbox scheduling) are INTEGER epoch milliseconds,
 *    because they are compared and sorted locally and never leave the machine.
 */
const MIGRATION_001_INITIAL: Migration = {
  version: 1,
  name: 'initial_schema',
  up: `
    /* ---------------------------------------------------------------- */
    /* Sync state: cursor, compaction floor, bootstrap bookkeeping.      */
    /* A key/value table rather than a one-row table with columns, so    */
    /* adding a new piece of sync bookkeeping is not a migration.        */
    /* ---------------------------------------------------------------- */
    CREATE TABLE sync_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;

    /* ---------------------------------------------------------------- */
    /* The entity mirror. One row per (type, id) the account can see.    */
    /* ---------------------------------------------------------------- */
    CREATE TABLE entities (
      /* type || U+001F || id. A single-column key so projection tables can
         carry a real foreign key to it; SQLite cannot express a composite
         foreign key with a constant on one side. */
      entity_key   TEXT PRIMARY KEY,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,

      /* Server revision. 0 is legitimate: entities that predate change
         capture hydrate at revision 0, while /changes always reports >= 1. */
      revision     INTEGER NOT NULL,

      /* Tombstone. NULL for live entities. The server guarantees
         data IS NULL if and only if deleted_at IS NOT NULL, and the CHECK
         below refuses to store an envelope that broke that invariant. */
      deleted_at   TEXT,

      /* The server's own updatedAt/changedAt for this entity, as sent. */
      updated_at   TEXT,

      /* The hydrated 'data' object, verbatim JSON. NULL for tombstones. */
      data         TEXT,

      /* The cursor of the change page that last wrote this row. Diagnostic:
         it answers "how did this row get here" without a second table. */
      source_cursor TEXT,

      /* Set while an outbox mutation for this entity is still unacknowledged,
         so the reducer can tell an optimistic local write apart from server
         state and refuse to overwrite it silently. */
      pending_mutation_id TEXT,

      CHECK (revision >= 0),
      CHECK ((data IS NULL) = (deleted_at IS NOT NULL)),
      UNIQUE (entity_type, entity_id)
    ) STRICT;

    CREATE INDEX entities_by_type ON entities (entity_type, entity_id);
    CREATE INDEX entities_pending ON entities (pending_mutation_id)
      WHERE pending_mutation_id IS NOT NULL;
    CREATE INDEX entities_live_by_type ON entities (entity_type)
      WHERE deleted_at IS NULL;

    /* ---------------------------------------------------------------- */
    /* Projections. Live rows only: a tombstone deletes its projection.  */
    /* Every one cascades from entities, so a projection row cannot      */
    /* outlive the entity it projects.                                   */
    /* ---------------------------------------------------------------- */
    CREATE TABLE conversations (
      entity_key      TEXT PRIMARY KEY REFERENCES entities (entity_key) ON DELETE CASCADE,
      id              TEXT NOT NULL UNIQUE,
      revision        INTEGER NOT NULL,
      title           TEXT,
      kind            TEXT,
      model           TEXT,
      origin          TEXT,
      pinned          INTEGER NOT NULL DEFAULT 0,
      archived_at     TEXT,
      folder_id       TEXT,
      project_id      TEXT,
      forked_from_id  TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      last_message_at TEXT,
      deleted_at      TEXT
    ) STRICT;

    CREATE INDEX conversations_recent ON conversations (last_message_at DESC);
    CREATE INDEX conversations_by_project ON conversations (project_id)
      WHERE project_id IS NOT NULL;
    CREATE INDEX conversations_by_folder ON conversations (folder_id)
      WHERE folder_id IS NOT NULL;

    CREATE TABLE messages (
      entity_key        TEXT PRIMARY KEY REFERENCES entities (entity_key) ON DELETE CASCADE,
      id                TEXT NOT NULL UNIQUE,
      revision          INTEGER NOT NULL,
      /* Not a foreign key to conversations: a change page can deliver a
         message before its conversation (they are separate entity types on
         separate cursors), and rejecting the message would stall the page.
         Orphans resolve on a later page and are filtered by the join. */
      conversation_id   TEXT,
      client_id         TEXT,
      role              TEXT,
      content           TEXT,
      reasoning         TEXT,
      model             TEXT,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      created_at        TEXT,
      updated_at        TEXT,
      deleted_at        TEXT
    ) STRICT;

    CREATE INDEX messages_by_conversation ON messages (conversation_id, created_at);
    CREATE INDEX messages_by_client_id ON messages (client_id) WHERE client_id IS NOT NULL;

    CREATE TABLE projects (
      entity_key   TEXT PRIMARY KEY REFERENCES entities (entity_key) ON DELETE CASCADE,
      id           TEXT NOT NULL UNIQUE,
      revision     INTEGER NOT NULL,
      name         TEXT,
      instructions TEXT,
      starred      INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT,
      updated_at   TEXT,
      deleted_at   TEXT
    ) STRICT;

    CREATE INDEX projects_starred ON projects (starred, updated_at DESC);

    /* Projection of the 'scheduled_task' entity type.
       NOTE: this is NOT the Juno "Work" product surface. Work has no entity
       type in the change feed at all — see docs/SYNC.md, contract gaps. */
    CREATE TABLE work_tasks (
      entity_key      TEXT PRIMARY KEY REFERENCES entities (entity_key) ON DELETE CASCADE,
      id              TEXT NOT NULL UNIQUE,
      revision        INTEGER NOT NULL,
      name            TEXT,
      prompt          TEXT,
      model           TEXT,
      cadence         TEXT,
      timezone        TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_run_at     TEXT,
      next_run_at     TEXT,
      conversation_id TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      deleted_at      TEXT
    ) STRICT;

    CREATE INDEX work_tasks_due ON work_tasks (enabled, next_run_at);

    /* Projection of the 'code_task' entity type. */
    CREATE TABLE code_sessions (
      entity_key      TEXT PRIMARY KEY REFERENCES entities (entity_key) ON DELETE CASCADE,
      id              TEXT NOT NULL UNIQUE,
      revision        INTEGER NOT NULL,
      device_id       TEXT,
      workspace_key   TEXT,
      workspace_name  TEXT,
      title           TEXT,
      prompt          TEXT,
      status          TEXT,
      last_seq        INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      deleted_at      TEXT
    ) STRICT;

    CREATE INDEX code_sessions_by_status ON code_sessions (status, updated_at DESC);
    CREATE INDEX code_sessions_by_workspace ON code_sessions (workspace_key)
      WHERE workspace_key IS NOT NULL;

    /* ---------------------------------------------------------------- */
    /* The mutation outbox.                                              */
    /* ---------------------------------------------------------------- */
    CREATE TABLE outbox (
      /* Local identity. Monotonic, and the delivery order. */
      seq                 INTEGER PRIMARY KEY AUTOINCREMENT,

      /* The server's idempotency key. Must be a UUID: the server's
         mutationRequestSchema declares clientMutationId as z.string().uuid()
         and rejects anything else with a 400. */
      client_mutation_id  TEXT NOT NULL UNIQUE,

      /* The device session this entry was created under. The server's
         MutationReceipt is keyed (account, deviceSession, clientMutationId),
         so an entry replayed under a DIFFERENT device session would execute a
         SECOND time. Recorded here so the drainer can refuse that. */
      device_session_id   TEXT NOT NULL,

      entity_type         TEXT NOT NULL,
      /* NULL for creates until the server assigns the real id. */
      entity_id           TEXT,
      /* The optimistic local id used for a create, echoed back by the server
         in entityMappings so the projection row can be rewritten. */
      client_entity_id    TEXT,

      operation           TEXT NOT NULL,
      base_revision       INTEGER NOT NULL,

      /* The exact JSON body that will be POSTed, frozen at enqueue time.
         Frozen, not rebuilt: the server hashes the whole request and a retry
         whose body differs by even baseRevision is rejected 409
         idempotency_key_reused. */
      request_body        TEXT NOT NULL,
      request_hash        TEXT NOT NULL,

      state               TEXT NOT NULL,
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      next_attempt_at     INTEGER NOT NULL,

      lease_owner         TEXT,
      lease_token         TEXT,
      lease_expires_at    INTEGER,

      last_error_code     TEXT,
      last_error_message  TEXT,
      server_revision     INTEGER,

      result_json         TEXT,

      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,

      CHECK (base_revision >= 0),
      CHECK (attempt_count >= 0),
      CHECK (state IN ('pending','inflight','conflicted','dead','done','superseded'))
    ) STRICT;

    /* The drain query: oldest non-terminal entry whose backoff has elapsed. */
    CREATE INDEX outbox_ready ON outbox (state, next_attempt_at, seq);
    /* Per-entity ordering and blocking checks. */
    CREATE INDEX outbox_by_entity ON outbox (entity_type, entity_id, seq);

    /* ---------------------------------------------------------------- */
    /* Conflicts surfaced to the user.                                   */
    /* ---------------------------------------------------------------- */
    CREATE TABLE sync_conflicts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_key      TEXT NOT NULL,
      entity_type     TEXT NOT NULL,
      entity_id       TEXT NOT NULL,
      outbox_seq      INTEGER,
      kind            TEXT NOT NULL,
      local_revision  INTEGER,
      server_revision INTEGER,
      /* The local intent that lost, kept verbatim so the UI can offer
         "reapply" and so nothing the user typed is ever actually destroyed. */
      local_payload   TEXT,
      detected_at     INTEGER NOT NULL,
      resolved_at     INTEGER,
      resolution      TEXT,
      CHECK (kind IN ('revision_conflict','server_deleted','rejected','key_reused','device_session_changed'))
    ) STRICT;

    CREATE INDEX sync_conflicts_open ON sync_conflicts (resolved_at, detected_at)
      WHERE resolved_at IS NULL;
  `,
};

/**
 * Every migration, in order. Append only; never edit a shipped entry.
 */
const MIGRATIONS: readonly Migration[] = [MIGRATION_001_INITIAL];

export const CURRENT_SCHEMA_VERSION: number =
  MIGRATIONS.length === 0 ? 0 : MIGRATIONS[MIGRATIONS.length - 1]!.version;

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

export class MigrationError extends Error {
  readonly from: number;
  readonly to: number;

  constructor(message: string, from: number, to: number, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MigrationError';
    this.from = from;
    this.to = to;
  }
}

export function readSchemaVersion(db: SqlDatabase): number {
  const row = db.prepare('PRAGMA user_version').get();
  const value = row ? Object.values(row)[0] : 0;
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0;
}

/**
 * Bring `db` to `CURRENT_SCHEMA_VERSION`.
 *
 * Returns the versions actually applied, which is what the caller logs. A
 * no-op upgrade returns an empty array.
 */
export function migrateToLatest(db: SqlDatabase): readonly number[] {
  const startingVersion = readSchemaVersion(db);

  if (startingVersion > CURRENT_SCHEMA_VERSION) {
    /* Forward only. This database was written by a newer build; an older binary
       cannot know which columns it must keep populated, and "it mostly worked"
       is the worst outcome available here. */
    throw new MigrationError(
      `This account database is at schema version ${startingVersion}, but this build understands version ${CURRENT_SCHEMA_VERSION}. Update Juno Desktop to open it.`,
      startingVersion,
      CURRENT_SCHEMA_VERSION,
    );
  }

  assertContiguous();

  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= startingVersion) continue;

    /* One transaction per migration, so a failure leaves the previous version
       whole. `user_version` is set inside the same transaction as the DDL: it
       lives in the database header and commits atomically with it, which is the
       property that makes a separate bookkeeping table unnecessary. */
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.up);
      /* Not parameterisable — PRAGMA does not take bound values. The value is
         an integer literal from the constant table above, never user input. */
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (cause) {
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* Surface the original failure instead. */
        }
      }
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed.`,
        startingVersion,
        migration.version,
        { cause },
      );
    }
    applied.push(migration.version);
  }

  const finalVersion = readSchemaVersion(db);
  if (finalVersion !== CURRENT_SCHEMA_VERSION) {
    throw new MigrationError(
      `Migrations finished at version ${finalVersion}, expected ${CURRENT_SCHEMA_VERSION}.`,
      startingVersion,
      CURRENT_SCHEMA_VERSION,
    );
  }

  return applied;
}

/**
 * Guards the one mistake this design cannot detect at runtime: a migration
 * added with a duplicate or out-of-order version number, which would make
 * `<= startingVersion` skip a step forever on already-upgraded installs.
 */
function assertContiguous(): void {
  MIGRATIONS.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        `Migration table is not contiguous: entry ${index} declares version ${migration.version}, expected ${index + 1}.`,
        0,
        CURRENT_SCHEMA_VERSION,
      );
    }
  });
}

/** Exposed for tests and for the diagnostics surface. */
export function migrationNames(): readonly { version: number; name: string }[] {
  return MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name }));
}
