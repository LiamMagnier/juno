/**
 * Fills the session-recall index (src/lib/recall) for every account, newest
 * messages first, in bounded batches. Resumable and idempotent: it indexes
 * whatever is pending — never indexed, built by an older tokeniser, or under a
 * retired message key — and stops when nothing is.
 *
 *   npx tsx scripts/recall-index-backfill.ts [--user <id>] [--batch 500] [--max 100000]
 *
 * Chat turns and searches also index a bounded slice each, so an account's
 * index fills by use; this script is for the first pass and after rotations.
 */
import { PrismaClient } from "@prisma/client";
import { decryptMessageTextSafe } from "../src/lib/message-crypto";
import { recallActiveKeyId, recallHasher } from "../src/lib/recall/keys";
import { indexPendingMessages, pendingRecallCount, type RecallDeps } from "../src/lib/recall/service";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const batch = Number(arg("--batch") ?? 500);
const max = Number(arg("--max") ?? 1_000_000);

async function main() {
  const prisma = new PrismaClient();
  const deps: RecallDeps = {
    run: (statement) => prisma.$queryRaw(statement) as Promise<never[]>,
    decrypt: decryptMessageTextSafe,
    hasher: recallHasher,
    activeKeyId: recallActiveKeyId,
    unreadable: "[message could not be decrypted]",
  };
  const only = arg("--user");
  const users = only ? [{ id: only }] : await prisma.user.findMany({ select: { id: true } });
  let total = 0;
  for (const user of users) {
    let done = 0;
    while (done < max) {
      const { indexed, unreadable } = await indexPendingMessages(deps, user.id, { limit: batch });
      if (indexed === 0) break;
      done += indexed;
      if (unreadable > 0) console.warn(`[recall] ${user.id}: ${unreadable} unreadable bodies indexed as empty`);
    }
    total += done;
    const left = await pendingRecallCount(deps, user.id);
    if (done > 0 || left > 0) console.log(`[recall] ${user.id}: indexed ${done}, pending ${left}`);
  }
  console.log(`[recall] done: ${total} messages indexed across ${users.length} accounts`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
