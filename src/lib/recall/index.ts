import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { recallActiveKeyId, recallHasher } from "@/lib/recall/keys";
import type { RecallDeps } from "@/lib/recall/service";

/** The undecryptable placeholder decryptMessageTextSafe returns (pinned by tests/unified-search.test.ts). */
const UNREADABLE = "[message could not be decrypted]";

/** The production bindings: Prisma raw SQL, the message keyring, HMAC. */
export const recallDeps: RecallDeps = {
  run: (statement) => prisma.$queryRaw(statement) as Promise<never[]>,
  decrypt: decryptMessageTextSafe,
  hasher: recallHasher,
  activeKeyId: recallActiveKeyId,
  unreadable: UNREADABLE,
};

export { indexPendingMessages, pendingRecallCount, searchRecall } from "@/lib/recall/service";
