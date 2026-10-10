import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { chatConversationEnabled, crossMessageSettings, crossMessagesForChat, markCrossRead } from "@/lib/cross-conversation/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * /api/conversations/[id]/cross-messages — a Chat conversation's messages to
 * and from the user's other conversations (src/lib/cross-conversation), for
 * the transcript's compact rows on the web and in the apps.
 *
 * GET   → { messages, enabled, toggle, accountDefault }
 * POST  { read: true } → marks the received ones read (the sidebar's unread title)
 * PATCH { enabled: true | false | null } → this conversation's own toggle; null follows the account setting
 */

async function owned(userId: string, id: string) {
  return prisma.conversation.findFirst({ where: { id, userId, kind: "chat" }, select: { id: true, crossMessages: true } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const conversation = await owned(user.id, id);
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [messages, enabled, settings] = await Promise.all([
    crossMessagesForChat(user.id, id),
    chatConversationEnabled(user.id, id),
    crossMessageSettings(user.id),
  ]);
  return NextResponse.json(
    { messages, enabled, toggle: conversation.crossMessages ?? null, accountDefault: settings.chat },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const postSchema = z.object({ read: z.literal(true) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await owned(user.id, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!postSchema.safeParse(await req.json().catch(() => null)).success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  return NextResponse.json({ read: await markCrossRead(user.id, id) });
}

const patchSchema = z.object({ enabled: z.boolean().nullable() });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await owned(user.id, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const value = parsed.data.enabled === null ? null : parsed.data.enabled ? "on" : "off";
  await prisma.conversation.updateMany({ where: { id, userId: user.id }, data: { crossMessages: value } });
  return NextResponse.json({ enabled: await chatConversationEnabled(user.id, id), toggle: value });
}
