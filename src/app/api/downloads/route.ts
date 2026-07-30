import { NextResponse } from "next/server";
import {
  DOWNLOAD_REPOS,
  PLATFORM_LABELS,
  assetSha256,
  pickAsset,
  type AppDownload,
  type DownloadPlatform,
  type ReleaseAsset,
} from "@/lib/app-downloads";

export const runtime = "nodejs";
/**
 * Cached for ten minutes at the edge.
 *
 * GitHub rate-limits unauthenticated API calls to 60/hour per IP, and this is the
 * server's IP for every visitor. Without the cache a busy minute would exhaust
 * the budget and the download menu would go dark for everyone — so the menu is
 * allowed to be up to ten minutes stale, which for a desktop release is nothing.
 */
export const revalidate = 600;

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
}

async function latestRelease(repo: string): Promise<GitHubRelease | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        accept: "application/vnd.github+json",
        // GitHub asks for one, and an unidentified client is the first thing
        // they throttle.
        "user-agent": "juno-downloads",
      },
      next: { revalidate },
    });
    if (!res.ok) return null;
    const release = (await res.json()) as GitHubRelease;
    return release.draft ? null : release;
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
export async function GET() {
  const [apple, windows] = await Promise.all([
    latestRelease(DOWNLOAD_REPOS.apple),
    latestRelease(DOWNLOAD_REPOS.windows),
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

  return NextResponse.json({ downloads });
}
