import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";
import { getUserPlan } from "@/lib/usage";
import { libraryQuotaBytes, libraryUsageBytes } from "@/lib/library";

export const runtime = "nodejs";

// Every file/image the user has sent in chat — the Library.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kind = new URL(req.url).searchParams.get("kind");
  const searchParams = new URL(req.url).searchParams;
  const includeDeleted = searchParams.get("includeDeleted") === "true";
  const requestedLimit = Number(searchParams.get("limit") ?? "100");
  const limit = Number.isInteger(requestedLimit) ? Math.min(300, Math.max(1, requestedLimit)) : 100;
  const cursor = searchParams.get("cursor");
  const atts = await prisma.attachment.findMany({
    where: {
      userId: user.id,
      deletedAt: includeDeleted ? { not: null } : null,
      ...(kind === "IMAGE" || kind === "FILE" ? { kind } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
    include: { _count: { select: { versions: true } } },
  });
  const hasMore = atts.length > limit;
  const page = hasMore ? atts.slice(0, limit) : atts;

  // Structured-extraction state, joined in one query rather than per row.
  // Ingest runs after the upload response, so this is the only place the user
  // finds out that their scan produced nothing citable — and `error` is carried
  // through verbatim because the extractor already wrote it to be read.
  const documents = page.length
    ? await prisma.knowledgeDocument.findMany({
        where: {
          userId: user.id,
          attachmentId: { in: page.map((a) => a.id) },
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

  // Ascending version above, so a later version overwrites an earlier one here.
  const byAttachment = new Map(
    documents
      .filter((document) => document.attachmentId)
      .map((document) => [
        document.attachmentId as string,
        {
          documentId: document.id,
          state: document.state,
          error: document.error,
          pageCount: document.pageCount,
          blockCount: document._count.blocks,
        },
      ])
  );

  const items = await Promise.all(
    page.map(async (a) => {
      const serialized = await serializeAttachment(a);
      return {
        ...serialized,
        ...(a.deletedAt ? { url: "" } : {}),
        createdAt: a.createdAt.toISOString(),
        conversationId: a.conversationId,
        version: a.version,
        versionCount: a._count.versions,
        origin: a.origin,
        parserState: a.parserState,
        parserVersion: a.parserVersion,
        deletedAt: a.deletedAt?.toISOString() ?? null,
        // null for anything no extractor claims — a photo is not a document that
        // failed to index, and the UI renders nothing for it.
        knowledge: byAttachment.get(a.id) ?? null,
      };
    }),
  );

  const [plan, usedBytes] = await Promise.all([getUserPlan(user.id), libraryUsageBytes(user.id)]);
  const quotaBytes = libraryQuotaBytes(plan);
  return NextResponse.json({
    items,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    storage: { usedBytes, quotaBytes, remainingBytes: Math.max(0, quotaBytes - usedBytes) },
  });
}
