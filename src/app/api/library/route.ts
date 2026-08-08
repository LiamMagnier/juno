import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";

export const runtime = "nodejs";

// Every file/image the user has sent in chat — the Library.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kind = new URL(req.url).searchParams.get("kind");
  const atts = await prisma.attachment.findMany({
    where: { userId: user.id, ...(kind === "IMAGE" || kind === "FILE" ? { kind } : {}) },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  // Structured-extraction state, joined in one query rather than per row.
  // Ingest runs after the upload response, so this is the only place the user
  // finds out that their scan produced nothing citable — and `error` is carried
  // through verbatim because the extractor already wrote it to be read.
  const documents = atts.length
    ? await prisma.knowledgeDocument.findMany({
        where: {
          userId: user.id,
          attachmentId: { in: atts.map((a) => a.id) },
          state: { not: "stale" },
        },
        orderBy: { version: "asc" },
        select: {
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
          state: document.state,
          error: document.error,
          pageCount: document.pageCount,
          blockCount: document._count.blocks,
        },
      ])
  );

  const items = await Promise.all(
    atts.map(async (a) => ({
      ...(await serializeAttachment(a)),
      createdAt: a.createdAt.toISOString(),
      conversationId: a.conversationId,
      // null for anything no extractor claims — a photo is not a document that
      // failed to index, and the UI renders nothing for it.
      knowledge: byAttachment.get(a.id) ?? null,
    }))
  );

  return NextResponse.json({ items });
}
