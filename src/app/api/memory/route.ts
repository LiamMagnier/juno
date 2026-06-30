import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getMemorySummary } from "@/lib/memory";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = new URL(req.url).searchParams.get("q")?.trim();
  const [memories, summary] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { userId: user.id, ...(q ? { content: { contains: q, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      select: { id: true, content: true, source: true, createdAt: true },
    }),
    getMemorySummary(user.id),
  ]);
  return NextResponse.json({
    memories: memories.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    summary: summary
      ? { content: summary.content, updatedAt: summary.updatedAt.toISOString(), entryCount: summary.entryCount }
      : null,
  });
}

const schema = z.object({ content: z.string().trim().min(1).max(500) });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const memory = await prisma.memoryEntry.create({
    data: { userId: user.id, content: parsed.data.content, source: "MANUAL" },
    select: { id: true, content: true, source: true, createdAt: true },
  });
  return NextResponse.json({ memory: { ...memory, createdAt: memory.createdAt.toISOString() } }, { status: 201 });
}
