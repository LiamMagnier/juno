import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { listConversations } from "@/lib/queries";
import { serializeConversation } from "@/lib/serializers";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? undefined;
  const folderId = searchParams.get("folderId") ?? undefined;

  const conversations = await listConversations(user.id, { q, folderId });
  return NextResponse.json({ conversations });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // The Juno app marks Code sessions at create; everything else is a chat.
  const body = (await req.json().catch(() => ({}))) as { kind?: unknown };
  const kind = body.kind === "code" ? "code" : "chat";
  const conversation = await prisma.conversation.create({ data: { userId: user.id, titleSource: "default", kind } });
  return NextResponse.json({ conversation: serializeConversation(conversation) }, { status: 201 });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await prisma.conversation.deleteMany({
    where: { userId: user.id },
  });

  return NextResponse.json({ ok: true });
}
