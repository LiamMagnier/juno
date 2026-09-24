/**
 * A design's poster: its first page, drawn by the one renderer, as SVG.
 *
 * Outside its own editor a design used to be its JSON — on the share page, on
 * the chat card, on every library tile (X-20). Every one of those surfaces can
 * show an image, and the renderer that draws the canvas and the SVG export can
 * draw this too, so a poster is not a second picture of the design that could
 * drift from the first: it is the same `renderPageSvg`, cropped to what the
 * page actually draws (`fit: "content"`), with nothing in it that belongs to
 * the editor (`includeNodeIds` stays off).
 *
 * It is served to an `<img>`, and that fixes what it may contain. An SVG
 * loaded as an image runs no script and fetches nothing, so the only pictures
 * it can show are the ones already inside it as `data:` URLs. A Library image
 * in a design is an app path (`/api/files/…`) behind the owner's session: in a
 * poster it would be a hole at best, and on a public share it would publish the
 * owner's storage key. So every asset that is not inline data is swapped for a
 * quiet neutral fill — a picture-shaped placeholder, never a hole and never a
 * path. (Inlining the owner's own files is the asset store's job, R-064.)
 *
 * Server-side only in practice: the response helper hashes with Node's crypto.
 * Client code wants the URLs in `poster-url.ts`, which import nothing.
 */

import { createHash } from "crypto";
import { parseStoredDesignDocument } from "@/lib/design/migrations";
import { renderPageSvg } from "@/lib/design/render";
import type { DesignDocument } from "@/lib/design/types";

/**
 * The largest stored body a poster will parse and draw, in characters.
 *
 * Five times the 200,000-character budget every write path now enforces
 * (`store.ts`, and the chat path since X-08). Anything bigger predates those
 * checks, and drawing it would be a large parse and render on the one Node
 * process, on a route the public can reach. It gets the glyph instead.
 */
export const MAX_POSTER_SOURCE_CHARS = 1_000_000;

/** A 1×1 SVG at the page-tint strength the renderer already uses for an image
 *  with no asset (`rgba(0,0,0,0.06)`), so a missing picture reads the same
 *  whichever way it went missing. It stretches to whatever box it fills. */
const PLACEHOLDER_IMAGE_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%23000' fill-opacity='0.06'/%3E%3C/svg%3E";

/**
 * The stored design as a poster: the SVG of its first page, or null when the
 * body is not a design this build can read.
 *
 * Null, never a throw and never a half-drawn image: the routes answer 404 and
 * every caller falls back to the type glyph, which is true. The page drawn is
 * `pages[0]` — the page a design opens on, and the one a person made first.
 */
export function designPosterSvg(content: string): string | null {
  if (typeof content !== "string" || content.length === 0 || content.length > MAX_POSTER_SOURCE_CHARS) return null;

  let doc: DesignDocument;
  try {
    doc = parseStoredDesignDocument(content);
  } catch {
    return null;
  }
  const page = doc.pages[0];
  if (!page) return null;

  try {
    return renderPageSvg(withInlineAssetsOnly(doc), page.id, { fit: "content" }).svg;
  } catch {
    // The document validated, so this is a renderer bug on some shape nobody
    // has drawn before. A glyph is the honest answer to it; a 500 on an image
    // request is a broken-picture icon in the middle of somebody's grid.
    return null;
  }
}

/** The document with every asset that is not inline image data replaced by the
 *  placeholder — see the header. The input is never mutated. */
function withInlineAssetsOnly(doc: DesignDocument): DesignDocument {
  let replaced = false;
  const assets: DesignDocument["assets"] = {};
  for (const [id, asset] of Object.entries(doc.assets)) {
    if (asset.url.startsWith("data:image/")) {
      assets[id] = asset;
    } else {
      assets[id] = { ...asset, url: PLACEHOLDER_IMAGE_URL };
      replaced = true;
    }
  }
  return replaced ? { ...doc, assets } : doc;
}

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

/**
 * The policy a poster is served under, whichever route serves it.
 *
 * Nothing may load but the inline images it carries, and inline styles, which
 * is where the renderer says `mix-blend-mode`. A poster opened on its own, as
 * a document rather than an image, therefore still runs nothing and reaches
 * nothing — the renderer never emits script, and this makes that a rule rather
 * than a habit.
 */
export const POSTER_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/** Cache for a drawing that can never change under its URL. */
export const POSTER_CACHE_IMMUTABLE = "private, max-age=31536000, immutable";
/** Cache for a drawing that can: keep it, but ask before every use. */
export const POSTER_CACHE_REVALIDATE = "private, no-cache";
/** Cache for the public poster: the share page's own five-minute horizon. */
export const POSTER_CACHE_PUBLIC = "public, max-age=300";

/**
 * A poster as an HTTP response, with a strong ETag over the bytes.
 *
 * The ETag is what makes `no-cache` cheap: a tile whose design has not changed
 * revalidates to a 304 with no body. It is taken over the rendered SVG rather
 * than the stored JSON so a change to the renderer is a change to the tag —
 * a poster is never held on to because only the drawing, not the design,
 * moved.
 */
export function posterResponse(svg: string, request: Request, cacheControl: string): Response {
  const etag = `"${createHash("sha256").update(svg).digest("base64url").slice(0, 32)}"`;
  const headers = new Headers({
    "Content-Type": "image/svg+xml",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": POSTER_CSP,
    "Cache-Control": cacheControl,
    ETag: etag,
  });
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(svg, { status: 200, headers });
}

/** RFC 9110's weak comparison, which is the one `If-None-Match` uses. */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}
