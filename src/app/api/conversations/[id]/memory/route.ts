import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { setConversationMemoryOff, type MemoryOffDb } from "@/lib/chat/memory-off-store";
import { isChatMemoryOffEnabled } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * /api/conversations/[id]/memory — "Memory off for this chat"
 * (src/lib/chat/memory-off.ts), for the chat's menu and the composer's +.
 *
 * GET   → { memoryOff, accountMemory }
 * PATCH { memoryOff: boolean } → the same, after saving.
 *
 * `accountMemory` is the account's own switch, so a client can tell "off for
 * this chat" from "paused everywhere" without a second request; the chat's
 * switch narrows it and never stands in for it. Owner-scoped like every
 * conversation route: someone else's chat, or a Code session, is not found and
 * nothing is written. Turning memory back on covers what was said meanwhile as
 * read (memory-off-store.ts). The apps save the same value through the sync
 * mutation `conversation.update`, which goes through the same writer.
 *
 * Switching is off unless CHAT_MEMORY_OFF_ENABLED=1 (src/lib/env.ts): PATCH
 * then answers 404 `not_enabled` and writes nothing. GET still answers, and a
 * chat saved with memory off keeps memory out either way.
 */

async function accountMemory(userId: string): Promise<boolean> {
  const settings = await prisma.settings.findUnique({ where: { userId }, select: { memoryEnabled: true } });
  // A missing row is the column default (on), as the chat bootstrap reads it.
  return settings?.memoryEnabled ?? true;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: user.id, kind: "chat" },
    select: { memoryOff: true },
  });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(
    { memoryOff: conversation.memoryOff, accountMemory: await accountMemory(user.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const patchSchema = z.object({ memoryOff: z.boolean() }).strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isChatMemoryOffEnabled()) {
    return NextResponse.json({ error: "Memory off for a chat is not turned on for this server.", code: "not_enabled" }, { status: 404 });
  }
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const saved = await setConversationMemoryOff(prisma as unknown as MemoryOffDb, {
    userId: user.id,
    conversationId: id,
    off: parsed.data.memoryOff,
    kind: "chat",
  });
  if (!saved) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ memoryOff: saved.memoryOff, accountMemory: await accountMemory(user.id) });
}
