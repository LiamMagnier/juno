import "server-only";

import { prisma } from "@/lib/prisma";
import {
  ancestorIds,
  planFolderDelete,
  mergeInheritedProjectContext,
  type DeleteChildrenMode,
  type ProjectTreeNode,
} from "@/lib/projects/project-tree";

/**
 * The database half of project folders. The rules themselves live in
 * project-tree.ts; this file only loads an owner's tree and applies a plan.
 */

/** Every project the owner has, as tree nodes. Accounts hold tens, not thousands. */
export async function loadOwnerProjectTree(userId: string): Promise<ProjectTreeNode[]> {
  return prisma.project.findMany({
    where: { userId },
    select: { id: true, parentId: true },
  });
}

/** `id`'s ancestors, root first, as `{ id, name }` (for breadcrumbs). */
export async function loadProjectBreadcrumbs(userId: string, id: string): Promise<{ id: string; name: string }[]> {
  const nodes = await prisma.project.findMany({
    where: { userId },
    select: { id: true, parentId: true, name: true },
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return ancestorIds(nodes, id)
    .reverse()
    .map((ancestor) => ({ id: ancestor, name: byId.get(ancestor)?.name ?? "Folder" }));
}

/**
 * Deletes the project `id` and applies what happens to its children, in one
 * transaction: `lift` moves them up to `id`'s parent first; `cascade` deletes
 * the subtree deepest first. Chats in a deleted project are kept, unlinked, as
 * they always were (Conversation.projectId is SetNull).
 */
export async function deleteProjectFolder(userId: string, id: string, mode: DeleteChildrenMode = "lift") {
  const nodes = await loadOwnerProjectTree(userId);
  const plan = planFolderDelete(nodes, id, mode);
  if (!plan.deleteIds.length) return { deleted: 0, moved: 0 };
  await prisma.$transaction(async (tx) => {
    if (plan.reparent) {
      await tx.project.updateMany({
        where: { id: { in: plan.reparent.ids }, userId },
        data: { parentId: plan.reparent.parentId },
      });
    }
    for (const deleteId of plan.deleteIds) {
      await tx.project.deleteMany({ where: { id: deleteId, userId } });
    }
  });
  return { deleted: plan.deleteIds.length, moved: plan.reparent?.ids.length ?? 0 };
}

/**
 * The chain a chat in `projectId` inherits from, root first, merged into the
 * one `{ name, instructions, files }` the chat route has always prompted with.
 *
 * Scoped to the conversation's owner at every level: a project can only be
 * filed under one of its owner's projects, so a lineage never crosses accounts.
 * Returns null when the project itself is not the owner's.
 */
export async function loadProjectLineage(userId: string, projectId: string) {
  const rows = await prisma.project.findMany({
    where: { userId },
    select: { id: true, parentId: true },
  });
  if (!rows.some((row) => row.id === projectId)) return null;
  const chain = [...ancestorIds(rows, projectId).reverse(), projectId];
  const levels = await prisma.project.findMany({
    where: { userId, id: { in: chain } },
    select: {
      id: true,
      name: true,
      instructions: true,
      files: { select: { id: true, fileName: true, extractedText: true } },
    },
  });
  const byId = new Map(levels.map((level) => [level.id, level]));
  const lineage = chain.map((id) => byId.get(id)).filter((level): level is (typeof levels)[number] => !!level);
  const merged = mergeInheritedProjectContext(lineage);
  return merged ? { merged, depth: lineage.length } : null;
}
