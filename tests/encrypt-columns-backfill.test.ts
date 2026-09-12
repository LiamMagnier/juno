import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/*
 * scripts/encrypt-columns.ts, driven over an in-memory table.
 *
 * The three properties the script claims — idempotent, resumable, and
 * plaintext-safe until it has run — are the ones that decide whether it is safe
 * to point at production, so they are exercised rather than asserted by eye.
 * The script's loop takes its rows through an injected `ColumnJob`, so a fake
 * table is enough; nothing here needs Postgres.
 */
const KEY = randomBytes(32).toString("base64");

let backfill!: typeof import("../scripts/encrypt-columns");
let fc!: typeof import("@/lib/field-crypto");

before(async () => {
  process.env.DATA_ENCRYPTION_KEYRING = `a:${KEY}`;
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID = "a";
  backfill = await import("../scripts/encrypt-columns");
  fc = await import("@/lib/field-crypto");
});

/** An in-memory stand-in for one table: ids ascending, one sealable column. */
interface FakeRow {
  id: string;
  value: unknown;
}

interface FakeTable {
  rows: FakeRow[];
  /** Every id the job actually wrote, in order — including repeats. */
  writes: string[];
  /** Throw on the Nth write (1-based): one bad row, the pass carries on. */
  failWriteAt?: number;
  /** Throw on the Nth page (1-based): the pass itself dies, like a `kill`. */
  failPageAt?: number;
  pages: number;
}

function textTable(count: number): FakeTable {
  return {
    // Zero-padded so lexical id order matches insertion order, like a cuid
    // page ordered by primary key.
    rows: Array.from({ length: count }, (_, i) => ({
      id: `row-${String(i).padStart(3, "0")}`,
      value: `secret number ${i}`,
    })),
    writes: [],
    pages: 0,
  };
}

/** A ColumnJob over a FakeTable, using the same seal/verify helpers as the script. */
function jobFor(table: FakeTable): import("../scripts/encrypt-columns").ColumnJob {
  return {
    name: "fake.column",
    async page(cursor, take) {
      table.pages += 1;
      if (table.failPageAt && table.pages === table.failPageAt) {
        throw new Error("simulated process death mid-pass");
      }
      const start = cursor ? table.rows.findIndex((r) => r.id === cursor) + 1 : 0;
      return table.rows.slice(start, start + take).map((r) => ({ id: r.id, value: r.value }));
    },
    sealed: (value) => typeof value === "string" && value.startsWith("enc:"),
    seal: (value) => fc.encryptField(value as string),
    verify: (sealedValue, original) => fc.decryptField(sealedValue as string) === (original as string),
    async write(id, sealedValue) {
      table.writes.push(id);
      if (table.failWriteAt && table.writes.length === table.failWriteAt) {
        throw new Error("simulated interruption");
      }
      const row = table.rows.find((r) => r.id === id);
      if (row) row.value = sealedValue;
    },
  };
}

function options(progressDir: string, overrides: Partial<import("../scripts/encrypt-columns").RunOptions> = {}) {
  return { dryRun: false, resume: false, batch: 4, progressDir, ...overrides };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "juno-encrypt-columns-"));
}

test("a first pass seals every row and leaves each one readable", async () => {
  const table = textTable(10);
  const originals = table.rows.map((r) => r.value);
  const tally = await backfill.runJob(jobFor(table), options(scratch()));

  assert.equal(tally.scanned, 10);
  assert.equal(tally.encrypted, 10);
  assert.equal(tally.alreadyEncrypted, 0);
  assert.equal(tally.failed, 0);
  for (const [i, row] of table.rows.entries()) {
    assert.match(row.value as string, /^enc:v2:a:/, "every row is ciphertext at rest");
    assert.equal(fc.decryptField(row.value as string), originals[i], "and still reads back");
  }
});

test("IDEMPOTENT: a second pass over covered ground writes nothing", async () => {
  const dir = scratch();
  const table = textTable(10);
  await backfill.runJob(jobFor(table), options(dir));
  const afterFirst = table.rows.map((r) => r.value);
  const writesAfterFirst = table.writes.length;

  const second = await backfill.runJob(jobFor(table), options(dir));

  assert.equal(second.scanned, 10);
  assert.equal(second.encrypted, 0, "no row is sealed twice");
  assert.equal(second.alreadyEncrypted, 10);
  assert.equal(table.writes.length, writesAfterFirst, "and no UPDATE is issued at all");
  // Byte-identical: a re-seal would produce a different ciphertext (fresh IV),
  // so this is the check that would catch double encryption.
  assert.deepEqual(table.rows.map((r) => r.value), afterFirst);
});

test("IDEMPOTENT: a half-encrypted table is completed, not restarted", async () => {
  const dir = scratch();
  const table = textTable(10);
  // Seal the first three rows by hand, as an interrupted earlier run would have.
  for (const row of table.rows.slice(0, 3)) row.value = fc.encryptField(row.value as string);
  const preSealed = table.rows.slice(0, 3).map((r) => r.value);

  const tally = await backfill.runJob(jobFor(table), options(dir));

  assert.equal(tally.alreadyEncrypted, 3);
  assert.equal(tally.encrypted, 7);
  assert.deepEqual(table.rows.slice(0, 3).map((r) => r.value), preSealed, "already-sealed rows are untouched");
});

test("RESUMABLE: a pass killed mid-run picks up after the last committed batch", async () => {
  const dir = scratch();
  const progress = join(dir, ".juno-encrypt-columns.fake.column.progress");
  const table = textTable(10);
  // Batches of four: pages 1 and 2 commit rows 000–007, then the process dies
  // before page 3 — the shape of a `kill`, a deploy, or a lost connection.
  table.failPageAt = 3;

  await assert.rejects(backfill.runJob(jobFor(table), options(dir)), /process death/);

  assert.ok(existsSync(progress), "the cursor survives the death — that is the whole point");
  assert.equal(readFileSync(progress, "utf8"), "row-007", "it names the last row of the last committed batch");
  const sealedBeforeDeath = table.rows.slice(0, 8).map((r) => r.value);
  for (const row of table.rows.slice(0, 8)) assert.match(row.value as string, /^enc:v2:a:/);
  for (const row of table.rows.slice(8)) assert.equal(row.value, `secret number ${row.id.slice(-1)}`);

  table.failPageAt = undefined;
  table.writes = [];
  const resumed = await backfill.runJob(jobFor(table), options(dir, { resume: true }));

  assert.equal(resumed.scanned, 2, "only the rows after the cursor are re-read");
  assert.deepEqual(table.writes, ["row-008", "row-009"]);
  assert.equal(resumed.failed, 0);
  // Byte-identical: the already-sealed prefix was never touched, so no row was
  // encrypted twice and no ciphertext was rewritten under a fresh IV.
  assert.deepEqual(table.rows.slice(0, 8).map((r) => r.value), sealedBeforeDeath);
  for (const row of table.rows) assert.match(row.value as string, /^enc:v2:a:/);
  assert.ok(!existsSync(progress), "a clean finish clears the cursor");
});

test("one unreadable row is counted and the pass carries on", async () => {
  const dir = scratch();
  const table = textTable(10);
  table.failWriteAt = 6;

  const tally = await backfill.runJob(jobFor(table), options(dir));

  assert.equal(tally.failed, 1);
  assert.equal(tally.encrypted, 9, "the other nine rows are still sealed");
  // The progress file is KEPT when anything failed, so the operator can see
  // where the pass got to rather than being told only that it finished.
  assert.ok(existsSync(join(dir, ".juno-encrypt-columns.fake.column.progress")));
});

test("RESUMABLE: without --resume the cursor file is ignored", async () => {
  const dir = scratch();
  const table = textTable(10);
  table.failWriteAt = 3;
  await backfill.runJob(jobFor(table), options(dir));
  assert.ok(existsSync(join(dir, ".juno-encrypt-columns.fake.column.progress")));

  table.failWriteAt = undefined;
  const rerun = await backfill.runJob(jobFor(table), options(dir));
  assert.equal(rerun.scanned, 10, "a plain re-run starts from the top");
  assert.equal(rerun.failed, 0);
  assert.ok(
    !existsSync(join(dir, ".juno-encrypt-columns.fake.column.progress")),
    "a clean pass clears the cursor so the next run is not a partial one"
  );
});

test("--dry-run reports what it would do and writes nothing, on disk or in the table", async () => {
  const dir = scratch();
  const table = textTable(6);
  const before = table.rows.map((r) => r.value);

  const tally = await backfill.runJob(jobFor(table), options(dir, { dryRun: true }));

  assert.equal(tally.encrypted, 6);
  assert.equal(table.writes.length, 0);
  assert.deepEqual(table.rows.map((r) => r.value), before);
  assert.ok(!existsSync(join(dir, ".juno-encrypt-columns.fake.column.progress")));
});

test("the Message.activity job leaves a NULL column alone and seals the rest", async () => {
  const dir = scratch();
  const activity = [{ id: "a1", kind: "tool", title: "Searched Gmail", createdAt: "2026-09-12T10:00:00.000Z" }];
  const rows: Array<{ id: string; activity: unknown }> = [
    { id: "m-1", activity: null },
    { id: "m-2", activity },
    { id: "m-3", activity: fc.encryptJsonField(activity) },
  ];
  const jobs = backfill.buildJobs({
    message: {
      // Honours `cursor`/`take` the way Prisma does — without it the pass would
      // be handed the same page forever.
      findMany: async (args: unknown) => {
        const { cursor, take } = args as { cursor?: { id: string }; take: number };
        const start = cursor ? rows.findIndex((r) => r.id === cursor.id) + 1 : 0;
        return rows.slice(start, start + take).map((r) => ({ id: r.id, activity: r.activity as never }));
      },
      update: async (args: unknown) => {
        const { where, data } = args as { where: { id: string }; data: { activity: unknown } };
        const row = rows.find((r) => r.id === where.id);
        if (row) row.activity = data.activity;
        return row;
      },
    },
    memorySummary: { findMany: async () => [], update: async () => null },
    scheduledTask: { findMany: async () => [], update: async () => null },
  });
  const job = jobs.find((j) => j.name === "message.activity");
  assert.ok(job);

  const tally = await backfill.runJob(job, options(dir, { batch: 2 }));

  assert.equal(tally.encrypted, 1, "only the plaintext row is sealed");
  assert.equal(tally.alreadyEncrypted, 2, "NULL and already-sealed rows are skipped");
  assert.equal(rows[0].activity, null, "a NULL activity log stays NULL, never an envelope around null");
  assert.ok(fc.isEncryptedJsonField(rows[1].activity));
  assert.deepEqual(fc.decryptJsonField(rows[1].activity), activity);
});
