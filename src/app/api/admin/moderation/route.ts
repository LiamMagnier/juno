import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOwnerUser } from "@/lib/admin";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

type Filter = "all" | "unreviewed" | "banned";

export async function GET(req: Request) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const filterParam = (url.searchParams.get("filter") ?? "all") as Filter;
  const filter: Filter = ["all", "unreviewed", "banned"].includes(filterParam) ? filterParam : "all";

  const where: Prisma.ModerationFlagWhereInput =
    filter === "unreviewed"
      ? { reviewedAt: null }
      : filter === "banned"
        ? { action: "banned" }
        : {};

  const [flags, total] = await Promise.all([
    prisma.moderationFlag.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        userId: true,
        source: true,
        severity: true,
        category: true,
        detail: true,
        messagePreview: true,
        action: true,
        reviewedAt: true,
        reviewedBy: true,
        createdAt: true,
        user: { select: { name: true, email: true, bannedAt: true } },
      },
    }),
    prisma.moderationFlag.count({ where }),
  ]);

  return NextResponse.json({
    flags: flags.map((f) => ({
      id: f.id,
      userId: f.userId,
      source: f.source,
      severity: f.severity,
      category: f.category,
      detail: f.detail,
      messagePreview: f.messagePreview,
      action: f.action,
      reviewedAt: f.reviewedAt?.toISOString() ?? null,
      reviewedBy: f.reviewedBy,
      createdAt: f.createdAt.toISOString(),
      user: {
        name: f.user.name,
        email: f.user.email,
        bannedAt: f.user.bannedAt?.toISOString() ?? null,
      },
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
  });
}
