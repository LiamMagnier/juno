import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getViewUrl } from "@/lib/storage";
import { MOVE_REFUSAL_MESSAGES, validateNewChild } from "@/lib/projects/project-tree";
import { loadOwnerProjectTree } from "@/lib/projects/project-tree-server";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      files: {
        where: { fileName: "__cover__" },
        select: { storageKey: true },
        take: 1,
      },
      _count: { select: { conversations: true, files: true } },
    },
  });

  return NextResponse.json({
    projects: await Promise.all(
      projects.map(async (p) => ({
        id: p.id,
        name: p.name,
        nameSource: p.nameSource,
        // The folder this project sits in (null = top level). The list stays
        // flat; clients build the tree with buildProjectForest.
        parentId: p.parentId,
        instructions: p.instructions,
        starred: p.starred,
        updatedAt: p.updatedAt.toISOString(),
        conversationCount: p._count.conversations,
        fileCount: p._count.files,
        coverUrl: p.files[0] ? await getViewUrl(p.files[0].storageKey) : null,
      }))
    ),
  });
}

const createSchema = z.object({
  // Optional: an unnamed project is created as "Untitled project" and gets an
  // auto-generated name from its first chat.
  name: z.string().trim().min(1).max(120).optional(),
  // No app-side character cap — model context is the real limit.
  instructions: z.string().optional(),
  /** Create it as a subfolder of this project (one of the caller's own). */
  parentId: z.string().min(1).max(200).nullable().optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const parentId = parsed.data.parentId ?? null;
  if (parentId) {
    // The owner's own tree only, so another account's project id is simply
    // not a folder here (404), and the depth limit is checked against it.
    const check = validateNewChild(await loadOwnerProjectTree(user.id), parentId);
    if (!check.ok) {
      return NextResponse.json(
        { error: MOVE_REFUSAL_MESSAGES[check.reason], reason: check.reason },
        { status: check.reason === "parent_not_found" ? 404 : 400 }
      );
    }
  }

  const project = await prisma.project.create({
    data: {
      userId: user.id,
      parentId,
      name: parsed.data.name ?? "Untitled project",
      nameSource: parsed.data.name ? "manual" : "default",
      instructions: parsed.data.instructions ?? "",
    },
    select: { id: true },
  });
  return NextResponse.json({ id: project.id }, { status: 201 });
}
