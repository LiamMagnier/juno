import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { listConversations } from "@/lib/queries";
import { serializeConversation } from "@/lib/serializers";
import { codeWorkspaceAttributionShape } from "@/lib/code-workspaces";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? undefined;
  const folderId = searchParams.get("folderId") ?? undefined;

  const conversations = await listConversations(user.id, { q, folderId });
  return NextResponse.json({ conversations });
}

// The Juno app marks Code sessions (and their workspace) at create.
// codeWorkspaceKey is the stable workspace identity (CodeWorkspace.key) when
// the client knows it; name/path stay as display + device metadata. The
// workspace fields reuse PATCH's schema so creating a session and retro-marking
// one accept identical values — a single shared clamp used to truncate every
// field at 300, quietly cutting long paths and losing path-fallback grouping.
const createSchema = z.object(codeWorkspaceAttributionShape);

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { kind?: unknown };
  // Unknown kinds stay lenient and fall back to "chat".
  const kind = body.kind === "code" ? "code" : "chat";
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const d = parsed.data;

  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      titleSource: "default",
      kind,
      ...(kind === "code"
        ? {
            codeWorkspaceName: d.codeWorkspaceName ?? null,
            codeWorkspacePath: d.codeWorkspacePath ?? null,
            codeWorkspaceKey: d.codeWorkspaceKey ?? null,
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
