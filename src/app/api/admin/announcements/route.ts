import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOwnerUser } from "@/lib/admin";
import { serializeAnnouncement } from "@/lib/announcements";
import { announcementInputSchema, normalizeAnnouncementInput } from "@/lib/announcement-input";

export const runtime = "nodejs";

export async function GET() {
  const owner = await getOwnerUser();
  // 404, not 403: the rest of the admin surface refuses to confirm it exists.
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const announcements = await prisma.announcement.findMany({
    orderBy: [{ createdAt: "desc" }],
    take: 100,
  });

  return NextResponse.json({ announcements: announcements.map(serializeAnnouncement) });
}

export async function POST(req: Request) {
  const owner = await getOwnerUser();
  // 404, not 403: the rest of the admin surface refuses to confirm it exists.
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = announcementInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const data = normalizeAnnouncementInput(parsed.data);
    const announcement = await prisma.announcement.create({
      data: { ...data, createdById: owner.id },
    });
    return NextResponse.json({ announcement: serializeAnnouncement(announcement) }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }
}
