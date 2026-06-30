import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import { FEATURE_CATEGORIES, FEATURE_STATUSES, type RoadmapRequest } from "@/lib/roadmap";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const q = sp.get("q")?.trim();
  const status = sp.get("status");
  const category = sp.get("category");
  const sort = sp.get("sort") ?? "top";

  const where: Prisma.FeatureRequestWhereInput = {};
  if (status && FEATURE_STATUSES.includes(status as never)) where.status = status as never;
  if (category && FEATURE_CATEGORIES.includes(category as never)) where.category = category as never;
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
    ];
  }

  const rows = await prisma.featureRequest.findMany({
    where,
    include: {
      author: { select: { id: true, name: true } },
      _count: { select: { votes: true, comments: true } },
      votes: { where: { userId: user.id }, select: { id: true } },
    },
    // Pinned first; then a reasonable default — re-sorted below for "top"/"trending".
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  let items: RoadmapRequest[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    status: r.status,
    pinned: r.pinned,
    declineReason: r.declineReason,
    createdAt: r.createdAt.toISOString(),
    author: r.author,
    voteCount: r._count.votes,
    commentCount: r._count.comments,
    hasVoted: r.votes.length > 0,
  }));

  if (sort === "top") {
    items = items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.voteCount - a.voteCount);
  } else if (sort === "trending") {
    // Votes weighted by recency (gravity), classic HN-ish ranking.
    const score = (r: RoadmapRequest) =>
      (r.voteCount + 1) / Math.pow((Date.now() - new Date(r.createdAt).getTime()) / 3.6e6 + 2, 1.5);
    items = items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b) - score(a));
  }
  // "new" keeps the createdAt desc order from the query.

  return NextResponse.json({ requests: items, isOwner: isOwnerEmail(user.email) });
}

const createSchema = z.object({
  title: z.string().trim().min(4).max(120),
  description: z.string().trim().min(10).max(4000),
  category: z.enum(FEATURE_CATEGORIES).default("OTHER"),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `roadmap:create:${user.id}`, limit: 8, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "You're submitting a lot of requests — try again later." }, { status: 429 });
  }

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const created = await prisma.featureRequest.create({
    data: {
      authorId: user.id,
      title: parsed.data.title,
      description: parsed.data.description,
      category: parsed.data.category,
      // Author implicitly upvotes their own request, and we log the first status.
      votes: { create: { userId: user.id } },
      events: { create: { status: "UNDER_REVIEW", note: "Submitted" } },
    },
    select: { id: true },
  });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
