import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getMemorySummary, sweepExpiredMemories } from "@/lib/memory";
import { MEMORY_CATEGORIES } from "@/lib/memory-categories";
import { factFields } from "@/lib/memory-lifecycle";
import { MEMORY_ENTRY_SELECT, serializeMemoryEntry } from "@/lib/memory-view";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = new URL(req.url).searchParams.get("q")?.trim();

  // Retire anything whose moment has passed before listing. Retrieval already
  // refuses expired entries, so this is not what protects the model — it is
  // what stops the page claiming Juno still believes last quarter's deadline.
  // Best effort: a failed sweep must not cost the user the page.
  await sweepExpiredMemories(user.id).catch((error) => {
    console.error("[memory] expiry sweep failed:", error instanceof Error ? error.message : error);
  });

  const [memories, summary] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { userId: user.id, ...(q ? { content: { contains: q, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      select: MEMORY_ENTRY_SELECT,
    }),
    getMemorySummary(user.id),
  ]);
  return NextResponse.json({
    memories: memories.map(serializeMemoryEntry),
    summary: summary
      ? { content: summary.content, updatedAt: summary.updatedAt.toISOString(), entryCount: summary.entryCount }
      : null,
  });
}

// Reset memory: remove every saved fact and the consolidated summary, and mark
// all conversations as processed — "permanently erased" must mean the backfill
// won't quietly re-learn everything from old chats.
export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  await prisma.$transaction([
    prisma.memoryEntry.deleteMany({ where: { userId: user.id } }),
    prisma.memorySummary.deleteMany({ where: { userId: user.id } }),
    prisma.conversationMemory.updateMany({
      where: { userId: user.id },
      data: { processedAt: now, factCount: 0, digest: null },
    }),
  ]);
  const uncovered = await prisma.conversation.findMany({
    where: { userId: user.id, memory: null },
    select: { id: true },
  });
  if (uncovered.length) {
    await prisma.conversationMemory.createMany({
      data: uncovered.map((c) => ({ userId: user.id, conversationId: c.id, processedAt: now })),
    });
  }
  return NextResponse.json({ ok: true });
}

const schema = z.object({
  content: z.string().trim().min(1).max(500),
  /** Override the classifier when the user files it themselves. */
  category: z.enum(MEMORY_CATEGORIES).optional(),
  /** Scope it to one project, so it stays out of unrelated chats. */
  projectId: z.string().min(1).nullish(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { content, projectId } = parsed.data;

  // A projectId from the client is an ownership claim until proven otherwise —
  // scoping a memory to someone else's project would make it unreachable and
  // leak the id's existence.
  if (projectId) {
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const fields = factFields(content, { source: "MANUAL" });
  const memory = await prisma.memoryEntry.create({
    data: {
      userId: user.id,
      content,
      source: "MANUAL",
      sourceRef: "manual",
      category: parsed.data.category ?? fields.category,
      projectId: projectId ?? null,
      confidence: fields.confidence,
      normalized: fields.normalized,
      expiresAt: fields.expiresAt,
      lastVerifiedAt: new Date(),
    },
    select: MEMORY_ENTRY_SELECT,
  });
  return NextResponse.json({ memory: serializeMemoryEntry(memory) }, { status: 201 });
}
