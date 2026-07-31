import { NextResponse } from "next/server";
import { z } from "zod";
import { prismaUnguarded } from "@/lib/prisma";
import { getOwnerUser } from "@/lib/admin";

export const runtime = "nodejs";

const patchSchema = z.object({ reviewed: z.boolean() });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  // Unguarded by design: the owner reviews other users' flags, so the flag is
  // addressed by its own id and never by the reviewer's (getOwnerUser gates it).
  const flag = await prismaUnguarded.moderationFlag.findUnique({ where: { id }, select: { id: true } });
  if (!flag) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const updated = await prismaUnguarded.moderationFlag.update({
    where: { id },
    data: parsed.data.reviewed
      ? { reviewedAt: new Date(), reviewedBy: owner.email! }
      : { reviewedAt: null, reviewedBy: null },
    select: { reviewedAt: true, reviewedBy: true },
  });

  return NextResponse.json({
    ok: true,
    reviewedAt: updated.reviewedAt?.toISOString() ?? null,
    reviewedBy: updated.reviewedBy,
  });
}
