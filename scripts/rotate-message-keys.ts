/**
 * Re-encrypt stored message bodies under the active data-encryption key.
 *
 * Online, resumable and idempotent by construction:
 *   - online     — batched cursor pagination, one small transaction per row, so
 *                  the app keeps serving while it runs;
 *   - resumable  — the cursor is written to a progress file after every batch,
 *                  and `--resume` picks it back up. A kill mid-run costs at
 *                  most one batch of re-reads, never data;
 *   - idempotent — a row already under the active key is skipped without a
 *                  write, so re-running over covered ground does nothing.
 *
 * Both previous and active keys must be on DATA_ENCRYPTION_KEYRING while this
 * runs: rows written under the old key have to stay readable until the pass
 * that rewrites them has finished.
 *
 * It covers every column sealed with the message keyring, not only the message
 * body: `Message.content` / `Message.reasoning` AND the columns added by
 * src/lib/field-crypto.ts — `Message.activity`, `MemorySummary.content` and
 * `ScheduledTask.prompt`. That is the whole reason field-crypto delegates to
 * this keyring instead of owning one: a rotation stays a single operation
 * rather than one per column, and no column can be quietly left behind under a
 * key the operator believes they have retired.
 *
 *   npm run crypto:rotate:messages -- --dry      # report, write nothing
 *   npm run crypto:rotate:messages               # apply
 *   npm run crypto:rotate:messages -- --resume   # continue after an interruption
 *   npm run crypto:rotate:messages -- --verify   # re-read and check every row
 *
 * Plaintext rows are brought under encryption as they are met, so this doubles
 * as a slower backfill — but scripts/encrypt-columns.ts is the one to reach for
 * when that is the whole job: it is per-column and does not rewrite rows that
 * are already current.
 *
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script).
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { prismaUnguarded } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  decryptMessageText,
  isEncryptedUnderActiveKey,
  loadKeyring,
  rotateMessageText,
} from "@/lib/message-crypto";
import { decryptJsonField, encryptJsonField, isEncryptedJsonField } from "@/lib/field-crypto";

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const RESUME = process.argv.includes("--resume");
const VERIFY = process.argv.includes("--verify");
const BATCH = 500;
const PROGRESS_FILE = ".juno-message-rotation.progress";

interface Tally {
  scanned: number;
  rewritten: number;
  alreadyCurrent: number;
  failed: number;
  verified: number;
}

function readCursor(): string | null {
  if (!RESUME || !existsSync(PROGRESS_FILE)) return null;
  const raw = readFileSync(PROGRESS_FILE, "utf8").trim();
  return raw.length > 0 ? raw : null;
}

function writeCursor(id: string): void {
  if (DRY) return;
  writeFileSync(PROGRESS_FILE, id, "utf8");
}

function clearCursor(): void {
  if (!DRY && existsSync(PROGRESS_FILE)) unlinkSync(PROGRESS_FILE);
}

/**
 * Re-seal `Message.activity` under the active key.
 *
 * Returns null when there is nothing to write — NULL column, or already under
 * the active key — which is what keeps the pass idempotent for this column
 * exactly as `rotateMessageText` does for the text ones. Plaintext left by a
 * backfill that has not reached this row yet is sealed here, so a rotation can
 * never leave a column half covered.
 *
 * An unreadable payload THROWS (via rotateMessageText → decryptMessageText)
 * rather than degrading: the caller's try/catch counts the row as failed and
 * leaves it exactly as it was, which is the only safe outcome. Using
 * field-crypto's lenient reader here would rewrite an unreadable row as `null`
 * and destroy it.
 */
function rotateActivity(stored: Prisma.JsonValue | null): Prisma.InputJsonValue | null {
  if (stored == null) return null;
  if (!isEncryptedJsonField(stored)) return encryptJsonField(stored) as unknown as Prisma.InputJsonValue;
  const next = rotateMessageText(stored.enc);
  return next === null ? null : { enc: next };
}

/** The encrypted payload inside a `Json` column, for the staleness check. */
function activityPayload(stored: Prisma.JsonValue | null): string | null {
  return isEncryptedJsonField(stored) ? stored.enc : null;
}

interface TextColumnPass {
  page(cursor: string | null): Promise<Array<{ id: string; value: string }>>;
  write(id: string, value: string): Promise<unknown>;
}

/**
 * One cursor pass over a text column sealed with this keyring, sharing the
 * caller's tally so the final line still reports the whole rotation.
 *
 * Same three properties as the message pass, for the same reasons:
 * `rotateMessageText` returns null for a row already under the active key
 * (idempotent), the plaintext is compared before the write (a bad key fails
 * here, not at read time), and one bad row is counted rather than fatal.
 */
async function rotateTextColumn(label: string, tally: Tally, pass: TextColumnPass): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const rows = await pass.page(cursor);
    if (rows.length === 0) break;
    for (const row of rows) {
      tally.scanned += 1;
      try {
        const next = rotateMessageText(row.value);
        if (next === null) {
          tally.alreadyCurrent += 1;
          continue;
        }
        if (DRY) {
          tally.rewritten += 1;
          continue;
        }
        if (decryptMessageText(next) !== decryptMessageText(row.value)) {
          throw new Error("re-encrypted value did not round-trip");
        }
        await pass.write(row.id, next);
        tally.rewritten += 1;
      } catch (err) {
        tally.failed += 1;
        console.error(
          `[rotate] ${label} ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    cursor = rows[rows.length - 1].id;
  }
  console.log(`[rotate] ${label}: pass complete`);
}

async function main(): Promise<void> {
  const keyring = loadKeyring();
  if (keyring.derived) {
    // Rotating onto a key derived from AUTH_SECRET would rewrite the whole
    // database under a key that changes whenever the auth secret does.
    throw new Error(
      "Refusing to rotate onto an AUTH_SECRET-derived key. Configure DATA_ENCRYPTION_KEYRING first."
    );
  }
  console.log(
    `[rotate] active key '${keyring.activeKeyId}', ${keyring.keys.size} key(s) on the ring` +
      `${DRY ? " — DRY RUN, nothing will be written" : ""}`
  );

  const tally: Tally = { scanned: 0, rewritten: 0, alreadyCurrent: 0, failed: 0, verified: 0 };
  let cursor = readCursor();
  if (cursor) console.log(`[rotate] resuming after message ${cursor}`);

  for (;;) {
    const rows = await prismaUnguarded.message.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true, content: true, reasoning: true, activity: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      tally.scanned += 1;
      try {
        const nextContent = row.content ? rotateMessageText(row.content) : null;
        const nextReasoning = row.reasoning ? rotateMessageText(row.reasoning) : null;
        // The tool-activity log is sealed with the same keyring (field-crypto.ts),
        // so it rotates in the same pass and under the same row lock. Rotating
        // it separately would leave a window where content and activity sat
        // under different keys with no record of which rows were which.
        const nextActivity = rotateActivity(row.activity);

        if (nextContent === null && nextReasoning === null && nextActivity === null) {
          tally.alreadyCurrent += 1;
          continue;
        }
        if (DRY) {
          tally.rewritten += 1;
          continue;
        }

        // Verify before committing: decrypting the *new* payload and comparing
        // against the old plaintext is what makes a bad key or a truncated
        // write fail here rather than at read time, months later.
        if (nextContent !== null && decryptMessageText(nextContent) !== decryptMessageText(row.content)) {
          throw new Error("re-encrypted content did not round-trip");
        }
        if (
          nextReasoning !== null &&
          decryptMessageText(nextReasoning) !== decryptMessageText(row.reasoning)
        ) {
          throw new Error("re-encrypted reasoning did not round-trip");
        }
        if (
          nextActivity !== null &&
          JSON.stringify(decryptJsonField(nextActivity)) !== JSON.stringify(decryptJsonField(row.activity))
        ) {
          throw new Error("re-encrypted activity did not round-trip");
        }

        await prismaUnguarded.message.update({
          where: { id: row.id },
          data: {
            ...(nextContent !== null ? { content: nextContent } : {}),
            ...(nextReasoning !== null ? { reasoning: nextReasoning } : {}),
            ...(nextActivity !== null ? { activity: nextActivity } : {}),
          },
        });
        tally.rewritten += 1;
      } catch (err) {
        // One unreadable row must not stop the pass: it is recorded, the cursor
        // still advances, and the operator gets a count to investigate.
        tally.failed += 1;
        console.error(
          `[rotate] message ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    cursor = rows[rows.length - 1].id;
    writeCursor(cursor);
    console.log(
      `[rotate] ${tally.scanned} scanned, ${tally.rewritten} rewritten, ` +
        `${tally.alreadyCurrent} already current, ${tally.failed} failed`
    );
  }

  if (VERIFY) {
    console.log("[rotate] verifying…");
    let verifyCursor: string | null = null;
    for (;;) {
      const rows: Array<{
        id: string;
        content: string;
        reasoning: string | null;
        activity: Prisma.JsonValue | null;
      }> = await prismaUnguarded.message.findMany({
        take: BATCH,
        ...(verifyCursor ? { skip: 1, cursor: { id: verifyCursor } } : {}),
        orderBy: { id: "asc" },
        select: { id: true, content: true, reasoning: true, activity: true },
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        const activityEnc = activityPayload(row.activity);
        const stale =
          (row.content && !isEncryptedUnderActiveKey(row.content)) ||
          (row.reasoning && !isEncryptedUnderActiveKey(row.reasoning)) ||
          // A non-NULL activity that carries no envelope at all is stale too:
          // it is plaintext this pass was supposed to have sealed.
          (row.activity != null && activityEnc === null) ||
          (activityEnc !== null && !isEncryptedUnderActiveKey(activityEnc));
        if (stale) {
          tally.failed += 1;
          console.error(`[rotate] message ${row.id} is still not under the active key`);
        } else {
          tally.verified += 1;
        }
      }
      verifyCursor = rows[rows.length - 1].id;
    }
  }

  // The other columns sealed with this keyring. Small tables (one summary per
  // account, a handful of tasks each) so they get one straight pass rather
  // than their own cursor file — the message table is the only one where an
  // interruption is expensive enough to be worth resuming.
  await rotateTextColumn("MemorySummary.content", tally, {
    page: async (cursor) => {
      const rows = await prismaUnguarded.memorySummary.findMany({
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: { id: true, content: true },
      });
      return rows.map((r) => ({ id: r.id, value: r.content }));
    },
    write: (id, value) => prismaUnguarded.memorySummary.update({ where: { id }, data: { content: value } }),
  });
  await rotateTextColumn("ScheduledTask.prompt", tally, {
    page: async (cursor) => {
      const rows = await prismaUnguarded.scheduledTask.findMany({
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: { id: true, prompt: true },
      });
      return rows.map((r) => ({ id: r.id, value: r.prompt }));
    },
    write: (id, value) => prismaUnguarded.scheduledTask.update({ where: { id }, data: { prompt: value } }),
  });

  if (tally.failed === 0) clearCursor();

  console.log(
    `\n[rotate] done — scanned ${tally.scanned}, rewritten ${tally.rewritten}, ` +
      `already current ${tally.alreadyCurrent}, verified ${tally.verified}, failed ${tally.failed}`
  );
  if (tally.failed > 0) {
    console.error(
      "[rotate] some rows failed. The progress file is kept so a re-run resumes rather than restarting."
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prismaUnguarded.$disconnect());
