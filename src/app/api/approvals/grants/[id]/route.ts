import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** Narrowing takes effect at once. No unowned id can disclose or change a grant. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const result = await prisma.actionApprovalGrant.updateMany({
    where: { id, userId: user.id, revokedAt: null }, data: { revokedAt: new Date() },
  });
  if (result.count === 0) return NextResponse.json({ error: "Grant not found" }, { status: 404 });
  return NextResponse.json({ revoked: true }, { headers: { "Cache-Control": "private, no-store" } });
}
