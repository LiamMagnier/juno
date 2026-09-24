import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import { loadOwnedProposal } from "@/lib/artifacts-store";
import { readProposalPayload } from "@/lib/artifact-proposals";
import { designPosterSvg, posterResponse, POSTER_CACHE_REVALIDATE } from "@/lib/design/poster";

// The renderer is plain TypeScript, but the ETag uses Node's crypto.
export const runtime = "nodejs";
// Per-user; nothing here may be cached by the framework.
export const dynamic = "force-dynamic";

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/artifacts/{id}/proposals/{proposalId}/poster — the picture of a
 * suggested design, for Compare beside the artifact's own poster.
 *
 * DESIGN only; 404 for anything else, and for a trashed artifact or someone
 * else's, the same answer `/api/artifacts/{id}/poster` gives, so a caller can
 * fall back without telling "missing" from "not yours".
 *
 * Revalidated rather than immutable: the body never changes, but the answer
 * does (a trashed artifact must stop drawing), and the ETag already makes a
 * repeat look a 304.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; proposalId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isOwnerEmail(user.email)) {
    // The same budget as the artifact poster: a parse and a full render each.
    const limit = await rateLimit({ key: `artifact-poster:${user.id}`, limit: 300, windowSec: 60 });
    if (!limit.success) {
      return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }
  }

  const { id, proposalId } = await params;
  const owned = await loadOwnedProposal(user.id, id, proposalId);
  if (!owned || owned.artifact.type !== "DESIGN") return notFound();
  const payload = readProposalPayload(owned.proposal.payload);
  if (!payload) return notFound();

  const svg = designPosterSvg(payload.content);
  if (!svg) return notFound();
  return posterResponse(svg, req, POSTER_CACHE_REVALIDATE);
}
