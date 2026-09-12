import { NextResponse } from "next/server";
import { buildDownloadFeed } from "@/lib/download-feed";

export const runtime = "nodejs";
// A literal, not the shared constant: Next reads route segment config by static
// analysis, and an imported value is not always resolvable. Kept in step with
// DOWNLOAD_FEED_REVALIDATE in @/lib/download-feed, which is asserted by a test.
export const revalidate = 60;

/**
 * What a visitor — or an installed Mac app — can download today.
 *
 * The assembly lives in `@/lib/download-feed` because the public `/download`
 * page renders the same answer server-side, and two implementations of "which
 * build is safe to hand someone" would eventually disagree.
 */
export async function GET(req: Request) {
  const search = new URL(req.url).searchParams;
  // The public download surfaces remain stable-only. Native `next` builds may
  // ask for prereleases explicitly, while a manual updater check adds a unique
  // refresh value to avoid serving an edge-cached answer from the previous
  // release window.
  const downloads = await buildDownloadFeed({
    includePrerelease: search.get("channel") === "next",
    forceRefresh: search.has("refresh"),
  });

  const response = NextResponse.json({ downloads });
  // Keep the small feed out of intermediary caches. The upstream GitHub
  // request remains server-cached for one minute, so this does not turn every
  // visitor into a GitHub API call, while an already-installed app never gets
  // a stale JSON response after a release is promoted from prerelease.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
