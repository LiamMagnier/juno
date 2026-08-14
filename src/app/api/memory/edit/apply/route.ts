import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { consolidateWithFallback, embedMemoryEntries, getMemorySummary } from "@/lib/memory";
import { guardedMemoryWrite, type MemoryWriteRefusal } from "@/lib/memory-suppression";
import { factFields } from "@/lib/memory-lifecycle";
import { MEMORY_ENTRY_SELECT, serializeMemoryEntry } from "@/lib/memory-view";

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
  // Facts this edit wrote or rewrote, owed a vector once the transaction holds.
  const touched: { id: string; content: string }[] = [];
  // A refused write aborts the whole edit rather than applying the rest of it:
  // these operations are one intent ("swap my job for the new one"), and a
  // half-applied intent is worse than a rejected one. The throw rolls the
  // transaction back; the refusal is reported outside it.
  let refusal: MemoryWriteRefusal | null = null;
  class SuppressedWrite extends Error {}

  try {
    await prisma.$transaction(async (tx) => {
      // The block-list is read inside the transaction, so an op that ADDS a
      // suppression in this same batch is enforced against the ops after it.
      const suppressions = async () =>
        (
          await tx.memoryEntry.findMany({
            where: { userId: user.id, kind: "SUPPRESSION" },
            select: { content: true },
          })
        ).map((r) => r.content);

      for (const op of ops) {
        if (op.op === "add") {
          // Applied edits wrote straight to the table, so "forget my old job"
          // followed by any instruction that re-stated it put it right back.
          const outcome = await guardedMemoryWrite({
            content: op.content,
            kind: op.suppress ? "SUPPRESSION" : "FACT",
            loadSuppressions: suppressions,
            write: (content) => {
              // Classified and normalized on the same path as every other write:
              // a fact added by an edit that carried no category would show up as
              // "Uncategorised" and, worse, be invisible to duplicate detection.
              const fields = factFields(content, { source: "MANUAL" });
              return tx.memoryEntry.create({
                data: {
                  userId: user.id,
                  content,
                  source: "MANUAL",
                  kind: op.suppress ? "SUPPRESSION" : "FACT",
                  sourceRef: "edit",
                  category: op.suppress ? "suppression" : fields.category,
                  confidence: fields.confidence,
                  normalized: fields.normalized,
                  expiresAt: op.suppress ? null : fields.expiresAt,
                  lastVerifiedAt: new Date(),
                },
                select: { id: true },
              });
            },
          });
          if (!outcome.ok) {
            refusal = outcome;
            throw new SuppressedWrite();
          }
          // Suppressions are matched by their normalized text, never by vector.
          if (!op.suppress) touched.push({ id: outcome.value.id, content: outcome.content });
          inverse.push({ op: "remove", id: outcome.value.id, before: op.content });
        } else if (op.op === "update") {
          const row = byId.get(op.id)!;
          const outcome = await guardedMemoryWrite({
            content: op.content,
            kind: row.kind,
            loadSuppressions: suppressions,
            write: (content) => {
              const fields = factFields(content, { source: "MANUAL" });
              return tx.memoryEntry.update({
                where: { id: op.id, userId: user.id },
                data: {
                  content,
                  category: fields.category,
                  confidence: fields.confidence,
                  normalized: fields.normalized,
                  expiresAt: fields.expiresAt,
                  // An edited fact is believed again: a row the user just
                  // rewrote is not still "replaced by something newer".
                  status: "active",
                  reason: null,
                  supersededById: null,
                  // The old vector describes the old sentence — cleared with
                  // the rewrite, so a failed re-embed leaves the row honestly
                  // lexical rather than semantically wrong.
                  embedding: [],
                  embeddingModel: null,
                  lastVerifiedAt: new Date(),
                },
              });
            },
          });
          if (!outcome.ok) {
            refusal = outcome;
            throw new SuppressedWrite();
          }
          if (row.kind === "FACT") touched.push({ id: op.id, content: outcome.content });
          inverse.push({ op: "update", id: op.id, before: op.content, content: row.content });
        } else {
          const row = byId.get(op.id)!;
          // Clear the back-pointers first: a row deleted while another names it
          // as its replacement leaves a "replaced by" that resolves to nothing.
          await tx.memoryEntry.updateMany({
            where: { userId: user.id, supersededById: op.id },
            data: { supersededById: null },
          });
          await tx.memoryEntry.delete({ where: { id: op.id, userId: user.id } });
          // Undoing the removal must restore the same KIND (a deleted suppression
          // comes back as a suppression, not as a fact).
          inverse.push({ op: "add", content: row.content, ...(row.kind === "SUPPRESSION" ? { suppress: true } : {}) });
        }
      }
    });
  } catch (e) {
    if (!(e instanceof SuppressedWrite)) throw e;
    const refused = refusal as MemoryWriteRefusal | null;
    if (refused?.reason === "suppressed") {
      return NextResponse.json(
        { error: refused.message, code: "suppressed", suppression: refused.suppression },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  inverse.reverse();

  // Vectors for what the edit wrote — after the transaction holds, so a
  // rolled-back edit never leaves embeddings pointing at rows that were never
  // committed. Best effort: failure leaves the rows lexical, never unapplied.
  await embedMemoryEntries({ userId: user.id, rows: touched });

  // Re-consolidate so the summary reflects the change. Best effort and bounded —
  // this blocks the user's Accept/Undo click, so don't walk the whole provider
  // list. If it fails, the facts are still updated and the old summary stays
  // until the next consolidation.
  await consolidateWithFallback(user.id, 3).catch(() => {});

  const [memories, summary] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { userId: user.id },
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
    inverse,
  });
}
