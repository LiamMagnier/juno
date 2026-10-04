import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import {
  embedMemoryEntries,
  getMemorySummary,
  getSuppressions,
  listProjectMemorySummaries,
  sweepExpiredMemories,
} from "@/lib/memory";
import { guardedMemoryWrite } from "@/lib/memory-suppression";
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

  const [memories, summary, projectSummaries] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { userId: user.id, ...(q ? { content: { contains: q, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      select: MEMORY_ENTRY_SELECT,
    }),
    getMemorySummary(user.id),
    listProjectMemorySummaries(user.id),
  ]);
  return NextResponse.json({
    memories: memories.map(serializeMemoryEntry),
    summary: summary
      ? { content: summary.content, updatedAt: summary.updatedAt.toISOString(), entryCount: summary.entryCount }
      : null,
    // Each project's own summary. Separate from `summary` on purpose: that one
    // is what every ordinary chat reads, these are what one project's chats
    // read instead, and the page shows them as the different things they are.
    projectSummaries: projectSummaries.map((s) => ({
      projectId: s.projectId,
      projectName: s.projectName,
      content: s.content,
      updatedAt: s.updatedAt.toISOString(),
      entryCount: s.entryCount,
    })),
  });
}

// Reset memory: remove every saved fact and every consolidated summary, and mark
// all conversations as processed — "permanently erased" must mean the backfill
// won't quietly re-learn everything from old chats.
export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  // Clear ONE project's memory: its facts, its summary, and — as reset does —
  // its chats marked read, so background learning does not quietly re-learn
  // what was just cleared. Only this person's rows: in a shared project every
  // member's project memory is their own, and clearing yours touches no one
  // else's. Account-wide facts and "never remember" notes are left alone.
  const projectId = new URL(req.url).searchParams.get("projectId")?.trim();
  if (projectId) {
    await prisma.$transaction([
      prisma.memoryEntry.deleteMany({ where: { userId: user.id, projectId, kind: "FACT" } }),
      prisma.projectMemorySummary.deleteMany({ where: { userId: user.id, projectId } }),
      prisma.conversationMemory.updateMany({
        where: { userId: user.id, conversation: { projectId, userId: user.id } },
        data: { processedAt: now, factCount: 0, digest: null },
      }),
    ]);
    const uncoveredInProject = await prisma.conversation.findMany({
      where: { userId: user.id, projectId, memory: null },
      select: { id: true },
    });
    if (uncoveredInProject.length) {
      await prisma.conversationMemory.createMany({
        data: uncoveredInProject.map((c) => ({ userId: user.id, conversationId: c.id, processedAt: now })),
        skipDuplicates: true,
      });
    }
    return NextResponse.json({ ok: true, projectId });
  }
  await prisma.$transaction([
    prisma.memoryEntry.deleteMany({ where: { userId: user.id } }),
    prisma.memorySummary.deleteMany({ where: { userId: user.id } }),
    // Every project's summary too. Each is a distillation of facts this reset
    // is erasing; a "start fresh" that left them would keep quoting those
    // facts, in prose, to every chat in every project.
    prisma.projectMemorySummary.deleteMany({ where: { userId: user.id } }),
    // The edit ledger goes with the facts it edited: a "start fresh" that keeps
    // a queue of Undo-able operations against deleted rows keeps nothing useful
    // and re-surfaces content the user just erased.
    prisma.memoryEdit.deleteMany({ where: { userId: user.id } }),
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

  // Through the door, like every other write. A manual add used to skip the
  // block-list entirely, so typing back something the user had asked Juno to
  // forget quietly restored it — and nothing in the UI said the "forget" had
  // been overruled. The lifecycle fields are computed inside, so a refused
  // write never classifies or normalises a statement it is not going to store.
  const outcome = await guardedMemoryWrite({
    content,
    kind: "FACT",
    loadSuppressions: () => getSuppressions(user.id),
    write: (checked) => {
      const fields = factFields(checked, { source: "MANUAL" });
      return prisma.memoryEntry.create({
        data: {
          userId: user.id,
          content: checked,
          source: "MANUAL",
          sourceRef: "manual",
          category: parsed.data.category ?? fields.category,
          projectId: projectId ?? null,
          confidence: fields.confidence,
          normalized: fields.normalized,
          expiresAt: fields.expiresAt,
          // Typed now, so said now — what ingestion and the re-judge pass
          // compare against when something newer or older arrives.
          observedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        select: MEMORY_ENTRY_SELECT,
      });
    },
  });

  if (!outcome.ok) {
    if (outcome.reason === "empty") return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    return NextResponse.json(
      { error: outcome.message, code: "suppressed", suppression: outcome.suppression },
      { status: 409 }
    );
  }

  // Awaited, not fired-and-forgotten: a serverless process may freeze the
  // moment the response is returned. Failure inside is already swallowed —
  // the fact simply retrieves lexically until it is next restated.
  await embedMemoryEntries({ userId: user.id, rows: [{ id: outcome.value.id, content: outcome.content }] });

  return NextResponse.json({ memory: serializeMemoryEntry(outcome.value) }, { status: 201 });
}
