import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOwnerUser } from "@/lib/admin";
import { isOwnerEmail } from "@/lib/owner";
import { banUser } from "@/lib/moderation";

export const runtime = "nodejs";

const bodySchema = z.object({ reason: z.string().min(3).max(500) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (user.id === owner.id || isOwnerEmail(user.email)) {
    return NextResponse.json({ error: "cannot ban an owner" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A reason of 3–500 characters is required." }, { status: 400 });
  }

  await banUser(id, parsed.data.reason, owner.email!);
  console.log(`[admin] ban by ${owner.email}: ${user.email}`);

  return NextResponse.json({ ok: true });
}
