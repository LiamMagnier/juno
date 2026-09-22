import "server-only";
import { deleteObject, getObjectBytes, putObject } from "@/lib/storage";
import { canRaster, canRenderDocumentPage, renderDocumentPage } from "@/lib/media/raster";

/**
 * The first page of a document, as a picture, rendered once and kept.
 *
 * WHAT THIS REPLACES. Every non-image attachment in the Library, the picker
 * and the composer drew as the letters "PDF" on a grey square. `FilePreview`
 * already had the right idea for text files — show the first lines, so the
 * tile is recognisable — but a PDF has no lines to slice, and the excerpt
 * route says so in its own header: excerpting a PDF produces `%PDF-1.7 …`,
 * "noise wearing the shape of content". So PDFs got the one thing the tile was
 * written to avoid: a label instead of a look.
 *
 * WHY IT IS CACHED IN THE BUCKET AND NOT COMPUTED PER REQUEST. Rendering a
 * page is pdf.js plus a rasteriser: a few hundred milliseconds for a simple
 * page and appreciably more for a dense one. The Library asks for up to 300
 * tiles at a time and the picker reopens constantly, so a route that rendered
 * on every GET would make scrolling a file list the most expensive thing in
 * the product. The rendered JPEG goes back to storage beside the object it
 * came from, and every later request is a read.
 *
 * WHY THE KEY IS DERIVED AND NOT STORED. A column would need a migration, a
 * backfill and a write path on every upload, to hold a value that is a pure
 * function of the storage key it sits beside. Deriving it means a thumbnail
 * can appear for the whole existing library the moment this ships, with no
 * backfill at all — and a cache miss is indistinguishable from a cold entry,
 * which is exactly what it is.
 */

/** Width of the stored rendering, in device pixels. */
const THUMBNAIL_WIDTH = 640;

/**
 * 640 px, not the 320 a grid tile occupies.
 *
 * The Library's grid tile is ~320 CSS px and a 2× display doubles that; the
 * inspector shows the same object larger still. One rendering has to serve all
 * of them, and a thumbnail that is soft on a retina laptop is the failure the
 * whole feature exists to avoid. At JPEG 82 a rendered page costs tens of
 * kilobytes, so the larger size is bought with storage nobody notices.
 */
export const THUMBNAIL_CONTENT_TYPE = "image/jpeg";

/** Where the rendering of `storageKey` lives. Pure; no I/O. */
export function thumbnailObjectKey(storageKey: string): string {
  return `${storageKey}.thumb.jpg`;
}

/**
 * Whether a thumbnail could exist for this attachment.
 *
 * Deliberately a cheap, synchronous answer on the MIME type alone, because it
 * is what the preview endpoint tells the client, and the client uses it to
 * decide whether to put an `<img>` on screen at all. The real answer — "this
 * particular file rendered" — can only come from rendering it, and the tile
 * handles that with `onError`.
 */
export function canThumbnailAttachment(attachment: {
  kind: string;
  mimeType: string;
}): boolean {
  if (attachment.kind === "IMAGE") return false; // an image is its own thumbnail
  return canRenderDocumentPage(attachment.mimeType);
}

/** The route that serves it. One string, so the client and server agree. */
export function attachmentThumbnailPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/thumbnail`;
}

export interface ThumbnailBytes {
  bytes: Uint8Array;
  mimeType: string;
  /** True when this request did the rendering rather than reading the cache. */
  rendered: boolean;
}

/**
 * The cached rendering, rendering it first if this is the first ask.
 *
 * `null` means no picture is possible: not a renderable format, no rasteriser
 * on this platform, an encrypted or damaged file. The caller answers 404 and
 * the tile keeps the extension badge it already had — which is what every
 * other PDF viewer shows for a file it cannot open, so nothing about the UI
 * looks broken.
 */
export async function loadAttachmentThumbnail(attachment: {
  kind: string;
  mimeType: string;
  storageKey: string;
}): Promise<ThumbnailBytes | null> {
  if (!canThumbnailAttachment(attachment)) return null;

  const cacheKey = thumbnailObjectKey(attachment.storageKey);
  try {
    const cached = await getObjectBytes(cacheKey);
    if (cached.bytes.byteLength > 0) {
      return { bytes: cached.bytes, mimeType: THUMBNAIL_CONTENT_TYPE, rendered: false };
    }
  } catch {
    // A miss, not an error: nothing has rendered this object yet. Fall through.
  }

  if (!(await canRaster())) return null;

  let source: Uint8Array;
  try {
    source = (await getObjectBytes(attachment.storageKey)).bytes;
  } catch {
    // The object is gone — a deleted attachment whose row is still being read,
    // or storage that is momentarily unreachable. Neither is a picture.
    return null;
  }

  const rendered = await renderDocumentPage({
    bytes: source,
    page: 1,
    targetWidth: THUMBNAIL_WIDTH,
  });
  if (!rendered) return null;

  // Best-effort: a bucket that refuses the write costs this request nothing
  // but the render, and the next one will try again. Failing the response
  // because the *cache* could not be filled would turn a slow path into a
  // broken one.
  await putObject(cacheKey, rendered.bytes, THUMBNAIL_CONTENT_TYPE).catch((error) => {
    console.warn("[thumbnail] could not cache a rendered page", {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return { bytes: rendered.bytes, mimeType: rendered.mimeType, rendered: true };
}

/**
 * Drop the cached rendering for a storage key.
 *
 * A thumbnail is a picture of the user's document, so it answers to the same
 * deletion rules the document does — account deletion purges it alongside the
 * object it was rendered from.
 */
export async function deleteAttachmentThumbnail(storageKey: string): Promise<void> {
  await deleteObject(thumbnailObjectKey(storageKey)).catch(() => undefined);
}
