import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { artifactInProjectWhere, artifactProjectId } from "@/lib/artifact-access";
import { artifactPath } from "@/lib/artifact-links";
import {
  afterCursorWhere,
  decodeLibraryMadeCursor,
  deliverableType,
  mergeLibraryPages,
  type LibraryMadeItem,
} from "@/lib/library-made";

export const runtime = "nodejs";

const MAX_QUERY_LENGTH = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * GET /api/library/made — everything Juno made for the person, in one list
 * (src/lib/library-made.ts): chat artifacts and task deliverables (Office
 * documents, spreadsheets, decks, PDFs, reports, sites…), each with `kind`
 * ("artifact" | "deliverable") and `type`.
 *
 * `q` (case-insensitive title substring), `kind`, `projectId`, `limit`
 * (1–100) and `cursor` (the previous page's `nextCursor`). Trashed items of
 * either kind are left out. Deliverables are read-only references here; they
 * open through their own download route.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const rawKind = params.get("kind");
  const kind = rawKind === "artifact" || rawKind === "deliverable" ? rawKind : null;
  if (rawKind && !kind) return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
  const projectId = params.get("projectId")?.trim() || null;
  const requested = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(requested) ? Math.min(MAX_LIMIT, Math.max(1, requested)) : DEFAULT_LIMIT;
  const rawCursor = params.get("cursor");
  const cursor = decodeLibraryMadeCursor(rawCursor);
  if (rawCursor && !cursor) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });

  const title = q ? { title: { contains: q, mode: "insensitive" as const } } : {};

  const [artifacts, deliverables] = await Promise.all([
    kind === "deliverable"
      ? []
      : prisma.artifact.findMany({
          where: {
            userId: user.id,
            deletedAt: null,
            ...title,
            AND: [afterCursorWhere(cursor), projectId ? artifactInProjectWhere(projectId) : {}],
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          select: {
            id: true,
            title: true,
            type: true,
            currentVersion: true,
            conversationId: true,
            projectId: true,
            createdAt: true,
            updatedAt: true,
            conversation: { select: { projectId: true } },
          },
        }),
    kind === "artifact"
      ? []
      : prisma.workArtifact.findMany({
          where: {
            userId: user.id,
            deletedAt: null,
            ...title,
            AND: [afterCursorWhere(cursor), projectId ? { session: { projectId } } : {}],
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          select: {
            id: true,
            title: true,
            kind: true,
            mimeType: true,
            currentVersion: true,
            validatedAt: true,
            createdAt: true,
            updatedAt: true,
            session: { select: { projectId: true, conversationId: true } },
          },
        }),
  ]);

  const artifactItems: LibraryMadeItem[] = artifacts.map((a) => ({
    kind: "artifact",
    id: a.id,
    type: a.type,
    title: a.title,
    version: a.currentVersion,
    projectId: artifactProjectId(a),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    href: artifactPath(a.id),
    conversationId: a.conversationId,
  }));
  const deliverableItems: LibraryMadeItem[] = deliverables.map((d) => ({
    kind: "deliverable",
    id: d.id,
    type: deliverableType(d.kind),
    title: d.title,
    version: d.currentVersion,
    projectId: d.session.projectId,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    href: `/api/work/artifacts/${encodeURIComponent(d.id)}/download`,
    conversationId: d.session.conversationId,
    mimeType: d.mimeType,
    validated: d.validatedAt !== null,
  }));

  return NextResponse.json(mergeLibraryPages([artifactItems, deliverableItems], limit), {
    headers: { "Cache-Control": "no-store" },
  });
}
