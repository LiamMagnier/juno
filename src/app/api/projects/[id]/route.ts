import { NextResponse } from "next/server";
import { z } from "zod";
// prismaUnguarded is deliberate in this route: every handler verifies the
// caller's project role first (shared/collaborator projects are legitimately
// not owned by the requesting user), then acts on the project by id alone.
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";
import { checkProjectAccess } from "@/lib/project-collaboration";
import {
  parseWorkspaceConfig,
  workspaceConfigSchema,
  writeWorkspaceConfig,
  WORKSPACE_CONFIG_VERSION,
} from "@/lib/projects/workspace-config";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { allowed } = await checkProjectAccess(user.id, id, "VIEWER");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Access verified above (VIEWER+); by-id is intentional — see the import note.
  const project = await prismaUnguarded.project.findUnique({
    where: { id },
    include: {
      conversations: {
        orderBy: { lastMessageAt: "desc" },
        select: { id: true, title: true, lastMessageAt: true, pinned: true },
      },
      files: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
      workspace: { select: { config: true } },
    },
  });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const knowledge = project.files.length
    ? await prisma.knowledgeDocument.findMany({
        where: {
          userId: user.id,
          attachmentId: { in: project.files.map((file) => file.id) },
          state: { not: "stale" },
          deletedAt: null,
        },
        orderBy: { version: "asc" },
        select: {
          id: true,
          attachmentId: true,
          state: true,
          error: true,
          pageCount: true,
          _count: { select: { blocks: true } },
        },
      })
    : [];
  const knowledgeByAttachment = new Map(
    knowledge
      .filter((document) => document.attachmentId)
      .map((document) => [document.attachmentId as string, document])
  );

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      instructions: project.instructions,
      starred: project.starred,
      updatedAt: project.updatedAt.toISOString(),
    },
    conversations: project.conversations.map((c) => ({
      id: c.id,
      title: c.title,
      pinned: c.pinned,
      lastMessageAt: c.lastMessageAt.toISOString(),
    })),
    files: await Promise.all(
      project.files.map(async (file) => {
        const serialized = await serializeAttachment(file);
        const document = knowledgeByAttachment.get(file.id);
        return {
          ...serialized,
          knowledge: document
            ? {
                documentId: document.id,
                state: document.state,
                error: document.error,
                pageCount: document.pageCount,
                blockCount: document._count.blocks,
              }
            : null,
        };
      })
    ),
    workspace: parseWorkspaceConfig(project.workspace?.config),
  });
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  // No app-side character cap — model context is the real limit.
  instructions: z.string().optional(),
  starred: z.boolean().optional(),
  workspace: workspaceConfigSchema.nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { allowed } = await checkProjectAccess(user.id, id, "EDITOR");
  if (!allowed) return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { workspace, ...projectPatch } = parsed.data;
  if (Object.keys(projectPatch).length > 0) {
    const data = {
      ...projectPatch,
      ...(projectPatch.name != null ? { nameSource: "manual" } : {}),
    };
    // Access verified above (EDITOR+); by-id is intentional — see the import note.
    await prismaUnguarded.project.update({ where: { id }, data });
  }
  if (workspace === null) {
    await prisma.projectWorkspace.deleteMany({ where: { projectId: id, userId: user.id } });
  } else if (workspace !== undefined) {
    const config = writeWorkspaceConfig(workspace);
    await prisma.projectWorkspace.upsert({
      where: { userId_projectId: { userId: user.id, projectId: id } },
      create: {
        id,
        userId: user.id,
        projectId: id,
        config,
        configVersion: WORKSPACE_CONFIG_VERSION,
      },
      update: { config, configVersion: WORKSPACE_CONFIG_VERSION },
    });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { allowed } = await checkProjectAccess(user.id, id, "OWNER");
  if (!allowed) return NextResponse.json({ error: "Not found or only the owner can delete the project" }, { status: 403 });

  // Conversations are kept (projectId set null); project files cascade-delete.
  // Access verified above (OWNER); by-id is intentional — see the import note.
  await prismaUnguarded.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
