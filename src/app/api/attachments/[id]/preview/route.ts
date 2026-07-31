import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { headObject } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * The first few lines of a text attachment, for the Library's preview tiles.
 *
 * WHY A ROUTE AND NOT A CLIENT FETCH. The library renders up to 300 tiles; a
 * client reading each object to show six lines would pull entire files —
 * megabytes of CSV to render a header row — through the browser, and would do it
 * again on every mount. This reads a bounded prefix on the server and returns
 * only what is drawn.
 *
 * TEXT ONLY, AND THE LIST IS A DENYLIST-FREE ALLOWLIST. A preview is offered for
 * types that are *meaningfully* text: a PDF is bytes that happen to contain some
 * ASCII, and excerpting it produces `%PDF-1.7 …` — noise wearing the shape of
 * content, which is worse than the extension badge the client falls back to.
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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  // Owner-scoped through `prisma` (the guarded client), so someone else's
  // attachment id resolves to nothing rather than to a 403 that confirms it
  // exists — the same no-existence-oracle rule the file route follows.
  const attachment = await prisma.attachment.findFirst({
    where: { id, userId: user.id },
    select: { storageKey: true, mimeType: true },
  });
  if (!attachment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPreviewable(attachment.mimeType)) {
    return NextResponse.json({ text: null, previewable: false });
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
      return NextResponse.json({ text: null, previewable: false });
    }

    const text = decoded.slice(0, MAX_CHARS);
    return NextResponse.json({
      text,
      previewable: true,
      truncated: size > prefix.byteLength || decoded.length > MAX_CHARS,
    });
  } catch {
    // A missing object is not an error worth surfacing — the tile falls back to
    // its extension badge, which is what it would show for a PDF anyway.
    return NextResponse.json({ text: null, previewable: false });
  }
}
