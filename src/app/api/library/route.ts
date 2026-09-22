import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";
import { getUserPlan } from "@/lib/usage";
import { libraryQuotaBytes, libraryUsageBytes } from "@/lib/library";

export const runtime = "nodejs";

/**
 * The orderings the Library offers. Each ends on `id` so two rows with the same
 * key (two files added in one second, two files with one name) still have a
 * fixed order, which is what lets a cursor resume exactly where the last page
 * stopped under ANY of them, not only under the default.
 */
const ORDER_BY = {
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
  name: [{ fileName: "asc" }, { id: "asc" }],
  size: [{ size: "desc" }, { id: "desc" }],
} satisfies Record<string, Prisma.AttachmentOrderByWithRelationInput[]>;

type LibrarySort = keyof typeof ORDER_BY;

/** Long enough for any real file name, short enough that a pasted essay is not a query. */
const MAX_QUERY_LENGTH = 200;

/**
 * Every file and image the user has uploaded or sent in chat: the Library.
 *
 * Search, the type filter, the sort and the counts all run HERE rather than in
 * the browser. They used to run over whatever pages the client had loaded
 * (the first 100 rows), so a search missed every older file, "All 100" was a
 * page size presented as a total, and "Largest first" sorted a sample. The
 * page asks for what it shows and gets the honest answer for all of it.
 *
 * Parameters (all optional; the composer's library picker sends none, so the
 * defaults are its contract): `q` (case-insensitive substring of the name),
 * `kind` (IMAGE | FILE), `sort` (newest | oldest | name | size),
 * `includeDeleted` (the Recently deleted view), `limit` and `cursor`.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const searchParams = new URL(req.url).searchParams;
  const rawKind = searchParams.get("kind");
  const kind = rawKind === "IMAGE" || rawKind === "FILE" ? rawKind : null;
  const q = (searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const rawSort = searchParams.get("sort");
  const sort: LibrarySort = rawSort && rawSort in ORDER_BY ? (rawSort as LibrarySort) : "newest";
  const includeDeleted = searchParams.get("includeDeleted") === "true";
  const requestedLimit = Number(searchParams.get("limit") ?? "100");
  const limit = Number.isInteger(requestedLimit) ? Math.min(300, Math.max(1, requestedLimit)) : 100;
  const cursor = searchParams.get("cursor");

  // The view (library or Recently deleted), then the query, then the type
  // filter. The counts are taken one level up from the rows: the segmented
  // control's "Images 3" has to mean "3 images match this search" whichever
  // segment is selected, and `total` is the whole view, which is how the page
  // tells an empty library from a search that matched nothing.
  const inView: Prisma.AttachmentWhereInput = {
    userId: user.id,
    deletedAt: includeDeleted ? { not: null } : null,
  };
  const matching: Prisma.AttachmentWhereInput = q
    ? { ...inView, fileName: { contains: q, mode: "insensitive" } }
    : inView;
  const where: Prisma.AttachmentWhereInput = kind ? { ...matching, kind } : matching;

  // Counts and storage describe the whole result, not a page of it, so they
  // are computed once, on the first page. A cursor request is "more of the
  // same list" and the client keeps what the first page told it.
  const firstPage = !cursor;
  const [atts, byKind, unfilteredTotal] = await Promise.all([
    prisma.attachment.findMany({
      where,
      orderBy: ORDER_BY[sort],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
      include: { _count: { select: { versions: true } } },
    }),
    firstPage ? prisma.attachment.groupBy({ by: ["kind"], where: matching, _count: { _all: true } }) : null,
    firstPage && q ? prisma.attachment.count({ where: inView }) : null,
  ]);
  let counts: { all: number; IMAGE: number; FILE: number } | null = null;
  if (byKind) {
    counts = { all: 0, IMAGE: 0, FILE: 0 };
    for (const group of byKind) {
      counts[group.kind] = group._count._all;
      counts.all += group._count._all;
    }
  }

  const hasMore = atts.length > limit;
  const page = hasMore ? atts.slice(0, limit) : atts;

  // Structured-extraction state, joined in one query rather than per row.
  // Ingest runs after the upload response, so this is the only place the user
  // finds out that their scan produced nothing citable, and `error` is carried
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
        // null for anything no extractor claims: a photo is not a document that
        // failed to index, and the UI renders nothing for it.
        knowledge: byAttachment.get(a.id) ?? null,
      };
    }),
  );

  const nextCursor = hasMore ? page[page.length - 1]?.id ?? null : null;
  if (!firstPage || !counts) return NextResponse.json({ items, nextCursor });

  const [plan, usedBytes] = await Promise.all([getUserPlan(user.id), libraryUsageBytes(user.id)]);
  const quotaBytes = libraryQuotaBytes(plan);
  return NextResponse.json({
    items,
    nextCursor,
    counts,
    // Without a query the counts already cover the whole view.
    total: unfilteredTotal ?? counts.all,
    storage: { usedBytes, quotaBytes, remainingBytes: Math.max(0, quotaBytes - usedBytes) },
  });
}
