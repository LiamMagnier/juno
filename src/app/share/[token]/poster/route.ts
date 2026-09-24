import { NextResponse } from "next/server";
import { ipFromHeaders, rateLimit } from "@/lib/rate-limit";
import { getSharedArtifactSnapshot, peekPublicShare, sharedArtifactIsTrashed } from "@/lib/share";
import { designPosterSvg, posterResponse, POSTER_CACHE_PUBLIC } from "@/lib/design/poster";

// The renderer is plain TypeScript, but the ETag uses Node's crypto.
export const runtime = "nodejs";
// Never let the framework keep an answer: a revoked link must stop drawing,
// the same promise the share page makes with the same flag.
export const dynamic = "force-dynamic";

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * The link is real but its design is in Recently deleted. 410 rather than 404
 * because the page beside it says "isn't shared any more", and `no-store` so
 * no cache keeps the answer once the owner restores it.
 */
function gone() {
  return NextResponse.json({ error: "Gone" }, { status: 410, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /share/{token}/poster — the picture a shared design is.
 *
 * It lives here rather than under `/api/` because it answers people who are
 * not signed in — the visitor on the share page — and it belongs to the share,
 * not to the artifact: the token is the whole capability, exactly as it is for
 * the page beside it.
 *
 * It resolves the share the way the page does, through the same two calls in
 * `src/lib/share.ts`, so it can only ever draw the version the page shows: a
 * revoked or unknown token, a chat share, or an artifact that is not a design
 * is a 404, and so is a design this build cannot read. A design in Recently
 * deleted is a 410, the poster's half of the page's "isn't shared any more".
 * It uses the peek rather than the counting lookup, because fetching the
 * picture on the page is not a second view of it.
 *
 * The five-minute public cache is the same horizon as the page's own content:
 * revoking a link stops new fetches at once and cached copies within five
 * minutes. Every asset that is not inline data has already been swapped for a
 * placeholder by the poster itself, so nothing the owner keeps behind their
 * session — a Library image, its storage key — can reach this response.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  // Keyed by address, since there is no account to key by. Generous enough for
  // an office behind one NAT opening the same link; not for walking tokens.
  const limit = await rateLimit({ key: `share-poster:${ipFromHeaders(req.headers)}`, limit: 120, windowSec: 60 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const { token } = await params;
  const share = await peekPublicShare(token);
  if (!share || share.kind !== "ARTIFACT") return notFound();
  if (await sharedArtifactIsTrashed(share)) return gone();

  const snapshot = await getSharedArtifactSnapshot(share);
  if (!snapshot || snapshot.type !== "DESIGN") return notFound();

  const svg = designPosterSvg(snapshot.content);
  if (!svg) return notFound();

  return posterResponse(svg, req, POSTER_CACHE_PUBLIC);
}
