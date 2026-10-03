import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
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
import {
  parseWorkDefaults,
  serializeWorkDefaults,
  workDefaultsSchema,
  WORK_DEFAULTS_VERSION,
} from "@/lib/work/projects";
import { MOVE_REFUSAL_MESSAGES, validateProjectMove } from "@/lib/projects/project-tree";
import { deleteProjectFolder, loadOwnerProjectTree } from "@/lib/projects/project-tree-server";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { allowed } = await checkProjectAccess(user.id, id, "VIEWER");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  /*
   * Unguarded, three lines after `checkProjectAccess` allowed this reader: a
   * project reached by a VIEWER or an EDITOR is one they do not own, so a
   * `userId: user.id` filter here would 404 every collaborator — and the
   * ownership guard throws in development, so as written this route was a 500
   * on a dev machine for the owner too. See src/lib/db.ts for the guard and
   * getProjectRole in project-collaboration.ts for the same call one layer up.
   */
  const project = await prismaUnguarded.project.findUnique({
    where: { id },
    include: {
      conversations: {
        orderBy: { lastMessageAt: "desc" },
        select: {
          id: true,
          title: true,
          lastMessageAt: true,
          pinned: true,
          // `kind` and the workspace columns are what separate a chat from a
          // Code session, and the project page had no access to either: it was
          // deciding which of its own conversations were code by testing
          // whether the TITLE contained "code" or "repo". So a chat called
          // "Which decoder should I use?" was filed as a code session, every
          // real session was double-counted (once in Chats, once in Code), and
          // the workspace each session actually belongs to — the one fact the
          // Code list is for — was not on the wire at all.
          kind: true,
          codeWorkspaceName: true,
          codeWorkspacePath: true,
        },
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

  /*
   * Folders. Drawn for the owner only: the tree a project sits in is the
   * owner's filing, and a collaborator who was given one project must not
   * learn the names of the folders around it.
   *
   * `breadcrumbs` are the ancestors root first; `children` the subfolders
   * directly inside, with their own counts; `inherited` the ancestors whose
   * instructions or files every chat here also receives (see
   * mergeInheritedProjectContext in lib/projects/project-tree.ts).
   */
  const isOwner = project.userId === user.id;
  const tree = isOwner
    ? await prisma.project.findMany({
        where: { userId: user.id },
        select: {
          id: true,
          parentId: true,
          name: true,
          instructions: true,
          updatedAt: true,
          starred: true,
          _count: { select: { conversations: true, files: { where: { deletedAt: null, fileName: { not: "__cover__" } } } } },
        },
      })
    : [];
  const byId = new Map(tree.map((node) => [node.id, node]));
  const lineage: typeof tree = [];
  {
    const seen = new Set<string>([project.id]);
    let cursor = isOwner ? project.parentId : null;
    while (cursor && !seen.has(cursor) && byId.has(cursor)) {
      seen.add(cursor);
      lineage.unshift(byId.get(cursor)!);
      cursor = byId.get(cursor)!.parentId;
    }
  }
  const childCountOf = (id: string) => tree.filter((node) => node.parentId === id).length;

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      parentId: isOwner ? project.parentId : null,
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
      kind: c.kind,
      codeWorkspaceName: c.codeWorkspaceName,
      codeWorkspacePath: c.codeWorkspacePath,
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
    breadcrumbs: lineage.map((node) => ({ id: node.id, name: node.name })),
    children: tree
      .filter((node) => node.parentId === project.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((node) => ({
        id: node.id,
        name: node.name,
        instructions: node.instructions,
        starred: node.starred,
        updatedAt: node.updatedAt.toISOString(),
        conversationCount: node._count.conversations,
        fileCount: node._count.files,
        childCount: childCountOf(node.id),
      })),
    inherited: lineage
      .filter((node) => node.instructions.trim() || node._count.files > 0)
      .map((node) => ({
        id: node.id,
        name: node.name,
        instructions: node.instructions,
        fileCount: node._count.files,
      })),
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
  /**
   * Move the project into another of the owner's projects (a folder), or to
   * the top level with null. Owner only, cycle- and depth-checked against the
   * owner's whole tree (validateProjectMove).
   */
  parentId: z.string().min(1).max(200).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { allowed } = await checkProjectAccess(user.id, id, "EDITOR");
  if (!allowed) return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { workspace, workDefaults, parentId, ...projectPatch } = parsed.data;
  if (parentId !== undefined) {
    // Filing is the owner's: a collaborator could otherwise pull a shared
    // project into (or out of) the owner's folders.
    const owned = await prisma.project.findFirst({ where: { id, userId: user.id }, select: { parentId: true } });
    if (!owned) return NextResponse.json({ error: "Only the owner can move this project" }, { status: 403 });
    if (owned.parentId !== parentId) {
      const check = validateProjectMove(await loadOwnerProjectTree(user.id), id, parentId);
      if (!check.ok) {
        return NextResponse.json(
          { error: MOVE_REFUSAL_MESSAGES[check.reason], reason: check.reason },
          { status: check.reason === "parent_not_found" ? 404 : 409 }
        );
      }
      await prisma.project.update({ where: { id, userId: user.id }, data: { parentId } });
    }
  }
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
            workDefaults: serializeWorkDefaults(workDefaults) as Prisma.InputJsonValue,
            workDefaultsVersion: WORK_DEFAULTS_VERSION,
          }
        : {}),
    };
    // Unguarded on purpose, after `checkProjectAccess` allowed an EDITOR: a
    // collaborator edits a project they do not own, so a `userId` scope would
    // refuse exactly the people this route lets in.
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

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { allowed } = await checkProjectAccess(user.id, id, "OWNER");
  if (!allowed) return NextResponse.json({ error: "Not found or only the owner can delete the project" }, { status: 403 });

  // Conversations are kept (projectId set null); project files cascade-delete.
  // Owner-only, and the owner is the requester: scope the delete to them.
  //
  // A folder's subfolders move up to its own parent unless `?children=cascade`
  // asks for the whole subtree to go (the delete dialog asks the reader).
  const mode = new URL(req.url).searchParams.get("children") === "cascade" ? "cascade" : "lift";
  const result = await deleteProjectFolder(user.id, id, mode);
  if (!result.deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, deleted: result.deleted, moved: result.moved });
}
