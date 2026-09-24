/**
 * Where a design's poster lives.
 *
 * A poster is the server's drawing of a design's first page (see
 * `src/lib/design/poster.ts`), served as `image/svg+xml` so every surface that
 * shows a design — a library tile, an Artifacts row, the chat card, the share
 * page — can put it in an `<img>` and get a picture with no script, no network
 * and no access to the page it sits in. The JSON a design is stored as is never
 * what anyone meant by "show me the design" (X-20).
 *
 * This module is deliberately import-free so client components can use it
 * without pulling the renderer, Prisma or anything `server-only` into their
 * bundle. The URLs are the whole contract; the routes behind them own the
 * rendering, the access checks and the caching.
 */

/**
 * The owner's poster for one artifact: `/api/artifacts/{id}/poster[?v=n]`.
 *
 * With a version, the URL names one drawing for good — the route caches a
 * sealed version as immutable, so a grid that pins its tiles to versions pays
 * for each picture once. Without one, it is "whatever is current", revalidated
 * on every load.
 *
 * A version that is not a positive whole number is dropped rather than sent:
 * the route would answer 404 and the caller would draw a broken image, when
 * the current poster is the nearest true picture of the same design. It is a
 * caller bug either way, and this is the failure that still shows something.
 */
export function designPosterUrl(artifactId: string, version?: number): string {
  const base = `/api/artifacts/${encodeURIComponent(artifactId)}/poster`;
  if (version === undefined || !Number.isSafeInteger(version) || version < 1) return base;
  return `${base}?v=${version}`;
}

/**
 * The public poster behind a share link: `/share/{token}/poster`.
 *
 * It lives beside the share page rather than under `/api/`, because it answers
 * signed-out visitors and link unfurlers, and it always draws exactly the
 * version the share page shows — so it takes no version of its own.
 */
export function sharedDesignPosterUrl(token: string): string {
  return `/share/${encodeURIComponent(token)}/poster`;
}
