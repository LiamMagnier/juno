import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.announcementDismissal.upsert({
    where: { userId_announcementId: { userId: user.id, announcementId: id } },
    create: { userId: user.id, announcementId: id },
    update: { dismissedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
