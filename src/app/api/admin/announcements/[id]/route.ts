import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOwnerUser } from "@/lib/admin";
import { serializeAnnouncement } from "@/lib/announcements";
import { announcementInputSchema, normalizeAnnouncementInput } from "@/lib/announcement-input";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = announcementInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const announcement = await prisma.announcement.update({
      where: { id },
      data: normalizeAnnouncementInput(parsed.data),
    });
    return NextResponse.json({ announcement: serializeAnnouncement(announcement) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.announcement.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
