import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getConversationThread } from "@/lib/queries";
import { serializeConversation } from "@/lib/serializers";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const thread = await getConversationThread(user.id, id);
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(thread);
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  folderId: z.string().cuid().nullable().optional(),
  projectId: z.string().cuid().nullable().optional(),
  // The Juno app retro-marks synced Code sessions (+ their workspace).
  kind: z.enum(["chat", "code"]).optional(),
  codeWorkspaceName: z.string().trim().min(1).max(300).nullable().optional(),
  codeWorkspacePath: z.string().trim().min(1).max(1000).nullable().optional(),
  codeWorkspaceKey: z.string().trim().min(1).max(200).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.conversation.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // If moving to a folder, verify the folder belongs to the user.
  if (parsed.data.folderId) {
    const folder = await prisma.folder.findFirst({ where: { id: parsed.data.folderId, userId: user.id } });
    if (!folder) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  // If moving to a project, verify the project belongs to the user.
  if (parsed.data.projectId) {
    const project = await prisma.project.findFirst({ where: { id: parsed.data.projectId, userId: user.id } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // `archived` is a request-shaped boolean, not a column — keep it out of the
  // spread and map it onto the archivedAt timestamp.
  const { archived, ...fields } = parsed.data;
  const data = {
    ...fields,
    ...(fields.title != null ? { titleSource: "manual" } : {}),
    // Un-archiving is unconditional; archiving is stamped separately below.
    ...(archived === false ? { archivedAt: null } : {}),
  };

  // Stamp archivedAt only on the null→now transition. A blanket
  // `archivedAt: new Date()` reset the timestamp every time an already-archived
  // chat was PATCHed, which defeats the point of storing "when" at all.
  if (archived === true) {
    await prisma.conversation.updateMany({
      where: { id, userId: user.id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
  }

  const updated = await prisma.conversation.update({ where: { id, userId: user.id }, data });
  return NextResponse.json({ conversation: serializeConversation(updated) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.conversation.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.conversation.delete({ where: { id, userId: user.id } });
  return NextResponse.json({ ok: true });
}
