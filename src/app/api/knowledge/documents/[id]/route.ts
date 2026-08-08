import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

const query = z.object({
  page: z.coerce.number().int().min(1).max(20_000).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * Read the durable document representation used by citations.
 *
 * This is intentionally an extracted-text inspector, not an inline file
 * renderer. Every block retains its page/slide/sheet/cell/path locator and OCR
 * confidence, so a reviewer can tell verified text from reconstructed text and
 * jump back to the original attachment separately.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const url = new URL(request.url);
  const parsed = query.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "Invalid query." }, { status: 400 });

  const document = await prisma.knowledgeDocument.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      checksum: true,
      state: true,
      parser: true,
      parserVersion: true,
      version: true,
      supersededById: true,
      pageCount: true,
      error: true,
      createdAt: true,
      indexedAt: true,
      attachmentId: true,
      deletedAt: true,
      _count: { select: { blocks: true, chunks: true } },
    },
  });
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const blocks = await prisma.knowledgeBlock.findMany({
    where: {
      userId: user.id,
      documentId: document.id,
      deletedAt: null,
      ...(parsed.data.page !== undefined ? { page: parsed.data.page } : {}),
      ...(parsed.data.q ? { text: { contains: parsed.data.q, mode: "insensitive" } } : {}),
    },
    orderBy: { ordinal: "asc" },
    take: parsed.data.limit,
    select: {
      id: true,
      ordinal: true,
      type: true,
      text: true,
      page: true,
      slide: true,
      sheet: true,
      cellRange: true,
      path: true,
      lineStart: true,
      lineEnd: true,
      heading: true,
      bbox: true,
      confidence: true,
    },
  });

  const attachment = document.attachmentId
    ? await prisma.attachment.findFirst({
        where: { id: document.attachmentId, userId: user.id, deletedAt: null },
        select: { storageKey: true },
      })
    : null;

  return NextResponse.json({
    document: {
      ...document,
      checksum: `${document.checksum.slice(0, 12)}…`,
      sourceUrl: attachment ? `/api/files/${attachment.storageKey}` : null,
      createdAt: document.createdAt.toISOString(),
      indexedAt: document.indexedAt?.toISOString() ?? null,
      counts: document._count,
    },
    blocks,
  });
}
