import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { MEMORY_EDIT_LEDGER_CAP } from "@/components/memory/memory-model";
import { ledgerOperationSchema, ledgerStatusSchema, listLedger } from "./ledger";

/*
 * The natural-language edit ledger, server-side.
 *
 * Drafted, applied and rejected memory edits used to live in localStorage,
 * which quietly gave every device its own review queue: an edit applied on the
 * laptop showed as still pending on the phone, and its Undo existed nowhere
 * else. These routes make the account the ledger's home; the page keeps the
 * exact review-before-apply flow and just stopped being the storage layer.
 */

const draftSchema = z.object({
  /** Client-generated identity — the idempotency key for retried creates. */
  clientId: z.string().min(1).max(64),
  instruction: z.string().trim().min(1).max(600),
  summary: z.string().trim().min(1).max(300).optional(),
  note: z.string().trim().min(1).max(500).optional(),
  status: ledgerStatusSchema,
  operations: z.array(ledgerOperationSchema).max(8),
  inverse: z.array(ledgerOperationSchema).max(8).optional(),
  /** Preserved on the one-time localStorage import so history keeps its dates. */
  createdAt: z.coerce.date().optional(),
});

const createSchema = z.object({
  // One create is an array of one; the localStorage import is an array of up
  // to the cap. Same endpoint so the import cannot drift from the live path.
  edits: z.array(draftSchema).min(1).max(MEMORY_EDIT_LEDGER_CAP),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ edits: await listLedger(user.id) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // skipDuplicates + the (userId, clientId) unique constraint is the whole
  // idempotency story: a retried create or a twice-run import resolves to the
  // rows that already exist instead of duplicating them.
  await prisma.memoryEdit.createMany({
    data: parsed.data.edits.map((edit) => ({
      userId: user.id,
      clientId: edit.clientId,
      instruction: edit.instruction,
      summary: edit.summary ?? null,
      note: edit.note ?? null,
      status: edit.status,
      operations: edit.operations,
      inverse: edit.inverse ?? undefined,
      ...(edit.createdAt ? { createdAt: edit.createdAt } : {}),
    })),
    skipDuplicates: true,
  });

  return NextResponse.json({ edits: await listLedger(user.id) }, { status: 201 });
}
