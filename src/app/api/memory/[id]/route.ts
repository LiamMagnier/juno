import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getSuppressions } from "@/lib/memory";
import { guardedMemoryWrite } from "@/lib/memory-suppression";

const schema = z.object({ content: z.string().trim().min(1).max(500) });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.memoryEntry.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // Rewriting an existing entry is a write like any other: without the door,
  // "forget my old job" could be undone by editing any unrelated fact into that
  // sentence. The entry's own kind is passed so a suppression can still be
  // reworded — the block-list must not block edits to itself.
  const outcome = await guardedMemoryWrite({
    content: parsed.data.content,
    kind: existing.kind,
    loadSuppressions: () => getSuppressions(user.id),
    write: (content) => prisma.memoryEntry.update({ where: { id, userId: user.id }, data: { content } }),
  });

  if (!outcome.ok) {
    if (outcome.reason === "empty") return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    return NextResponse.json(
      { error: outcome.message, code: "suppressed", suppression: outcome.suppression },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.memoryEntry.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.memoryEntry.delete({ where: { id, userId: user.id } });
  return NextResponse.json({ ok: true });
}
