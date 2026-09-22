import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { loadAttachmentThumbnail } from "@/lib/attachments/thumbnail";

export const runtime = "nodejs";

/**
 * A picture of the document's first page, for the tile that used to say "PDF".
 *
 * OWNER-SCOPED THROUGH `prisma`, the guarded client, so someone else's
 * attachment id resolves to nothing rather than to a 403 that confirms it
 * exists — the same no-existence-oracle rule `/api/files` and the excerpt
 * route follow. A rendering of a page is the page: it leaks the document's
 * content, so it is exactly as private as the object it came from.
 *
 * A file that cannot be rendered — an encrypted PDF, a platform with no
 * rasteriser, an object that has gone — answers 404 and the tile keeps the
 * extension badge it already had.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const attachment = await prisma.attachment.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { kind: true, mimeType: true, storageKey: true },
  });
  if (!attachment) return new NextResponse("Not found", { status: 404 });

  const thumbnail = await loadAttachmentThumbnail(attachment);
  if (!thumbnail) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(thumbnail.bytes), {
    headers: {
      "Content-Type": thumbnail.mimeType,
      "Content-Length": String(thumbnail.bytes.byteLength),
      /*
       * `private`, and a year.
       *
       * Private because this is one person's document and a shared cache must
       * never hold it. A year because the bytes behind an attachment id never
       * change — a replacement is a new version with a new storage key, and a
       * deletion 404s here before any cache is consulted. `immutable` is what
       * stops a browser revalidating 300 tiles on every visit to the Library.
       */
      "Cache-Control": "private, max-age=31536000, immutable",
      // The rendering is a picture, never a document to be interpreted: a
      // sniffed content type is how an image route becomes an HTML one.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
