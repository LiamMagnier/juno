import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { consolidateWithFallback, getMemorySummary } from "@/lib/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

// `before` is the fact text the edit was drafted against — verified below so a
// stale edit can never silently clobber changes made in the meantime.
const opSchema = z.union([
  z.object({ op: z.literal("add"), content: z.string().trim().min(1).max(500), suppress: z.boolean().optional() }),
  z.object({ op: z.literal("update"), id: z.string().min(1), before: z.string().max(500), content: z.string().trim().min(1).max(500) }),
  z.object({ op: z.literal("remove"), id: z.string().min(1), before: z.string().max(500) }),
]);
const bodySchema = z.object({ operations: z.array(opSchema).min(1).max(8) });

type Operation = z.infer<typeof opSchema> & { before?: string; suppress?: boolean };

/**
 * Apply an accepted memory edit: run the operations, re-consolidate the summary,
 * and return the fresh state plus the inverse operations (for Undo).
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const ops = parsed.data.operations;

  // One operation per fact — two ops on the same id would make the inverse
  // (undo) sequence ambiguous.
  const referencedIds = ops.flatMap((o) => (o.op === "add" ? [] : [o.id]));
  if (new Set(referencedIds).size !== referencedIds.length) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  // Every referenced fact must still exist, belong to the user, and read exactly
  // as it did when the edit was drafted — otherwise the edit is stale.
  const referenced = referencedIds.length
    ? await prisma.memoryEntry.findMany({
        where: { id: { in: referencedIds }, userId: user.id },
        select: { id: true, content: true, kind: true },
      })
    : [];
  const byId = new Map(referenced.map((f) => [f.id, f]));
  const stale = ops.some((o) => o.op !== "add" && byId.get(o.id)?.content !== o.before);
  if (stale) {
    return NextResponse.json(
      { error: "Your memory changed since this edit was drafted. Delete it and ask again." },
      { status: 409 }
    );
  }

  const inverse: Operation[] = [];
  await prisma.$transaction(async (tx) => {
    for (const op of ops) {
      if (op.op === "add") {
        const created = await tx.memoryEntry.create({
          data: {
            userId: user.id,
            content: op.content,
            source: "MANUAL",
            kind: op.suppress ? "SUPPRESSION" : "FACT",
            sourceRef: "edit",
          },
          select: { id: true },
        });
        inverse.push({ op: "remove", id: created.id, before: op.content });
      } else if (op.op === "update") {
        const before = byId.get(op.id)!.content;
        await tx.memoryEntry.update({ where: { id: op.id, userId: user.id }, data: { content: op.content } });
        inverse.push({ op: "update", id: op.id, before: op.content, content: before });
      } else {
        const row = byId.get(op.id)!;
        await tx.memoryEntry.delete({ where: { id: op.id, userId: user.id } });
        // Undoing the removal must restore the same KIND (a deleted suppression
        // comes back as a suppression, not as a fact).
        inverse.push({ op: "add", content: row.content, ...(row.kind === "SUPPRESSION" ? { suppress: true } : {}) });
      }
    }
  });
  inverse.reverse();

  // Re-consolidate so the summary reflects the change. Best effort and bounded —
  // this blocks the user's Accept/Undo click, so don't walk the whole provider
  // list. If it fails, the facts are still updated and the old summary stays
  // until the next consolidation.
  await consolidateWithFallback(user.id, 3).catch(() => {});

  const [memories, summary] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, content: true, source: true, kind: true, sourceRef: true, createdAt: true },
    }),
    getMemorySummary(user.id),
  ]);

  return NextResponse.json({
    memories: memories.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    summary: summary
      ? { content: summary.content, updatedAt: summary.updatedAt.toISOString(), entryCount: summary.entryCount }
      : null,
    inverse,
  });
}
