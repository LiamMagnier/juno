import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

const query = z.object({
  projectId: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The account's indexed documents and what happened to each one.
 *
 * Ingest runs after the upload response, so the client that uploaded a file has
 * no way to know whether it became citable. This is how it finds out — and why
 * `state` and `error` are both returned verbatim: a document that came back
 * `degraded` because it is a scan is not a bug to hide, it is the one thing the
 * user needs to be told so they can upload a text PDF instead.
 *
 * `stale` versions are excluded. They exist so old citations keep resolving, not
 * to be listed twice under the same file name.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const parsed = query.safeParse({
    projectId: url.searchParams.get("projectId") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query." }, { status: 400 });
  }

  const documents = await prisma.knowledgeDocument.findMany({
    // KnowledgeDocument is in OWNER_COLUMN: userId is not an optional filter.
    where: {
      userId: user.id,
      state: { not: "stale" },
      deletedAt: null,
      ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: parsed.data.limit,
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      state: true,
      parser: true,
      pageCount: true,
      error: true,
      version: true,
      createdAt: true,
      indexedAt: true,
      _count: { select: { blocks: true } },
    },
  });

  return NextResponse.json({
    documents: documents.map((document) => ({
      id: document.id,
      fileName: document.fileName,
      mimeType: document.mimeType,
      state: document.state,
      parser: document.parser,
      pageCount: document.pageCount,
      // The reason a document is degraded or failed, written by the extractor
      // in words meant to be shown, not logged.
      error: document.error,
      version: document.version,
      blockCount: document._count.blocks,
      createdAt: document.createdAt.toISOString(),
      indexedAt: document.indexedAt?.toISOString() ?? null,
    })),
  });
}
