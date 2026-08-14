import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ledgerOperationSchema, ledgerStatusSchema, listLedger } from "../ledger";

/*
 * One ledger record: status flips (applied ⇄ pending on Undo, → rejected on a
 * stale draft), the operations/inverse swap an Undo performs, and deletion.
 * Every answer is the canonical list — see ledger.ts.
 */

const patchSchema = z
  .object({
    status: ledgerStatusSchema.optional(),
    note: z.string().trim().min(1).max(500).optional(),
    operations: z.array(ledgerOperationSchema).max(8).optional(),
    // null clears the inverse — an undone edit no longer has one.
    inverse: z.array(ledgerOperationSchema).max(8).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change" });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  // updateMany, not update: the where carries the ownership check, and a count
  // of zero is an honest 404 rather than a thrown P2025.
  const { count } = await prisma.memoryEdit.updateMany({
    where: { id, userId: user.id },
    data: {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.operations !== undefined ? { operations: body.operations } : {}),
      // JSON columns distinguish "leave alone" (undefined) from "clear"
      // (DbNull) — a plain null would be swallowed by the spread.
      ...(body.inverse !== undefined
        ? { inverse: body.inverse === null ? Prisma.DbNull : body.inverse }
        : {}),
    },
  });
  if (count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ edits: await listLedger(user.id) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { count } = await prisma.memoryEdit.deleteMany({ where: { id, userId: user.id } });
  if (count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ edits: await listLedger(user.id) });
}
