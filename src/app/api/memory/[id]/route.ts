import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { MEMORY_CATEGORIES } from "@/lib/memory-categories";
import { factFields } from "@/lib/memory-lifecycle";

/*
 * Edit, forget and delete for a single memory.
 *
 * Forget and delete are deliberately different operations, because they answer
 * different questions. Delete removes the row — and the backfill is free to
 * relearn the same fact from the chat it came from, which is exactly what used
 * to make "I deleted that" feel like a lie. Forget retires the row AND writes a
 * suppression, which blocks the statement from ever being extracted again.
 */

const schema = z
  .object({
    content: z.string().trim().min(1).max(500).optional(),
    category: z.enum(MEMORY_CATEGORIES).optional(),
    /** null moves a project-scoped memory back to the whole account. */
    projectId: z.string().min(1).nullish(),
    /** Retire this memory and never learn it again. */
    forget: z.literal(true).optional(),
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

  if (body.forget) {
    const now = new Date();
    await prisma.$transaction([
      prisma.memoryEntry.updateMany({
        where: { id, userId: user.id },
        data: { status: "suppressed", reason: "You asked Juno to forget this.", supersededById: null },
      }),
      // The block-list entry is what survives a re-extraction of the original
      // chat. Without it, forgetting only lasts until the next backfill.
      prisma.memoryEntry.create({
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
      }),
    ]);
    return NextResponse.json({ ok: true, status: "suppressed" });
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

  await prisma.memoryEntry.update({
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
            ...(body.category === undefined ? { category: fields.category } : {}),
          }
        : {}),
      lastVerifiedAt: new Date(),
    },
  });
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
  ]);
  return NextResponse.json({ ok: true });
}
