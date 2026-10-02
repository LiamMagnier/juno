/**
 * `persistArtifacts` with the transaction parameter the research completion
 * needs (SPEC §9.6.3 item 2, INV-14).
 *
 * `src/lib/artifacts-store.ts` belongs to the artifacts lifecycle work
 * (`artifacts/r1-lifecycle`), which will expose
 *
 *   persistArtifacts(conversationId, messageId, parsed, opts?: { tx?: Prisma.TransactionClient })
 *
 * Until that lands the store takes three arguments, ignores `opts`, and writes
 * through the global client — OUTSIDE any transaction. An artifact row whose
 * `messageId` names a message still uncommitted inside the completion's
 * transaction cannot be written from outside it (the foreign key does not see
 * the row), so `ARTIFACTS_STORE_TAKES_TX` is false and `completion.ts` writes
 * the report artifact right after its transaction commits instead. When r1
 * lands, flip the flag: the call below already passes `{ tx }`.
 */

import type { Prisma } from "@prisma/client";
import { persistArtifacts } from "@/lib/artifacts-store";
import type { ParsedArtifact } from "@/lib/message-content";
import type { ClientArtifact } from "@/types/chat";

export type PersistArtifactsWithTx = (
  conversationId: string,
  messageId: string,
  parsed: ParsedArtifact[],
  opts?: { tx?: Prisma.TransactionClient }
) => Promise<ClientArtifact[]>;

/** The store's function at the signature r1 exposes. Today `opts` is ignored. */
export const persistArtifactsWithTx: PersistArtifactsWithTx = persistArtifacts as PersistArtifactsWithTx;

/** Whether `persistArtifactsWithTx` honours `opts.tx`. False until `artifacts/r1-lifecycle` lands. */
export const ARTIFACTS_STORE_TAKES_TX = false;
