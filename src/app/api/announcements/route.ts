import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAnnouncement } from "@/lib/announcements";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ announcement: null });

  const now = new Date();
  const announcement = await prisma.announcement.findFirst({
    where: {
      published: true,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      dismissals: { none: { userId: user.id } },
    },
    orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }],
  });

  return NextResponse.json({ announcement: announcement ? serializeAnnouncement(announcement) : null });
}
