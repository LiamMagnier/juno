import { NextResponse, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import {
  consolidateWithFallback,
  deleteMemoryEntries,
  embedMemoryEntries,
  getMemorySummary,
  refreshSummaries,
  settleRewrittenFact,
  writeManualFact,
} from "@/lib/memory";
import { TOPIC_EXCLUSION_CATEGORY, topicOfStatement, topicStatement } from "@/lib/memory-topics";
import { checkProjectAccess } from "@/lib/project-collaboration";
import { guardedMemoryWrite, type MemoryWriteRefusal } from "@/lib/memory-suppression";
import { factFields } from "@/lib/memory-lifecycle";
import { summaryInvalidations } from "@/lib/memory-summary-changes";
import { MEMORY_ENTRY_SELECT, loadProvenanceConversations, serializeMemoryEntry } from "@/lib/memory-view";

export const runtime = "nodejs";
export const maxDuration = 60;

// `before` is the fact text the edit was drafted against — verified below so a
// stale edit can never silently clobber changes made in the meantime.
const opSchema = z.union([
  z.object({
    op: z.literal("add"),
    content: z.string().trim().min(1).max(500),
    suppress: z.boolean().optional(),
    // Only ever set by an Undo: restoring a removed fact puts it back in the
    // scope it was removed from. Without it, undoing the removal of a project
    // fact restored it account-wide — into every unrelated chat.
    projectId: z.string().min(1).nullish(),
  }),
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
        select: { id: true, content: true, kind: true, projectId: true },
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

  // A scope on an add is a claim, like a projectId on any other write. The
  // project has to still be one this person can use: a fact restored into a
  // project they have lost is unreachable, and restoring it account-wide
  // instead would widen what they asked to keep narrow — so the edit is
  // refused whole rather than either.
  const addScopes = [
    ...new Set(ops.flatMap((o) => (o.op === "add" && o.projectId && !o.suppress ? [o.projectId] : []))),
  ];
  for (const projectId of addScopes) {
    const { allowed } = await checkProjectAccess(user.id, projectId, "VIEWER");
    if (!allowed) {
      return NextResponse.json(
        { error: "The project this was remembered in no longer exists, so it can't be put back there." },
        { status: 409 }
      );
    }
  }

  const inverse: Operation[] = [];
  // Scopes in which an added fact replaced older beliefs: their summaries rebuild after.
  const replacedScopes: (string | null)[] = [];
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
        if (op.op === "add" && !op.suppress) {
          // A fact: through the manual write door, so an edit that says "I
          // moved to Porto" replaces "lives in Lisbon" rather than adding a
          // second city, and one that restates a known fact confirms it
          // rather than copying it (writeManualFact).
          const outcome = await writeManualFact(tx, {
            userId: user.id,
            content: op.content,
            projectId: op.projectId ?? null,
            sourceRef: "edit",
          });
          if (!outcome.ok) {
            refusal = outcome;
            throw new SuppressedWrite();
          }
          if (outcome.needsEmbedding) touched.push({ id: outcome.id, content: outcome.content });
          // Undo removes what this created — never a fact that was already
          // believed and merely confirmed — and puts back what it replaced:
          // re-adding a replaced belief reinstates its own row, which in turn
          // retires this one with its history intact. A row brought back that
          // replaced nothing has nothing to be retired by, so it is removed.
          const removable =
            outcome.action === "created" || (outcome.action === "reinstated" && outcome.replaced.length === 0);
          if (removable) inverse.push({ op: "remove", id: outcome.id, before: outcome.content });
          for (const old of outcome.replaced) inverse.push({ op: "add", content: old.content, ...(op.projectId ? { projectId: op.projectId } : {}) });
          replacedScopes.push(op.projectId ?? null);
        } else if (op.op === "add") {
          // Applied edits wrote straight to the table, so "forget my old job"
          // followed by any instruction that re-stated it put it right back.
          // A whole topic ("Anything about my divorce") is stored in its one
          // canonical phrasing, like a forget said in chat (forgetStatements).
          const topic = topicOfStatement(op.content);
          const statement = topic !== null ? topicStatement(topic) : op.content;
          const outcome = await guardedMemoryWrite({
            content: statement,
            kind: "SUPPRESSION",
            loadSuppressions: suppressions,
            write: (content) => {
              const fields = factFields(content, { source: "MANUAL" });
              return tx.memoryEntry.create({
                data: {
                  userId: user.id,
                  content,
                  source: "MANUAL",
                  kind: "SUPPRESSION",
                  sourceRef: "edit",
                  category: topic !== null ? TOPIC_EXCLUSION_CATEGORY : "suppression",
                  // Suppressions are account-wide by definition.
                  projectId: null,
                  confidence: fields.confidence,
                  normalized: fields.normalized,
                  expiresAt: null,
                  observedAt: new Date(),
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
          inverse.push({ op: "remove", id: outcome.value.id, before: outcome.content });
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
                  observedAt: new Date(),
                  lastVerifiedAt: new Date(),
                },
              });
            },
          });
          if (!outcome.ok) {
            refusal = outcome;
            throw new SuppressedWrite();
          }
          inverse.push({ op: "update", id: op.id, before: op.content, content: row.content });
          if (row.kind === "FACT") {
            touched.push({ id: op.id, content: outcome.content });
            // The summary quoting the old text is out of service until rebuilt.
            await Promise.all(summaryInvalidations(tx, user.id, [row.projectId]));
            // The new wording settles its scope like a typed fact does; Undo
            // puts back whatever it replaced.
            for (const old of await settleRewrittenFact(tx, user.id, op.id)) {
              inverse.push({ op: "add", content: old.content, ...(row.projectId ? { projectId: row.projectId } : {}) });
            }
          }
        } else {
          const row = byId.get(op.id)!;
          // The row, the pointers at it, the reasons quoting it and its
          // scope's summary — the one delete every path shares.
          await deleteMemoryEntries(tx, user.id, [op.id]);
          // Undoing the removal must restore the same KIND (a deleted suppression
          // comes back as a suppression, not as a fact).
          inverse.push({
            op: "add",
            content: row.content,
            ...(row.kind === "SUPPRESSION" ? { suppress: true } : {}),
            ...(row.kind === "FACT" && row.projectId ? { projectId: row.projectId } : {}),
          });
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
  // Project summaries the edit touched are rebuilt after the response instead:
  // the account summary above is what this page shows, and a project's is
  // only read by that project's next chat.
  const projectScopes = [
    ...new Set([
      ...referenced.flatMap((row) => (row.projectId ? [row.projectId] : [])),
      ...addScopes,
      ...replacedScopes.filter((scope): scope is string => scope !== null),
    ]),
  ];
  if (projectScopes.length > 0) {
    after(() => refreshSummaries(user.id, projectScopes).then(() => undefined, () => undefined));
  }

  const [memories, summary] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: MEMORY_ENTRY_SELECT,
    }),
    getMemorySummary(user.id),
  ]);

  const conversations = await loadProvenanceConversations(user.id, memories);
  return NextResponse.json({
    memories: memories.map((row) => serializeMemoryEntry(row, conversations)),
    summary: summary
      ? { content: summary.content, updatedAt: summary.updatedAt.toISOString(), entryCount: summary.entryCount }
      : null,
    inverse,
  });
}
