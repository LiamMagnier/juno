import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import {
  designPosterSvg,
  posterResponse,
  POSTER_CACHE_IMMUTABLE,
  POSTER_CACHE_REVALIDATE,
} from "@/lib/design/poster";

// The renderer is plain TypeScript, but the ETag uses Node's crypto.
export const runtime = "nodejs";
// Per-user and per-version; nothing here may be cached by the framework.
export const dynamic = "force-dynamic";

/** A version number as the query spells it: a positive whole number, nothing
 *  else. `?v=1e3`, `?v=03` and `?v=-1` are not versions and are not guessed at. */
const VERSION = /^[1-9]\d{0,8}$/;

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/artifacts/{id}/poster[?v=n] — the owner's picture of a design.
 *
 * The first page of the given version (the current one when `v` is absent),
 * drawn by the server as SVG, for an `<img>` on a tile, a row, a card or a
 * version list (see `src/lib/design/poster.ts`). 404 for anything that is not
 * a readable DESIGN this user owns, so a caller can fall back to the type glyph
 * without telling "missing" from "not yours" — the same answer the other
 * `/api/artifacts/[id]` routes give.
 *
 * CACHING. A version that a later one has superseded can never change again,
 * so its URL is immutable and a grid pays for each picture once. The CURRENT
 * version is different, whether or not `v` names it: design edits within a
 * checkpoint window are folded into the current row in place
 * (`store.ts`, `rewriteVersion`), so v7's drawing can change while v7 is the
 * newest. Serving that as immutable would pin a tile to the design as it was
 * when first looked at, for a year. It revalidates instead, and the ETag makes
 * an unchanged design a 304. (When sealed versions replace folding, R7, the
 * current version can join the immutable case.)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const raw = new URL(req.url).searchParams.get("v");
  if (raw !== null && !VERSION.test(raw)) return notFound();
  const requested = raw === null ? null : Number(raw);

  if (!isOwnerEmail(user.email)) {
    // A poster is cheap to serve but not free — a parse and a full render of
    // the document — and a grid asks for fifty at once. The budget is sized
    // for someone paging quickly through a large library, not for a script.
    const limit = await rateLimit({ key: `artifact-poster:${user.id}`, limit: 300, windowSec: 60 });
    if (!limit.success) {
      return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }
  }

  // An artifact id alone must never grant access: it must be the reader's own.
  // A trashed design still draws, so its tile in Recently deleted is a picture.
  const artifact = await prisma.artifact.findFirst({
    where: { id, type: "DESIGN", userId: user.id },
    select: { currentVersion: true },
  });
  if (!artifact) return notFound();

  const version = requested ?? artifact.currentVersion;
  const row =
    (await prisma.artifactVersion.findUnique({
      where: { artifactId_version: { artifactId: id, version } },
      select: { content: true },
    })) ??
    // `currentVersion` is meant to name the newest row, and every write path is
    // being made to keep it so (§3.9). Until then, "the current poster" falls
    // back to the newest row, the way `documentFromArtifact` reads it.
    (requested === null
      ? await prisma.artifactVersion.findFirst({
          where: { artifactId: id },
          orderBy: { version: "desc" },
          select: { content: true },
        })
      : null);
  if (!row) return notFound();

  const svg = designPosterSvg(row.content);
  if (!svg) return notFound();

  const sealed = requested !== null && requested < artifact.currentVersion;
  return posterResponse(svg, req, sealed ? POSTER_CACHE_IMMUTABLE : POSTER_CACHE_REVALIDATE);
}
