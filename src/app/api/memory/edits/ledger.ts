import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { MEMORY_EDIT_LEDGER_CAP } from "@/components/memory/memory-model";

/*
 * Shared half of the /api/memory/edits routes: the operation schema and the
 * canonical list every mutation answers with.
 *
 * Every handler returns the same capped, newest-first list rather than the row
 * it touched, so the page never merges server state with its own guess — the
 * exact class of divergence that made the localStorage ledger untrustworthy.
 */

/** Mirrors the apply route's opSchema — an edit stored here must be replayable
 *  there verbatim, so the two shapes are deliberately identical. */
export const ledgerOperationSchema = z.union([
  z.object({ op: z.literal("add"), content: z.string().trim().min(1).max(500), suppress: z.boolean().optional() }),
  z.object({
    op: z.literal("update"),
    id: z.string().min(1),
    before: z.string().max(500),
    content: z.string().trim().min(1).max(500),
  }),
  z.object({ op: z.literal("remove"), id: z.string().min(1), before: z.string().max(500) }),
]);

export const ledgerStatusSchema = z.enum(["pending", "applied", "rejected"]);

const EDIT_SELECT = {
  id: true,
  instruction: true,
  summary: true,
  note: true,
  status: true,
  operations: true,
  inverse: true,
  createdAt: true,
} as const;

type EditRow = {
  id: string;
  instruction: string;
  summary: string | null;
  note: string | null;
  status: string;
  operations: unknown;
  inverse: unknown;
  createdAt: Date;
};

function serializeEdit(row: EditRow) {
  return {
    id: row.id,
    instruction: row.instruction,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.note ? { note: row.note } : {}),
    status: row.status,
    operations: row.operations ?? [],
    ...(row.inverse ? { inverse: row.inverse } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The canonical ledger: newest first, trimmed to the cap. Trimming happens on
 * read rather than only on write so a ledger grown past the cap by the
 * localStorage import (or a concurrent tab) settles back without a sweeper.
 */
export async function listLedger(userId: string) {
  const rows = await prisma.memoryEdit.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: EDIT_SELECT,
  });
  if (rows.length > MEMORY_EDIT_LEDGER_CAP) {
    const excess = rows.slice(MEMORY_EDIT_LEDGER_CAP);
    await prisma.memoryEdit
      .deleteMany({ where: { userId, id: { in: excess.map((row) => row.id) } } })
      .catch(() => {
        // A failed trim only defers itself to the next read.
      });
  }
  return rows.slice(0, MEMORY_EDIT_LEDGER_CAP).map(serializeEdit);
}
