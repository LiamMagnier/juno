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

  // The Juno app marks Code sessions (and their workspace) at create.
  // codeWorkspaceKey is the stable workspace identity (CodeWorkspace.key) when
  // the client knows it; name/path stay as display + device metadata.
  const body = (await req.json().catch(() => ({}))) as {
    kind?: unknown;
    codeWorkspaceName?: unknown;
    codeWorkspacePath?: unknown;
    codeWorkspaceKey?: unknown;
  };
  const kind = body.kind === "code" ? "code" : "chat";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      titleSource: "default",
      kind,
      ...(kind === "code"
        ? {
            codeWorkspaceName: str(body.codeWorkspaceName),
            codeWorkspacePath: str(body.codeWorkspacePath),
            codeWorkspaceKey: str(body.codeWorkspaceKey),
          }
        : {}),
    },
  });
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
