import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, userId: user.id },
    include: {
      conversations: {
        orderBy: { lastMessageAt: "desc" },
        select: { id: true, title: true, lastMessageAt: true, pinned: true },
      },
      files: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      instructions: project.instructions,
      starred: project.starred,
      updatedAt: project.updatedAt.toISOString(),
    },
    conversations: project.conversations.map((c) => ({
      id: c.id,
      title: c.title,
      pinned: c.pinned,
      lastMessageAt: c.lastMessageAt.toISOString(),
    })),
    files: await Promise.all(project.files.map((f) => serializeAttachment(f))),
  });
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().max(20_000).optional(),
  starred: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const data = {
    ...parsed.data,
    ...(parsed.data.name != null ? { nameSource: "manual" } : {}),
  };
  await prisma.project.update({ where: { id, userId: user.id }, data });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Conversations are kept (projectId set null); project files cascade-delete.
  await prisma.project.delete({ where: { id, userId: user.id } });
  return NextResponse.json({ ok: true });
}
