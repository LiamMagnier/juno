import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Thumbs on answers in a Code session that runs on the user's Mac. Those
 * answers live in the env server's log, not in Message rows, so the chat
 * feedback route (POST /api/messages/[id]/feedback) has nothing to write to;
 * a session on the CodeTask path keeps using that one. No content is stored:
 * the turn's id, the verdict, and the model when the client knew it.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const conversationId = new URL(req.url).searchParams.get("conversationId")?.trim();
  if (!conversationId) return NextResponse.json({ error: "conversationId is required." }, { status: 400 });
  const rows = await prisma.codeTurnFeedback.findMany({
    where: { conversationId, userId: user.id },
    select: { turnKey: true, feedback: true },
    take: 2000,
  });
  return NextResponse.json({ feedback: Object.fromEntries(rows.map((r) => [r.turnKey, r.feedback])) }, { headers: NO_STORE });
}

const putSchema = z.object({
  conversationId: z.string().min(1).max(64),
  turnKey: z.string().min(1).max(200),
  feedback: z.enum(["UP", "DOWN"]).nullable(),
  model: z.string().max(200).optional(),
});

export async function PUT(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const limited = await rateLimit({ key: `code-feedback:${user.id}`, limit: 120, windowSec: 60 });
  if (!limited.success) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { conversationId, turnKey, feedback, model } = parsed.data;
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId: user.id, kind: "code" }, select: { id: true } });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (feedback === null) {
    await prisma.codeTurnFeedback.deleteMany({ where: { conversationId, turnKey, userId: user.id } });
  } else {
    await prisma.codeTurnFeedback.upsert({
      // userId beside the compound key: the ownership guard (src/lib/db.ts) requires it.
      where: { conversationId_turnKey: { conversationId, turnKey }, userId: user.id },
      create: { userId: user.id, conversationId, turnKey, feedback, ...(model ? { model } : {}) },
      update: { feedback, ...(model ? { model } : {}) },
    });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
