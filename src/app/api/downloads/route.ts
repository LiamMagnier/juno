import { NextResponse } from "next/server";
import {
  DOWNLOAD_REPOS,
  PLATFORM_LABELS,
  assetSha256,
  isStableRelease,
  pickAsset,
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

function versionParts(release: GitHubRelease): number[] {
  const raw = release.tag_name?.trim().replace(/^v/i, "") ?? "";
  const core = raw.split(/[+-]/, 1)[0] ?? "";
  return core.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function compareReleaseVersions(a: GitHubRelease, b: GitHubRelease): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return r - l;
  }
  const leftDate = Date.parse(a.published_at ?? "") || 0;
  const rightDate = Date.parse(b.published_at ?? "") || 0;
  return rightDate - leftDate;
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

    // Stable clients need the release GitHub itself considers current. The
    // old implementation always cached `/releases?per_page=100`; when a
    // release was changed from prerelease to stable, that cache continued to
    // serve the previous stable version until its full TTL elapsed. Using the
    // `/latest` endpoint also makes the cache key change with this fix, so the
    // already-published 0.11.0 becomes visible immediately after deployment.
    const latestResponse = await fetch(
      `https://api.github.com/repos/${repo}/releases/${includePrerelease ? "?per_page=100" : "latest"}`,
      { headers, ...cache },
    );
    if (!latestResponse.ok) return null;
    const payload = (await latestResponse.json()) as GitHubRelease | GitHubRelease[];
    const releases = Array.isArray(payload) ? payload : [payload];
    const candidate = releases
      .filter((release) => (includePrerelease ? !release?.draft : isStableRelease(release)))
      .filter((release) => Boolean(release.assets && pickAsset(release.assets, platform)))
      .sort(compareReleaseVersions)[0];

    if (candidate || includePrerelease) return candidate ?? null;

    // A repository can publish a release without an installer for this
    // platform. Keep the download row honest by falling back to the full list
    // and finding the newest stable release that does have one.
    const listResponse = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=100`,
      { headers, ...cache },
    );
    if (!listResponse.ok) return null;
    const list = (await listResponse.json()) as GitHubRelease[];
    return list
      .filter(isStableRelease)
      .filter((release) => Boolean(release.assets && pickAsset(release.assets, platform)))
      .sort(compareReleaseVersions)[0] ?? null;
  } catch {
    return null;
  }
}

function version(release: GitHubRelease | null): string | null {
  const tag = release?.tag_name?.trim();
  if (!tag) return null;
  return tag.startsWith("v") ? tag.slice(1) : tag;
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
  // refresh value to avoid serving an edge-cached answer from ten minutes ago.
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
  // Keep already-installed clients from waiting through a long CDN window
  // when a GitHub release changes from prerelease to stable. The upstream
  // request remains server-cached, so this does not turn every visitor into a
  // GitHub API call.
  response.headers.set(
    "Cache-Control",
    "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
  );
  return response;
}
