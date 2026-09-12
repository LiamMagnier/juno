/**
 * Backfill encryption at rest onto the columns that were shipped in plaintext.
 *
 * `Message.content` has been encrypted since message-crypto.ts. The columns
 * beside it were not, and at least one of them — `Message.activity`, the
 * tool-call log — carries the user's own Gmail / Linear / Notion content
 * verbatim, which made a database dump roughly as revealing as no encryption
 * at all. This pass closes that, row by row, on a live database.
 *
 * The read paths are READ-BOTH (src/lib/field-crypto.ts): a row this has not
 * reached yet is still plaintext and still reads correctly. So the deploy order
 * is "ship the code, then run this, at whatever pace suits" — there is no
 * window in which the application is broken, and no requirement to finish.
 *
 *   - idempotent — a row already carrying an `enc:` payload is skipped without
 *     a write, so re-running over covered ground costs reads and nothing else;
 *   - resumable  — the last id of every committed batch is written to a
 *     per-column progress file; `--resume` picks up after it. A kill mid-run
 *     costs at most one batch of re-reads, never data;
 *   - online     — cursor pagination by primary key, one update per row, no
 *     long transaction and no table lock.
 *
 * NOT covered, deliberately: `Attachment.extractedText` and
 * `ArtifactVersion.content`. Both are searched INSIDE Postgres — see
 * src/lib/search/sql.ts, which builds `to_tsvector` and snippets directly from
 * those columns — so encrypting them would turn unified search into a silent
 * no-hit. `MemoryEntry.content` is excluded for exactly the same reason
 * (`memorySearchSql`). See SECURITY.md.
 *
 *   npm run crypto:encrypt-columns -- --dry-run              # report, write nothing
 *   npm run crypto:encrypt-columns                           # every column
 *   npm run crypto:encrypt-columns -- --column=message.activity
 *   npm run crypto:encrypt-columns -- --resume               # continue after an interruption
 *   npm run crypto:encrypt-columns -- --batch=200
 *
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script).
 *
 * The loop below (`ColumnJob` / `runJob`) deliberately knows nothing about
 * Prisma: the client is imported inside `main`, and the column definitions are
 * built from it there. That is what lets tests/encrypt-columns-backfill.test.ts
 * drive a real pass over an in-memory table and PROVE the idempotence and
 * resume properties this comment claims, instead of asserting them by eye.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import {
  decryptField,
  decryptJsonField,
  encryptField,
  encryptJsonField,
  isEncryptedJsonField,
  FIELD_DECRYPT_PLACEHOLDER,
} from "@/lib/field-crypto";
import { isEncryptedMessageText, loadKeyring } from "@/lib/message-crypto";

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * One backfillable column.
 *
 * `page` returns rows after a cursor, ordered by id; `sealed` decides whether a
 * row already carries ciphertext (the idempotency check); `seal` produces the
 * value to store. `verify` reads back what `seal` produced and compares it to
 * the original — a wrong key or a truncated write then fails HERE, before the
 * row is committed, rather than at read time months later.
 */
export interface ColumnJob {
  /** `--column=` selector, and the progress-file suffix. */
  readonly name: string;
  page(cursor: string | null, take: number): Promise<Array<{ id: string; value: unknown }>>;
  sealed(value: unknown): boolean;
  seal(value: unknown): unknown;
  verify(sealedValue: unknown, original: unknown): boolean;
  write(id: string, sealedValue: unknown): Promise<void>;
}

export interface RunOptions {
  readonly dryRun: boolean;
  readonly resume: boolean;
  readonly batch: number;
  /** Directory holding the per-column progress files. Overridable for tests. */
  readonly progressDir: string;
}

export interface Tally {
  scanned: number;
  encrypted: number;
  alreadyEncrypted: number;
  failed: number;
}

function progressFile(job: ColumnJob, options: RunOptions): string {
  return join(options.progressDir, `.juno-encrypt-columns.${job.name}.progress`);
}

function readCursor(job: ColumnJob, options: RunOptions): string | null {
  const file = progressFile(job, options);
  if (!options.resume || !existsSync(file)) return null;
  const raw = readFileSync(file, "utf8").trim();
  return raw.length > 0 ? raw : null;
}

function writeCursor(job: ColumnJob, options: RunOptions, id: string): void {
  if (options.dryRun) return;
  mkdirSync(options.progressDir, { recursive: true });
  writeFileSync(progressFile(job, options), id, "utf8");
}

function clearCursor(job: ColumnJob, options: RunOptions): void {
  const file = progressFile(job, options);
  if (!options.dryRun && existsSync(file)) unlinkSync(file);
}

/** One resumable, idempotent pass over a single column. */
export async function runJob(job: ColumnJob, options: RunOptions): Promise<Tally> {
  const tally: Tally = { scanned: 0, encrypted: 0, alreadyEncrypted: 0, failed: 0 };
  let cursor = readCursor(job, options);
  if (cursor) console.log(`[encrypt-columns] ${job.name}: resuming after id ${cursor}`);

  for (;;) {
    const rows = await job.page(cursor, options.batch);
    if (rows.length === 0) break;

    for (const row of rows) {
      tally.scanned += 1;
      try {
        // THE idempotency check. Everything else here is bookkeeping around
        // it: a row that is already ciphertext costs one comparison and no
        // write, so a re-run over a finished range is a pure scan.
        if (job.sealed(row.value)) {
          tally.alreadyEncrypted += 1;
          continue;
        }
        const sealedValue = job.seal(row.value);
        if (options.dryRun) {
          tally.encrypted += 1;
          continue;
        }
        if (!job.verify(sealedValue, row.value)) {
          throw new Error("re-read of the sealed value did not match the original");
        }
        await job.write(row.id, sealedValue);
        tally.encrypted += 1;
      } catch (err) {
        // One bad row must not stop the pass: it is counted, the cursor still
        // advances, and the operator gets a number to investigate. Never the
        // value — a plaintext or a ciphertext in the logs defeats the point.
        tally.failed += 1;
        console.error(
          `[encrypt-columns] ${job.name} row ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Written AFTER the batch's writes, never before: a crash between the two
    // makes the next run re-read rows that are already sealed, which the
    // idempotency check turns into a no-op. The other order would skip rows
    // that had never been written.
    cursor = rows[rows.length - 1].id;
    writeCursor(job, options, cursor);
    console.log(
      `[encrypt-columns] ${job.name}: ${tally.scanned} scanned, ${tally.encrypted} encrypted, ` +
        `${tally.alreadyEncrypted} already encrypted, ${tally.failed} failed (cursor ${cursor})`
    );
  }

  // The progress file is KEPT when anything failed, so a re-run resumes into
  // the range that needs another look instead of rescanning the whole table.
  if (tally.failed === 0) clearCursor(job, options);
  return tally;
}

// ---------------------------------------------------------------------------
// Column definitions (the Prisma client is injected, never imported here)
// ---------------------------------------------------------------------------

/** The slice of the Prisma client this script uses. */
export interface BackfillClient {
  message: {
    findMany(args: unknown): Promise<Array<{ id: string; activity: Prisma.JsonValue | null }>>;
    update(args: unknown): Promise<unknown>;
  };
  memorySummary: {
    findMany(args: unknown): Promise<Array<{ id: string; content: string }>>;
    update(args: unknown): Promise<unknown>;
  };
  scheduledTask: {
    findMany(args: unknown): Promise<Array<{ id: string; prompt: string }>>;
    update(args: unknown): Promise<unknown>;
  };
}

/** Ordering by primary key is what makes the cursor a resumable position. */
function pageArgs(cursor: string | null, take: number, select: Record<string, true>) {
  return {
    take,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { id: "asc" as const },
    select,
  };
}

/** A text column sealed with `encryptField`. The two below differ only in name. */
function textColumnJob(
  name: string,
  page: (cursor: string | null, take: number) => Promise<Array<{ id: string; value: string }>>,
  write: (id: string, value: string) => Promise<unknown>
): ColumnJob {
  return {
    name,
    page,
    sealed: (value) => typeof value === "string" && isEncryptedMessageText(value),
    seal: (value) => encryptField(value as string),
    verify: (sealedValue, original) => decryptField(sealedValue as string) === (original as string),
    write: async (id, sealedValue) => {
      await write(id, sealedValue as string);
    },
  };
}

export function buildJobs(db: BackfillClient): readonly ColumnJob[] {
  return [
    {
      name: "message.activity",
      async page(cursor, take) {
        // A `where` on the JSON column is deliberately absent: a predicate over
        // `activity` cannot use the primary-key index the cursor rides on.
        // Reading every row and skipping the NULLs in process is the cheaper
        // plan and keeps the cursor monotonic.
        const rows = await db.message.findMany(pageArgs(cursor, take, { id: true, activity: true }));
        return rows.map((r) => ({ id: r.id, value: r.activity }));
      },
      // NULL counts as "nothing to seal", which is what stops an absent
      // activity log from being rewritten as an envelope around `null`.
      sealed: (value) => value == null || isEncryptedJsonField(value),
      seal: (value) => encryptJsonField(value),
      verify: (sealedValue, original) =>
        JSON.stringify(decryptJsonField(sealedValue)) === JSON.stringify(original),
      write: async (id, sealedValue) => {
        // The Prisma column type is unchanged (`Json?`) — field-crypto wraps
        // the ciphertext in a one-key object precisely so that deploying this
        // needs no migration.
        await db.message.update({ where: { id }, data: { activity: sealedValue } });
      },
    },
    textColumnJob(
      "memorySummary.content",
      async (cursor, take) => {
        const rows = await db.memorySummary.findMany(pageArgs(cursor, take, { id: true, content: true }));
        return rows.map((r) => ({ id: r.id, value: r.content }));
      },
      (id, value) => db.memorySummary.update({ where: { id }, data: { content: value } })
    ),
    textColumnJob(
      "scheduledTask.prompt",
      async (cursor, take) => {
        const rows = await db.scheduledTask.findMany(pageArgs(cursor, take, { id: true, prompt: true }));
        return rows.map((r) => ({ id: r.id, value: r.prompt }));
      },
      (id, value) => db.scheduledTask.update({ where: { id }, data: { prompt: value } })
    ),
  ];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const options: RunOptions = {
    dryRun: process.argv.includes("--dry-run") || process.argv.includes("--dry"),
    resume: process.argv.includes("--resume"),
    batch: Math.max(1, Number(argValue("batch") ?? 500) || 500),
    progressDir: process.cwd(),
  };

  const keyring = loadKeyring();
  if (keyring.derived) {
    // Encrypting a whole column under a key derived from AUTH_SECRET would
    // make rotating the auth secret — routine, and documented — orphan every
    // row this pass touches. Same refusal as rotate-message-keys.ts.
    throw new Error(
      "Refusing to encrypt columns under an AUTH_SECRET-derived key. Configure DATA_ENCRYPTION_KEYRING first."
    );
  }

  // A sanity check on the helpers themselves before a single row is touched: a
  // keyring that cannot round-trip a string here would otherwise be discovered
  // one failed row at a time, across the whole table.
  const probe = encryptField("encrypt-columns self-check");
  if (probe === FIELD_DECRYPT_PLACEHOLDER || decryptField(probe) !== "encrypt-columns self-check") {
    throw new Error("The configured keyring failed a round-trip self-check. Refusing to write.");
  }

  // Imported here, not at the top: the loop above must stay database-free so
  // that it can be tested without one.
  const { prismaUnguarded } = await import("@/lib/db");
  const all = buildJobs(prismaUnguarded as unknown as BackfillClient);
  const requested = argValue("column");
  const jobs = requested ? all.filter((j) => j.name === requested) : all;
  if (jobs.length === 0) {
    throw new Error(`Unknown --column='${requested}'. Known columns: ${all.map((j) => j.name).join(", ")}.`);
  }

  console.log(
    `[encrypt-columns] active key '${keyring.activeKeyId}', ${jobs.length} column(s), batch ${options.batch}` +
      `${options.dryRun ? " — DRY RUN, nothing will be written" : ""}`
  );

  let failed = 0;
  try {
    for (const job of jobs) {
      const tally = await runJob(job, options);
      failed += tally.failed;
      console.log(
        `[encrypt-columns] ${job.name} done — scanned ${tally.scanned}, encrypted ${tally.encrypted}, ` +
          `already encrypted ${tally.alreadyEncrypted}, failed ${tally.failed}`
      );
    }
  } finally {
    await prismaUnguarded.$disconnect();
  }

  if (failed > 0) {
    console.error(
      `[encrypt-columns] ${failed} row(s) failed. Progress files are kept so a --resume re-run continues rather than restarting.`
    );
    process.exitCode = 1;
  }
}

// Only when this file is the process entry point. Importing the module — which
// the backfill test does — must not open a database connection or start a pass.
if (process.argv[1] && /encrypt-columns\.[cm]?ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
