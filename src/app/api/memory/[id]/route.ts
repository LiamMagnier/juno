import { NextResponse, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { embedMemoryEntries, getSuppressions, refreshSummaries } from "@/lib/memory";
import { screenMemoryWrite } from "@/lib/memory-suppression";
import { MEMORY_CATEGORIES } from "@/lib/memory-categories";
import { factFields } from "@/lib/memory-lifecycle";
import { summaryInvalidations } from "@/lib/memory-summary-changes";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Edit, forget and delete for a single memory.
 *
 * Forget and delete are deliberately different operations, because they answer
 * different questions. Delete removes the row — and the backfill is free to
 * relearn the same fact from the chat it came from, which is exactly what used
 * to make "I deleted that" feel like a lie. Forget retires the row AND writes a
 * suppression, which blocks the statement from ever being extracted again.
 *
 * "Not relevant" is the third, and the lightest: the fact stays true and
 * stays remembered, but an answer used it where it did not belong. It marks
 * the row (`notRelevantAt`) and ranking stops letting it ride along with
 * messages that are not about it for a while (NOT_RELEVANT_DAYS in
 * memory-lifecycle.ts). `notRelevant: false` takes the mark back.
 */

/**
 * Rebuild the summaries a change touched, once the response has gone.
 *
 * A consolidated summary quotes facts in prose and is injected into every
 * conversation of its scope, so a fact rewritten, forgotten or deleted here
 * lived on in it until something unrelated happened to trigger a rebuild. A
 * forget is already safe without this — `getMemoryProfile` benches a summary
 * older than the newest suppression — but an edit and a delete leave no such
 * marker, and the reader who corrected "Lisbon" to "Porto" expects the next
 * chat to say Porto.
 *
 * SCOPES, not "the summary". `null` is the account's; a project id is that
 * project's own. A fact scoped to a project lives in that project's summary
 * and nowhere else, and moving a fact between scopes changes both — the one it
 * left still quotes it until rebuilt, which for a fact moved INTO a project is
 * the leak the move was made to stop.
 *
 * `after()`, not awaited: consolidation is an LLM call of up to 45 seconds, and
 * a row's pencil or bin must not wait on it. Best effort, like every other
 * consolidation — a failure leaves the previous summary, and the next chat
 * turn's `maybeConsolidate` / `maybeConsolidateProject` tries again.
 */
function refreshSummariesLater(userId: string, scopes: (string | null)[]) {
  after(() => refreshSummaries(userId, scopes).then(() => undefined, () => undefined));
}

const schema = z
  .object({
    content: z.string().trim().min(1).max(500).optional(),
    category: z.enum(MEMORY_CATEGORIES).optional(),
    /** null moves a project-scoped memory back to the whole account. */
    projectId: z.string().min(1).nullish(),
    /** Retire this memory and never learn it again. */
    forget: z.literal(true).optional(),
    /**
     * With `forget`: this is a chat's Undo on a fact its turn just saved, so
     * whatever that fact replaced is believed again. Undo puts memory back
     * the way it was before the turn; a plain Forget on the memory page does
     * not, because forgetting "lives in Madrid" is not a claim that the
     * person still lives in Lisbon.
     */
    undo: z.literal(true).optional(),
    /**
     * An answer used this fact where it did not belong (true), or that was a
     * mistake (false). On its own: it is a signal about ranking, not an edit.
     */
    notRelevant: z.boolean().optional(),
  })
  .refine((body) => body.notRelevant === undefined || Object.keys(body).length === 1, {
    message: "Not relevant is sent on its own",
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change" });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.memoryEntry.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  if (body.notRelevant !== undefined) {
    // A block-list row is never context, and a retired fact is not used, so
    // neither has a ranking to lower.
    if (existing.kind !== "FACT" || existing.status !== "active") {
      return NextResponse.json({ error: "Only a memory in use can be marked." }, { status: 409 });
    }
    // Not `lastVerifiedAt`: that is "the person said it again", which is the
    // one thing that lifts the mark early.
    const notRelevantAt = body.notRelevant ? new Date() : null;
    await prisma.memoryEntry.updateMany({ where: { id, userId: user.id }, data: { notRelevantAt } });
    return NextResponse.json({ ok: true, notRelevantAt: notRelevantAt?.toISOString() ?? null });
  }

  if (body.forget) {
    // Already forgotten and still on the block-list: say so rather than
    // writing a second suppression. A chat's Undo can be pressed again after a
    // reload (its receipt is the turn's historical record), and each press
    // used to add another block-list row and bench the summary again.
    if (existing.status === "suppressed") {
      const normalized = existing.normalized ?? factFields(existing.content, { source: "MANUAL" }).normalized;
      const blocked = await prisma.memoryEntry.findFirst({
        where: { userId: user.id, kind: "SUPPRESSION", normalized },
        select: { id: true },
      });
      if (blocked) return NextResponse.json({ ok: true, status: "suppressed", restored: 0 });
    }
    const now = new Date();
    const restored = await prisma.$transaction(async (tx) => {
      await tx.memoryEntry.updateMany({
        where: { id, userId: user.id },
        data: {
          status: "suppressed",
          reason: `You asked ${PRODUCT_NAME} to forget this.`,
          supersededById: null,
          // The text stays as the trail; a semantic copy of what the person
          // asked to be forgotten has no reader and no reason to stay.
          embedding: [],
          embeddingModel: null,
        },
      });
      // The block-list entry is what survives a re-extraction of the original
      // chat. Without it, forgetting only lasts until the next backfill.
      await tx.memoryEntry.create({
        data: {
          userId: user.id,
          content: existing.content,
          source: "MANUAL",
          kind: "SUPPRESSION",
          sourceRef: "forget",
          category: "suppression",
          confidence: 1,
          normalized: existing.normalized ?? factFields(existing.content, { source: "MANUAL", now }).normalized,
          lastVerifiedAt: now,
        },
      });
      if (!body.undo) return 0;
      // Undo: the rows this fact superseded (`supersede` in memory.ts marks
      // them "superseded" and points them here) are believed again. A row
      // something else has since replaced points elsewhere and stays as it is.
      const { count } = await tx.memoryEntry.updateMany({
        where: { userId: user.id, kind: "FACT", status: "superseded", supersededById: id },
        data: { status: "active", supersededById: null, reason: null, lastVerifiedAt: now },
      });
      return count;
    });
    // The row's own scope, and the account's: a forget is account-wide, so the
    // suppression it writes benches the account summary too until rebuilt.
    refreshSummariesLater(user.id, [null, existing.projectId]);
    return NextResponse.json({ ok: true, status: "suppressed", restored });
  }

  // Same ownership check as creation: a projectId is a claim until verified.
  if (body.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: body.projectId, userId: user.id },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Rewriting the text makes it a fact the user stated, so it is reclassified
  // and re-normalized as MANUAL — leaving the old normalized form behind would
  // silently break duplicate detection for everything that follows.
  const rewritten = body.content !== undefined && body.content !== existing.content;
  const fields = rewritten ? factFields(body.content!, { source: "MANUAL" }) : null;

  // Rewriting an existing entry is a write like any other: without the door,
  // "forget my old job" could be undone by editing any unrelated fact into that
  // sentence. Only the text needs screening — a category or scope change cannot
  // smuggle a suppressed statement back in. The entry's own kind is passed so a
  // suppression can still be reworded; the block-list must not block edits to
  // itself.
  if (body.content !== undefined) {
    const screened = screenMemoryWrite({
      content: body.content,
      kind: existing.kind,
      suppressions: await getSuppressions(user.id),
    });
    if (!screened.ok) {
      if (screened.reason === "empty") return NextResponse.json({ error: "Invalid input" }, { status: 400 });
      return NextResponse.json(
        { error: screened.message, code: "suppressed", suppression: screened.suppression },
        { status: 409 }
      );
    }
  }

  const moved = body.projectId !== undefined && (body.projectId ?? null) !== existing.projectId;
  // The summary of the scope this fact was in quotes its old text (or, moved
  // into a project, quotes it to every chat outside that project). Out of
  // service with the write, not after a rebuild that may never land.
  const staleSummaries =
    existing.kind === "FACT" && (rewritten || moved) ? summaryInvalidations(prisma, user.id, [existing.projectId]) : [];
  await prisma.$transaction([
    ...staleSummaries,
    prisma.memoryEntry.update({
      where: { id, userId: user.id },
      data: {
        ...(body.content !== undefined ? { content: body.content } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId ?? null } : {}),
        ...(fields
          ? {
              normalized: fields.normalized,
              confidence: fields.confidence,
              expiresAt: fields.expiresAt,
              source: "MANUAL" as const,
              // An edited fact is believed again: a row the user just rewrote is
              // not still "replaced by something newer".
              status: "active",
              reason: null,
              supersededById: null,
              // The old vector describes the old sentence. Cleared in the same
              // write, so if re-embedding below fails the row is honestly
              // lexical rather than semantically wrong.
              embedding: [],
              embeddingModel: null,
              // Rewritten now, so said now.
              observedAt: new Date(),
              ...(body.category === undefined ? { category: fields.category } : {}),
            }
          : {}),
        lastVerifiedAt: new Date(),
      },
    }),
  ]);
  if (rewritten) {
    await embedMemoryEntries({ userId: user.id, rows: [{ id, content: body.content! }] });
  }
  if (rewritten || moved) {
    refreshSummariesLater(user.id, [existing.projectId, moved ? body.projectId ?? null : existing.projectId]);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.memoryEntry.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.$transaction([
    // Rows that pointed at this one as their replacement would otherwise keep a
    // dangling id and render as "replaced by" nothing.
    prisma.memoryEntry.updateMany({
      where: { userId: user.id, supersededById: id },
      data: { supersededById: null },
    }),
    prisma.memoryEntry.delete({ where: { id, userId: user.id } }),
    // A summary that quotes the deleted fact must not be injected again.
    ...(existing.kind === "FACT" ? summaryInvalidations(prisma, user.id, [existing.projectId]) : []),
  ]);
  refreshSummariesLater(user.id, [existing.projectId]);
  return NextResponse.json({ ok: true });
}
