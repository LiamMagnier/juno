import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";
import { checkProjectAccess } from "@/lib/project-collaboration";
import {
  parseWorkspaceConfig,
  workspaceConfigSchema,
  writeWorkspaceConfig,
  WORKSPACE_CONFIG_VERSION,
} from "@/lib/projects/workspace-config";
import {
  parseWorkDefaults,
  serializeWorkDefaults,
  workDefaultsSchema,
  WORK_DEFAULTS_VERSION,
} from "@/lib/work/projects";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { allowed } = await checkProjectAccess(user.id, id, "VIEWER");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const project = await prisma.project.findUnique({
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
      // Read back through the parser rather than handed over raw, so what a
      // control draws is exactly what a session will inherit. A field this
      // build does not recognise is dropped on the way out as it is on the way
      // in, which is what stops a page showing a setting nothing acts on.
      workDefaults: parseWorkDefaults(project.workDefaults),
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
  /**
   * What a task filed in this project inherits: its approval mode, its model,
   * its connected apps, its Mac.
   *
   * Editable by an EDITOR like everything else in this patch, and safe to be:
   * every field here is resolved against the ACTING account's own ceilings when
   * a session is created — the model through the plan gate, the Mac against a
   * row carrying that user, the connectors intersected with what that user has
   * linked, and the approval mode narrowed from the product default and never
   * widened past it. So a collaborator can express a preference and cannot
   * hand anybody a permission.
   *
   * REPLACES the stored object wholesale rather than patching it, for the
   * reason `project_workspace.upsert` does: a patch needs a spelling for
   * "remove this key", JSON's only one is null, and null is already taken by a
   * different meaning in half the fields. Whole-object replacement is what
   * keeps "absent" expressible, and absent is what "inherit" means here.
   */
  workDefaults: workDefaultsSchema.optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { allowed } = await checkProjectAccess(user.id, id, "EDITOR");
  if (!allowed) return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { workspace, workDefaults, ...projectPatch } = parsed.data;
  if (Object.keys(projectPatch).length > 0 || workDefaults !== undefined) {
    const data = {
      ...projectPatch,
      ...(projectPatch.name != null ? { nameSource: "manual" } : {}),
      // Round-tripped through the codec before storage, which
      // `serializeWorkDefaults` exists to force: what is written is then
      // byte-identical to what a read of it produces, so a caller cannot store
      // a field the reader will ignore — which is how a setting comes to look
      // saved and have no effect.
      ...(workDefaults !== undefined
        ? {
            workDefaults: serializeWorkDefaults(workDefaults),
            workDefaultsVersion: WORK_DEFAULTS_VERSION,
          }
        : {}),
    };
    await prisma.project.update({ where: { id }, data });
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
  await prisma.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
