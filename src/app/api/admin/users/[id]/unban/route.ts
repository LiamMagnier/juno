import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOwnerUser } from "@/lib/admin";
import { unbanUser } from "@/lib/moderation";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await unbanUser(id, owner.email!);
  console.log(`[admin] unban by ${owner.email}: ${user.email}`);

  return NextResponse.json({ ok: true });
}
