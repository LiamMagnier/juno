import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { readDocumentForViewer } from "@/lib/documents/reader";

export const runtime = "nodejs";

/**
 * An office document as the side viewer draws it: headings, paragraphs, lists,
 * tables, slides and sheets in reading order (see `lib/documents/reader.ts`).
 *
 * Owner-scoped through `prisma`, the guarded client, and 404 rather than 403
 * for someone else's id — the no-existence-oracle rule `/api/files` and the
 * preview route follow. The structure of a document is the document.
 *
 * Rate-limited because a file the index has not reached is read and parsed on
 * this request, and a parse is the one expensive thing here. The index path
 * is a query, but the two are one route, so the limit covers both — generously
 * enough that nobody opening files to read them will ever meet it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const attachment = await prisma.attachment.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true, storageKey: true, fileName: true, mimeType: true, size: true },
  });
  if (!attachment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const limit = await rateLimit({ key: `document-view:${user.id}`, limit: 240, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many documents opened. Try again in a few minutes." }, { status: 429 });
  }

  const document = await readDocumentForViewer(user.id, attachment);
  return NextResponse.json(document, {
    headers: {
      // Private: one person's document. Short: indexing can still improve on
      // what a just-uploaded file returned, and a reopen should see it.
      "Cache-Control": document.status === "empty" ? "no-store" : "private, max-age=120",
    },
  });
}
