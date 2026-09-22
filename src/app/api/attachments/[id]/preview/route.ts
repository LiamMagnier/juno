import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { headObject } from "@/lib/storage";
import { attachmentThumbnailPath, canThumbnailAttachment } from "@/lib/attachments/thumbnail";

export const runtime = "nodejs";

/**
 * What a Library tile needs to draw itself: a few lines of the file, or the
 * address of a picture of its first page.
 *
 * WHY A ROUTE AND NOT A CLIENT FETCH. The library renders up to 300 tiles; a
 * client reading each object to show six lines would pull entire files —
 * megabytes of CSV to render a header row — through the browser, and would do it
 * again on every mount. This reads a bounded prefix on the server and returns
 * only what is drawn.
 *
 * TWO SOURCES OF TEXT, AND THE SECOND ONE IS NEW. A file that is
 * *meaningfully* text is excerpted from its own bytes: slicing a PDF produces
 * `%PDF-1.7 …`, noise wearing the shape of content, which is worse than the
 * extension badge. But a PDF, a deck or a workbook has already been read into
 * `KnowledgeBlock` rows by structured extraction, in reading order — so where
 * the bytes cannot be excerpted, the *extraction* can, and the tile shows the
 * document's actual opening words instead of its file format.
 *
 * `thumbnailUrl` is the better answer again where it exists, and it REPLACES
 * the excerpt rather than joining it: the first page of a PDF, drawn, is about
 * to cover whatever was underneath, and reading twelve blocks for each of 300
 * tiles to draw six lines nobody sees is six hundred queries spent on nothing.
 * So a file that can be rendered returns a picture and no text, and one that
 * cannot returns its opening words.
 */
const PREVIEWABLE = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/sql",
];

/** Enough for six or seven lines in the tile, and small enough to be free. */
const MAX_CHARS = 900;
/**
 * Read a little more than we return: UTF-8 runs up to 4 bytes per character.
 *
 * This is the *only* amount ever read. The route used to fetch the whole object
 * and then slice off this prefix, so previewing a 200 MB CSV cost 200 MB of RSS
 * to render six lines — and the library requests up to 300 tiles at a time.
 */
const MAX_BYTES = MAX_CHARS * 4;

function isPreviewable(mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  return PREVIEWABLE.some((prefix) => type.startsWith(prefix));
}

interface PreviewBody {
  text: string | null;
  previewable: boolean;
  thumbnailUrl: string | null;
  truncated?: boolean;
}

/**
 * The answer, cached in the browser only when there is an answer.
 *
 * Indexing settles seconds after the upload response, so a tile that asks
 * during that window legitimately gets nothing — and caching THAT for five
 * minutes would leave a perfectly readable file looking blank until the page
 * was reloaded. So an empty answer is never stored and a real one is: a
 * library scroll then costs one request per tile per session rather than one
 * per mount. `private` because this is one person's document.
 */
function json(body: PreviewBody): NextResponse {
  const hasContent = Boolean(body.text || body.thumbnailUrl);
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": hasContent ? "private, max-age=300" : "no-store",
    },
  });
}

/**
 * The opening of the document as structured extraction read it.
 *
 * Bounded by `take`, not by slicing a whole document: the blocks of a
 * 300-page report are tens of thousands of rows, and the tile shows six lines
 * of them. Headings come through as their own blocks, which is why the join is
 * a plain space — the first line of most documents is its title.
 */
async function extractedOpening(userId: string, attachmentId: string): Promise<string | null> {
  const document = await prisma.knowledgeDocument.findFirst({
    where: { userId, attachmentId, deletedAt: null, supersededById: null },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (!document) return null;

  const blocks = await prisma.knowledgeBlock.findMany({
    where: { userId, documentId: document.id, deletedAt: null },
    orderBy: { ordinal: "asc" },
    select: { text: true },
    take: 12,
  });
  const text = blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_CHARS);
  return text || null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  // Owner-scoped through `prisma` (the guarded client), so someone else's
  // attachment id resolves to nothing rather than to a 403 that confirms it
  // exists — the same no-existence-oracle rule the file route follows.
  const attachment = await prisma.attachment.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { storageKey: true, mimeType: true, kind: true },
  });
  if (!attachment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const thumbnailUrl = canThumbnailAttachment(attachment) ? attachmentThumbnailPath(id) : null;

  if (!isPreviewable(attachment.mimeType)) {
    /*
     * Not excerptable from its bytes — but structured extraction may have read
     * it, and a page picture may be renderable. Either beats "PDF" on a square.
     *
     * The excerpt is SKIPPED when a page picture is coming, and that is a cost
     * decision rather than a preference: the Library asks for up to 300 tiles
     * at once, and reading twelve blocks for each of them is six hundred
     * queries to draw six lines that the image is about to cover anyway. A
     * file whose page cannot be rendered falls back to its extension badge,
     * which is what it showed before any of this existed.
     */
    const text = thumbnailUrl ? null : await extractedOpening(user.id, id).catch(() => null);
    return json({ text, previewable: !!text, thumbnailUrl });
  }

  try {
    // `size` is the object's real length, not the row's recorded one — it is
    // what tells the tile whether there is more text than it is showing.
    const { size, prefix } = await headObject(attachment.storageKey, MAX_BYTES);
    // `fatal: false` on purpose: a prefix can cut a multi-byte character in half,
    // and one replacement glyph at the end of an excerpt is a better outcome
    // than throwing away the preview.
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(prefix);

    // A binary file that slipped past the mime check reads as replacement
    // characters. Two per hundred is enough to call it: real prose in any script
    // decodes cleanly, and a preview of `����` helps nobody.
    const replacements = (decoded.match(/�/g) ?? []).length;
    if (replacements > decoded.length * 0.02) {
      return json({ text: null, previewable: false, thumbnailUrl });
    }

    const text = decoded.slice(0, MAX_CHARS);
    return json({
      text,
      previewable: true,
      thumbnailUrl,
      truncated: size > prefix.byteLength || decoded.length > MAX_CHARS,
    });
  } catch {
    // A missing object is not an error worth surfacing — the tile falls back to
    // its extension badge, which is what it would show for a PDF anyway.
    return json({ text: null, previewable: false, thumbnailUrl });
  }
}
