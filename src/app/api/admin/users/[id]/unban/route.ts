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
  // Ids, not emails: PM2 log files are plaintext, unrotated and rsynced around.
  // The durable audit record written by unbanUser() keeps the actor.
  console.log(`[admin] unban by ${owner.id}: ${user.id}`);

  return NextResponse.json({ ok: true });
}
