import "server-only";

import { Role } from "@prisma/client";

import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { prisma } from "@/lib/prisma";
import type { LedgerHistoryPort, LedgerHistoryRow, LedgerHistorySource } from "@/lib/web/provenance";

/**
 * The two bounded history queries behind the provenance ledger (SPEC §6.2.1),
 * for a saved chat. Loaded with `await import()` by `buildUrlLedger` only when a
 * turn's first `web_fetch` needs the ledger, and never for a private chat
 * (INV-32), so neither the decryption nor the reads happen on a turn that does
 * not fetch.
 *
 * Both queries are scoped by the conversation AND its owner. The route has
 * already checked ownership; the second predicate is here so that a mistake
 * elsewhere cannot turn this into a read of somebody else's links.
 */

function sourcesOf(value: unknown): LedgerHistorySource[] {
  if (!Array.isArray(value)) return [];
  const out: LedgerHistorySource[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { url, origin } = item as { url?: unknown; origin?: unknown };
    if (typeof url !== "string" || !url) continue;
    out.push({ url, ...(typeof origin === "string" ? { origin } : {}) });
  }
  return out;
}

export function ledgerHistoryForUser(userId: string): LedgerHistoryPort {
  return {
    async userTexts(conversationId, limit) {
      const rows = await prisma.message.findMany({
        where: { conversationId, role: Role.USER, conversation: { userId } },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { content: true },
      });
      return rows.map((row) => decryptMessageTextSafe(row.content));
    },
    async assistantSources(conversationId, limit) {
      const rows = await prisma.message.findMany({
        where: { conversationId, role: Role.ASSISTANT, conversation: { userId } },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { model: true, sources: true },
      });
      return rows.map((row): LedgerHistoryRow => ({ model: row.model ?? null, sources: sourcesOf(row.sources) }));
    },
  };
}
