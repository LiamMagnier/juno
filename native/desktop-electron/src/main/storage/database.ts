/**
 * Per-account durable storage, on Node's built-in SQLite.
 *
 * ## Why `node:sqlite` and not `better-sqlite3`
 *
 * `better-sqlite3` is a native addon, which means `@electron/rebuild` in the
 * packaging pipeline and an ABI matrix (Electron version × arch × Node ABI) that
 * breaks in CI far more often than the database itself ever does. Electron
 * 43.4.0 bundles Node 24.18.1, whose `node:sqlite` module is compiled into the
 * runtime, so the persistence path ends up with zero native modules.
 *
 * The API was verified against the Node 24 documentation and probed against the
 * runtime rather than assumed to match `better-sqlite3`. The differences that
 * actually bite:
 *
 *  - There is **no `db.transaction()` helper**. Transactions are explicit
 *    `BEGIN` / `COMMIT` / `ROLLBACK`, and getting rollback-on-throw right is
 *    this module's job — see `transaction()` below.
 *  - The "are we in a transaction" property is `isTransaction`, not
 *    `inTransaction`.
 *  - Reading an INTEGER larger than `Number.MAX_SAFE_INTEGER` **throws
 *    `ERR_OUT_OF_RANGE`** unless `readBigInts` is enabled. This is precisely why
 *    change cursors (Postgres `BIGSERIAL`) are stored as TEXT throughout this
 *    schema: a cursor past 2^53 would otherwise turn every read of the sync
 *    state into a hard failure.
 *  - Rows come back as null-prototype objects, so `row.hasOwnProperty(...)` is
 *    not available on them. Read fields directly.
 *
 * `node:sqlite` is Stability 1.2 (release candidate). The mitigation is that the
 * Electron version pins the Node version: the API cannot change under this app
 * without an explicit, deliberate Electron upgrade, which is a reviewed change
 * with its own test run. `SqlDatabase` below is a deliberately thin interface so
 * that if the module does move, the blast radius is this one file.
 *
 * ## Account separation
 *
 * One database file per signed-in account, under
 * `<userData>/accounts/<accountId>/juno.db`. This is a security boundary, not a
 * convenience: a single shared file with an `account_id` column means every
 * query is one missing `WHERE` clause away from cross-account disclosure, and it
 * makes "sign out and forget this account" a delete-by-predicate instead of an
 * unlink. There is no code path in this module that opens two accounts through
 * one handle.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CURRENT_SCHEMA_VERSION, migrateToLatest, readSchemaVersion } from './migrations.js';

/* -------------------------------------------------------------------------- */
/* Thin SQL interface                                                          */
/* -------------------------------------------------------------------------- */

/** Values `node:sqlite` can bind and return. */
export type SqlValue = null | number | bigint | string | Uint8Array;

export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  run(...params: readonly SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: readonly SqlValue[]): SqlRow | undefined;
  all(...params: readonly SqlValue[]): SqlRow[];
}

/**
 * The surface of a database handle this codebase is allowed to depend on.
 *
 * Everything above `storage/` talks to `AccountDatabase`, and `AccountDatabase`
 * talks to this. Swapping the driver means satisfying this interface.
 */
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  close(): void;
  readonly isTransaction: boolean;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class StorageError extends Error {
  readonly code:
    | 'invalid_account_id'
    | 'open_failed'
    | 'migration_failed'
    | 'closed'
    | 'integrity_failed';

  constructor(code: StorageError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

/** Account ids that are safe to use verbatim as a single path segment. */
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The directory name for an account.
 *
 * An account id arrives from the server, and server-supplied strings do not get
 * to choose filesystem paths. Ids matching the conservative charset above (every
 * cuid and uuid does) are used verbatim so that a support engineer can find the
 * right directory; anything else — including anything containing a separator or
 * a dot segment — is replaced by a stable hash. There is deliberately no path
 * that concatenates an unvalidated id into a path.
 */
export function accountDirectoryName(accountId: string): string {
  if (accountId.length === 0) {
    throw new StorageError('invalid_account_id', 'The account id is empty.');
  }
  if (SAFE_ACCOUNT_ID.test(accountId) && accountId !== '.' && accountId !== '..') {
    return accountId;
  }
  return `h-${createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 32)}`;
}

export function accountDatabasePath(accountsRoot: string, accountId: string): string {
  return join(accountsRoot, accountDirectoryName(accountId), 'juno.db');
}

/**
 * `<userData>/accounts`, resolved lazily.
 *
 * Imported dynamically so that this module — and therefore the migrations and
 * the reducer's storage counterpart — can be unit-tested under plain Node
 * without an Electron runtime present.
 */
export async function defaultAccountsRoot(): Promise<string> {
  const { app } = await import('electron');
  return join(app.getPath('userData'), 'accounts');
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

export interface DatabaseHealth {
  readonly ok: boolean;
  readonly accountDirectory: string;
  readonly schemaVersion: number;
  readonly expectedSchemaVersion: number;
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly integrity: string;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly fileBytes: number;
  readonly walBytes: number;
  readonly openTransaction: boolean;
  readonly problems: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* AccountDatabase                                                             */
/* -------------------------------------------------------------------------- */

export interface OpenAccountDatabaseOptions {
  readonly accountId: string;
  readonly accountsRoot: string;
  /** How long to wait on a locked database before failing. Milliseconds. */
  readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * An open, migrated database for exactly one account.
 */
export class AccountDatabase {
  readonly accountId: string;
  readonly path: string;

  #db: SqlDatabase;
  #closed = false;
  #savepointDepth = 0;
  #statements = new Map<string, SqlStatement>();

  private constructor(accountId: string, path: string, db: SqlDatabase) {
    this.accountId = accountId;
    this.path = path;
    this.#db = db;
  }

  static open(options: OpenAccountDatabaseOptions): AccountDatabase {
    const path = accountDatabasePath(options.accountsRoot, options.accountId);
    const directory = join(options.accountsRoot, accountDirectoryName(options.accountId));

    let handle: DatabaseSync;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      handle = new DatabaseSync(path, {
        open: true,
        readOnly: false,
        /* Defaults to true in Node 24, but the schema's cascade behaviour is
           load-bearing (a projection row must not outlive its entity row), so
           it is stated rather than inherited. */
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
        /* `timeout` is the SQLite busy handler. The default is 0 — an immediate
           SQLITE_BUSY. Two writers exist in practice: the sync loop applying a
           change page and a user mutation being committed from the UI thread's
           IPC handler. */
        timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      });
    } catch (cause) {
      throw new StorageError('open_failed', `Could not open the account database at ${path}.`, {
        cause,
      });
    }

    const db = handle as unknown as SqlDatabase;

    try {
      configureConnection(db, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
    } catch (cause) {
      db.close();
      throw new StorageError('open_failed', 'Could not configure the account database.', { cause });
    }

    const database = new AccountDatabase(options.accountId, path, db);
    try {
      /* Migrations are durable by construction: schema changes are cheap and
         rare, and a half-migrated file is unrecoverable, so they are worth an
         fsync regardless of the steady-state setting. */
      database.#withSynchronousFull(() => {
        migrateToLatest(db);
      });
    } catch (cause) {
      database.close();
      throw new StorageError('migration_failed', 'The account database could not be migrated.', {
        cause,
      });
    }

    return database;
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                              */
  /* ---------------------------------------------------------------------- */

  /** Prepared statements are cached; `node:sqlite` recompiles on every prepare. */
  statement(sql: string): SqlStatement {
    this.#assertOpen();
    const cached = this.#statements.get(sql);
    if (cached) return cached;
    const prepared = this.#db.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  exec(sql: string): void {
    this.#assertOpen();
    this.#db.exec(sql);
  }

  get raw(): SqlDatabase {
    this.#assertOpen();
    return this.#db;
  }

  get isTransaction(): boolean {
    return !this.#closed && this.#db.isTransaction;
  }

  /* ---------------------------------------------------------------------- */
  /* Transactions                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Run `body` in a transaction, rolling back if it throws.
   *
   * `BEGIN IMMEDIATE` rather than the default deferred begin: a deferred
   * transaction takes its write lock at the first write, so two concurrent
   * read-then-write transactions can both read, then one gets `SQLITE_BUSY` at
   * upgrade time with no busy-handler retry available (SQLite cannot back off a
   * lock upgrade without risking deadlock). Taking the write lock up front means
   * the busy timeout does its job.
   *
   * Nested calls become savepoints, so a caller that already holds a transaction
   * — the outbox writing in the same transaction as a local state change — does
   * not accidentally commit its parent early.
   */
  transaction<T>(body: () => T): T {
    this.#assertOpen();

    if (this.#db.isTransaction) {
      const name = `sp_${++this.#savepointDepth}`;
      this.#db.exec(`SAVEPOINT ${name}`);
      try {
        const result = body();
        this.#db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        try {
          this.#db.exec(`ROLLBACK TO ${name}`);
          this.#db.exec(`RELEASE ${name}`);
        } catch {
          /* The outer transaction is now the only thing that can clean up; it
             will roll back when this rethrow reaches it. */
        }
        throw error;
      } finally {
        this.#savepointDepth -= 1;
      }
    }

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      /* COMMIT is inside the try on purpose: it can fail (a busy snapshot, a
         deferred foreign-key violation), and a failed COMMIT leaves the
         transaction open. */
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          /* Nothing further to do; the connection is about to surface the
             original error, which is the more useful one. */
        }
      }
      throw error;
    }
  }

  /**
   * A transaction that survives a power loss, not merely a process crash.
   *
   * The steady-state setting is `synchronous = NORMAL` (see
   * `configureConnection`), which is safe against a process crash but can lose
   * the most recent commits if the machine loses power before the WAL is
   * fsynced. For the entity mirror that is an acceptable trade: anything lost is
   * re-fetched from the change feed on the next sync, because the cursor is
   * advanced in the same transaction as the data it describes.
   *
   * The outbox is different. It holds user intent that exists nowhere else until
   * it reaches the server, so losing the last few commits means losing the
   * user's work. Outbox writes therefore run here, which raises `synchronous` to
   * FULL for the duration and restores it afterwards. The pragma is changed
   * outside the transaction — SQLite ignores an attempt to change it inside one.
   */
  durableTransaction<T>(body: () => T): T {
    this.#assertOpen();
    if (this.#db.isTransaction) {
      /* Already inside a transaction whose durability was decided by whoever
         opened it; nesting cannot retroactively raise it. */
      return this.transaction(body);
    }
    return this.#withSynchronousFull(() => this.transaction(body));
  }

  #withSynchronousFull<T>(body: () => T): T {
    this.#db.exec('PRAGMA synchronous = FULL');
    try {
      return body();
    } finally {
      try {
        this.#db.exec('PRAGMA synchronous = NORMAL');
      } catch {
        /* A connection that cannot accept a pragma is already failing; the
           original error (if any) is the one worth propagating. */
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Diagnostics                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * The diagnostics surface. Contains no account content and no credentials —
   * it is safe to render in a support panel and to write to a log.
   */
  health(): DatabaseHealth {
    const problems: string[] = [];

    if (this.#closed) {
      return {
        ok: false,
        accountDirectory: accountDirectoryName(this.accountId),
        schemaVersion: -1,
        expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
        journalMode: 'closed',
        foreignKeys: false,
        integrity: 'closed',
        pageCount: 0,
        pageSize: 0,
        fileBytes: 0,
        walBytes: 0,
        openTransaction: false,
        problems: ['The database handle is closed.'],
      };
    }

    const journalMode = String(this.#pragma('journal_mode') ?? '');
    const foreignKeys = Number(this.#pragma('foreign_keys') ?? 0) === 1;
    const pageCount = Number(this.#pragma('page_count') ?? 0);
    const pageSize = Number(this.#pragma('page_size') ?? 0);

    /* `quick_check` rather than `integrity_check`: the full check reads and
       verifies every page, which on a large mirror is seconds of blocked I/O.
       The quick check catches the structural damage that matters here. */
    let integrity = 'unknown';
    try {
      integrity = String(this.#pragma('quick_check') ?? 'unknown');
    } catch (error) {
      integrity = error instanceof Error ? `failed: ${error.message}` : 'failed';
    }

    let schemaVersion = -1;
    try {
      schemaVersion = readSchemaVersion(this.#db);
    } catch {
      problems.push('The schema version could not be read.');
    }

    if (journalMode.toLowerCase() !== 'wal') problems.push(`Journal mode is ${journalMode}, not WAL.`);
    if (!foreignKeys) problems.push('Foreign key enforcement is off.');
    if (integrity !== 'ok') problems.push(`Integrity check reported: ${integrity}`);
    if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
      problems.push(`Schema is at version ${schemaVersion}, expected ${CURRENT_SCHEMA_VERSION}.`);
    }

    return {
      ok: problems.length === 0,
      accountDirectory: accountDirectoryName(this.accountId),
      schemaVersion,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      journalMode,
      foreignKeys,
      integrity,
      pageCount,
      pageSize,
      fileBytes: fileSize(this.path),
      walBytes: fileSize(`${this.path}-wal`),
      openTransaction: this.#db.isTransaction,
      problems,
    };
  }

  #pragma(name: string): SqlValue | undefined {
    const row = this.#db.prepare(`PRAGMA ${name}`).get();
    if (!row) return undefined;
    const values = Object.values(row);
    return values.length > 0 ? values[0] : undefined;
  }

  /* ---------------------------------------------------------------------- */
  /* Shutdown                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Close cleanly.
   *
   * The WAL checkpoint is the point of this method. Closing a handle without
   * checkpointing leaves `-wal` and `-shm` files beside the database; SQLite
   * recovers from them on next open, but only if they are all present and
   * mutually consistent. An installer, a backup tool, or a user copying "the
   * database file" out of the profile directory sees one file and takes it —
   * and that is how a truncated, silently-stale database happens. `TRUNCATE`
   * folds the log back into the main file and empties it.
   *
   * Idempotent: shutdown paths tend to run twice.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();

    try {
      if (this.#db.isTransaction) {
        /* An open transaction at shutdown is a bug elsewhere, but committing it
           blind would be worse than discarding it: the caller never reached its
           own commit, so it never declared the state consistent. */
        this.#db.exec('ROLLBACK');
      }
    } catch {
      /* Fall through to the checkpoint attempt. */
    }

    try {
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* A checkpoint can legitimately fail if another process holds a read
         lock. The WAL stays valid; SQLite will recover it. */
    }

    try {
      this.#db.close();
    } catch {
      /* Already closed underneath us. */
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new StorageError('closed', 'The account database handle is closed.');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Connection configuration                                                    */
/* -------------------------------------------------------------------------- */

function configureConnection(db: SqlDatabase, busyTimeoutMs: number): void {
  /* WAL: readers never block the writer. The sync loop writes change pages while
     the UI reads the mirror; under the rollback journal every page apply would
     freeze the interface. WAL also survives a process crash without corruption,
     which is the failure mode an Electron app actually has. */
  db.exec('PRAGMA journal_mode = WAL');

  /* Stated explicitly even though the constructor already enabled it — the
     schema uses ON DELETE CASCADE from projection tables to the entity mirror,
     and a connection with foreign keys off would silently accumulate orphans. */
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);

  /*
   * `synchronous = NORMAL`.
   *
   * In WAL mode NORMAL means SQLite fsyncs at checkpoints rather than at every
   * commit. It is fully durable against a process crash — the case that
   * actually happens to a desktop app — and cannot corrupt the database under
   * any failure. What it can lose is the last few committed transactions if the
   * machine loses power outright.
   *
   * That is the right default here because the great majority of writes are
   * change-page applications, and the mirror is reconstructible: the cursor is
   * advanced in the same transaction as the rows it covers, so a lost tail
   * simply means the next sync replays from an older cursor. Paying an fsync per
   * commit to protect data the server will hand back for free is the wrong
   * trade, and during a bootstrap of tens of thousands of entities it is the
   * difference between seconds and minutes.
   *
   * Writes that are NOT reconstructible — anything touching the outbox — go
   * through `durableTransaction()`, which raises this to FULL for the duration.
   */
  db.exec('PRAGMA synchronous = NORMAL');

  /* Cap WAL growth so an idle app does not sit on a multi-hundred-megabyte log
     after a large bootstrap. */
  db.exec('PRAGMA wal_autocheckpoint = 1000');

  /* Temp b-trees for ORDER BY on the transcript queries stay in memory. */
  db.exec('PRAGMA temp_store = MEMORY');
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Process-wide registry                                                       */
/* -------------------------------------------------------------------------- */

const openDatabases = new Map<string, AccountDatabase>();

/**
 * Open (or reuse) the database for an account.
 *
 * Reuse is keyed on the account id so that two subsystems in the main process
 * share one handle and therefore one connection-level busy timeout and one WAL
 * writer, rather than contending with each other.
 */
export function openAccountDatabase(options: OpenAccountDatabaseOptions): AccountDatabase {
  const existing = openDatabases.get(options.accountId);
  if (existing) return existing;
  const database = AccountDatabase.open(options);
  openDatabases.set(options.accountId, database);
  return database;
}

export function getOpenAccountDatabase(accountId: string): AccountDatabase | undefined {
  return openDatabases.get(accountId);
}

export function closeAccountDatabase(accountId: string): void {
  const database = openDatabases.get(accountId);
  if (!database) return;
  openDatabases.delete(accountId);
  database.close();
}

/**
 * Close every open account database. Wire this to `app.on('will-quit')`.
 *
 * Registered as a synchronous call deliberately: Electron does not wait for
 * promises during quit, so an async close is a close that sometimes does not
 * happen — which is exactly the unclosed-WAL case this is here to prevent.
 */
export function closeAllAccountDatabases(): void {
  for (const accountId of [...openDatabases.keys()]) {
    closeAccountDatabase(accountId);
  }
}

/** Health for every open account, for the diagnostics surface. */
export function allDatabaseHealth(): DatabaseHealth[] {
  return [...openDatabases.values()].map((database) => database.health());
}
