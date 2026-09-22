import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { buildDownloadFeed } from "@/lib/download-feed";

export const runtime = "nodejs";
// Every click is answered afresh. The point of this route is a signed URL made
// at the moment someone asks for it, so a cached redirect would defeat it.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * The newest stable build for one platform, as a redirect to the file.
 *
 * It exists because a private repository's assets have no permanent URL. The
 * feed hands out GitHub's signed one, which dies within minutes, and a page
 * that rendered it — `/download`, or the download menu after sitting open —
 * would give a late reader a dead link. So the pages link here, and the URL is
 * signed when the click arrives.
 *
 * It answers from the same feed as the pages and the Mac updater, stable
 * releases only, so it cannot reach a build they would not offer. `?version=`
 * is the version the page showed beside its checksum: if a newer release has
 * replaced it since, the reader is sent back to `/download` to see the new one
 * rather than handed a file other than the one described. So is anyone asking
 * for a platform with nothing to download. Redirects use the configured public
 * URL, not req.url, which behind nginx is the internal address.
 *
 * A page reaches this by plain navigation, never through an `<a download>`: on
 * a same-origin link that attribute would save the `/download` page as a file
 * instead of opening it (`downloadLink`).
 */
export async function GET(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const wanted = new URL(req.url).searchParams.get("version");

  const downloads = await buildDownloadFeed();
  const download = downloads.find((candidate) => candidate.platform === platform);
  if (!download) return new NextResponse(null, { status: 404, headers: NO_STORE });

  if (!download.available || !download.url || (wanted !== null && wanted !== download.version)) {
    const back = NextResponse.redirect(new URL("/download", env.appUrl), 303);
    back.headers.set("Cache-Control", "no-store");
    return back;
  }

  const file = NextResponse.redirect(download.url, 302);
  file.headers.set("Cache-Control", "no-store");
  return file;
}
