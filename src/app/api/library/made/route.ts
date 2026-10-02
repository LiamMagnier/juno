import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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
/** How much of an artifact's source rides along for its miniature (as /api/artifacts). */
const PREVIEW_CHARS = 900;

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
            conversation: { select: { projectId: true, agentId: true } },
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
            session: { select: { projectId: true, conversationId: true, agentId: true } },
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

  // Who made each item, when an agent did: one owner-scoped read for the page.
  const agentOf = new Map<string, string>();
  artifacts.forEach((a) => { if (a.conversation?.agentId) agentOf.set(`artifact:${a.id}`, a.conversation.agentId); });
  deliverables.forEach((d) => { if (d.session.agentId) agentOf.set(`deliverable:${d.id}`, d.session.agentId); });
  const agentIds = [...new Set(agentOf.values())];
  if (agentIds.length > 0) {
    const agents = await prisma.agent.findMany({
      where: { userId: user.id, id: { in: agentIds }, deletedAt: null },
      select: { id: true, name: true, avatar: true },
    });
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    for (const item of [...artifactItems, ...deliverableItems]) {
      const agent = byId.get(agentOf.get(`${item.kind}:${item.id}`) ?? "");
      if (agent) item.agent = { id: agent.id, name: agent.name, avatar: agent.avatar };
    }
  }

  // The opening of each artifact's newest version, for its miniature: cut in
  // Postgres (an artifact's content is unbounded), and never for a design,
  // whose tile draws its poster. The ids are this owner's, read above.
  const page = mergeLibraryPages([artifactItems, deliverableItems], limit);
  const previewed = page.items.filter((item) => item.kind === "artifact" && item.type !== "DESIGN").map((item) => item.id);
  if (previewed.length > 0) {
    const rows = await prisma.$queryRaw<{ artifactId: string; preview: string | null }[]>`
      SELECT DISTINCT ON (v."artifactId")
             v."artifactId" AS "artifactId",
             left(v."content", ${PREVIEW_CHARS}::int) AS "preview"
      FROM "ArtifactVersion" v
      WHERE v."artifactId" IN (${Prisma.join(previewed)})
      ORDER BY v."artifactId", v."version" DESC
    `;
    const previews = new Map(rows.map((row) => [row.artifactId, row.preview]));
    for (const item of page.items) if (previews.get(item.id)) item.preview = previews.get(item.id);
  }

  return NextResponse.json(page, {
    headers: { "Cache-Control": "no-store" },
  });
}
