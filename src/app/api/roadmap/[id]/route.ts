import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { isOwnerEmail } from "@/lib/owner";
import { FEATURE_CATEGORIES, FEATURE_STATUSES } from "@/lib/roadmap";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const r = await prisma.featureRequest.findUnique({
    where: { id },
    include: {
      author: { select: { id: true, name: true } },
      _count: { select: { votes: true } },
      votes: { where: { userId: user.id }, select: { id: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { id: true, name: true } } },
      },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    request: {
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
      hasVoted: r.votes.length > 0,
    },
    comments: r.comments.map((c) => ({
      id: c.id,
      body: c.body,
      official: c.official,
      createdAt: c.createdAt.toISOString(),
      author: c.author,
    })),
    events: r.events.map((e) => ({
      id: e.id,
      status: e.status,
      note: e.note,
      createdAt: e.createdAt.toISOString(),
    })),
    isOwner: isOwnerEmail(user.email),
  });
}

const patchSchema = z.object({
  status: z.enum(FEATURE_STATUSES).optional(),
  statusNote: z.string().trim().max(280).optional(),
  pinned: z.boolean().optional(),
  declineReason: z.string().trim().max(280).nullable().optional(),
  category: z.enum(FEATURE_CATEGORIES).optional(),
  title: z.string().trim().min(4).max(120).optional(),
  description: z.string().trim().min(10).max(4000).optional(),
});

// Moderation — OWNER only.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOwnerEmail(user.email)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const existing = await prisma.featureRequest.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { status, statusNote, pinned, declineReason, category, title, description } = parsed.data;
  const statusChanged = status != null && status !== existing.status;

  await prisma.featureRequest.update({
    where: { id },
    data: {
      ...(status != null ? { status } : {}),
      ...(pinned != null ? { pinned } : {}),
      ...(declineReason !== undefined ? { declineReason } : {}),
      ...(category != null ? { category } : {}),
      ...(title != null ? { title } : {}),
      ...(description != null ? { description } : {}),
      // Log a timeline event whenever the status actually moves.
      ...(statusChanged
        ? { events: { create: { status: status!, note: statusNote || declineReason || null } } }
        : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
