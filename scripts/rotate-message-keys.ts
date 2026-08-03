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
 *   npm run crypto:rotate:messages -- --dry      # report, write nothing
 *   npm run crypto:rotate:messages               # apply
 *   npm run crypto:rotate:messages -- --resume   # continue after an interruption
 *   npm run crypto:rotate:messages -- --verify   # re-read and check every row
 *
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script).
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { prismaUnguarded } from "@/lib/db";
import {
  decryptMessageText,
  isEncryptedUnderActiveKey,
  loadKeyring,
  rotateMessageText,
} from "@/lib/message-crypto";

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
      select: { id: true, content: true, reasoning: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      tally.scanned += 1;
      try {
        const nextContent = row.content ? rotateMessageText(row.content) : null;
        const nextReasoning = row.reasoning ? rotateMessageText(row.reasoning) : null;

        if (nextContent === null && nextReasoning === null) {
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

        await prismaUnguarded.message.update({
          where: { id: row.id },
          data: {
            ...(nextContent !== null ? { content: nextContent } : {}),
            ...(nextReasoning !== null ? { reasoning: nextReasoning } : {}),
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
      const rows: Array<{ id: string; content: string; reasoning: string | null }> =
        await prismaUnguarded.message.findMany({
          take: BATCH,
          ...(verifyCursor ? { skip: 1, cursor: { id: verifyCursor } } : {}),
          orderBy: { id: "asc" },
          select: { id: true, content: true, reasoning: true },
        });
      if (rows.length === 0) break;
      for (const row of rows) {
        const stale =
          (row.content && !isEncryptedUnderActiveKey(row.content)) ||
          (row.reasoning && !isEncryptedUnderActiveKey(row.reasoning));
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
