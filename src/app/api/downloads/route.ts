import { NextResponse } from "next/server";
import {
  DOWNLOAD_REPOS,
  PLATFORM_LABELS,
  assetSha256,
  compareReleaseVersions,
  isStableRelease,
  pickAsset,
  releaseVersion,
  type AppDownload,
  type DownloadPlatform,
  type ReleaseAsset,
} from "@/lib/app-downloads";

export const runtime = "nodejs";
/**
 * Cached for one minute at the edge.
 *
 * GitHub rate-limits unauthenticated API calls to 60/hour per IP, and this is the
 * server's IP for every visitor. Without the cache a busy minute would exhaust
 * the budget and the download menu would go dark for everyone — so the menu is
 * allowed to be up to one minute stale, which for a desktop release is nothing.
 */
export const revalidate = 60;

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  assets?: ReleaseAsset[];
}

async function latestRelease(
  repo: string,
  platform: DownloadPlatform,
  includePrerelease: boolean,
  forceRefresh: boolean,
): Promise<GitHubRelease | null> {
  try {
    const headers = {
      accept: "application/vnd.github+json",
      // GitHub asks for one, and an unidentified client is the first thing
      // they throttle.
      "user-agent": "juno-downloads",
    };
    const cache = forceRefresh
      ? ({ cache: "no-store" as const })
      : ({ next: { revalidate } } as const);

    // Never trust GitHub's single `/releases/latest` pointer. It is based on
    // publication order rather than the highest SemVer and can temporarily
    // point at an older backport or a release without a Mac installer. A full
    // page costs one cached API request and lets us choose the highest valid
    // version that actually has this platform's asset.
    const endpoint = `https://api.github.com/repos/${repo}/releases?per_page=100&juno_feed=semver-v2`;
    const response = await fetch(endpoint, { headers, ...cache });
    if (!response.ok) return null;
    const payload = (await response.json()) as GitHubRelease[];
    return payload
      .filter((release) => (includePrerelease ? !release?.draft : isStableRelease(release)))
      .filter((release) => releaseVersion(release.tag_name) !== null)
      .filter((release) => Boolean(release.assets && pickAsset(release.assets, platform)))
      .sort(compareReleaseVersions)[0] ?? null;
  } catch {
    return null;
  }
}

function version(release: GitHubRelease | null): string | null {
  return releaseVersion(release?.tag_name);
}

/**
 * What a visitor can download today.
 *
 * The Apple apps and the Windows client publish from different repositories, so
 * both are asked and each platform reports independently — Windows staying
 * available while macOS has nothing published is the CURRENT state of the world,
 * and the menu says so rather than hiding the one that works.
 */
export async function GET(req: Request) {
  const search = new URL(req.url).searchParams;
  // The public download page remains stable-only. Native `next` builds may ask
  // for prereleases explicitly, while a manual updater check adds a unique
  // refresh value to avoid serving an edge-cached answer from the previous
  // release window.
  const includePrerelease = search.get("channel") === "next";
  const forceRefresh = search.has("refresh");
  const [apple, windows] = await Promise.all([
    latestRelease(DOWNLOAD_REPOS.apple, "macos", includePrerelease, forceRefresh),
    latestRelease(DOWNLOAD_REPOS.windows, "windows", includePrerelease, forceRefresh),
  ]);

  const build = (
    platform: DownloadPlatform,
    release: GitHubRelease | null,
    note: string,
  ): AppDownload => {
    const asset = release?.assets ? pickAsset(release.assets, platform) : null;
    return {
      platform,
      label: PLATFORM_LABELS[platform],
      url: asset?.browser_download_url ?? null,
      version: asset ? version(release) : null,
      size: asset?.size ?? null,
      sha256: assetSha256(asset),
      available: Boolean(asset),
      ...(asset ? {} : { note }),
    };
  };

  const downloads: AppDownload[] = [
    build("macos", apple, "Not published yet"),
    build("windows", windows, "Not published yet"),
    // The iPhone app is not a file. It installs from the App Store, and there is
    // no listing yet — so it reports unavailable with a reason rather than
    // linking at a store page that does not exist.
    {
      platform: "ios",
      label: PLATFORM_LABELS.ios,
      url: null,
      version: null,
      size: null,
      sha256: null,
      available: false,
      note: "On the App Store soon",
    },
  ];

  const response = NextResponse.json({ downloads });
  // Keep the small feed out of intermediary caches. The upstream GitHub
  // request remains server-cached for one minute, so this does not turn every
  // visitor into a GitHub API call, while an already-installed app never gets
  // a stale JSON response after a release is promoted from prerelease.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
