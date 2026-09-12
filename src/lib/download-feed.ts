import {
  DOWNLOAD_REPOS,
  PLATFORM_LABELS,
  assetSha256,
  compareReleaseVersions,
  isNotarized,
  isStableRelease,
  manifestAsset,
  parseReleaseManifest,
  pickAsset,
  releaseVersion,
  type AppDownload,
  type DownloadPlatform,
  type ReleaseAsset,
} from "@/lib/app-downloads";

/**
 * What a visitor can download today, assembled from the GitHub releases of both
 * app repositories.
 *
 * Lives here rather than inside the route handler because two surfaces need the
 * same answer: `/api/downloads`, which the sidebar menu and the Mac app's
 * updater both read, and the public `/download` page. Two copies of this would
 * be two chances to disagree about which build is safe to hand someone.
 */

/**
 * Cached for one minute.
 *
 * GitHub rate-limits unauthenticated API calls to 60/hour per IP, and this is the
 * server's IP for every visitor. Without the cache a busy minute would exhaust
 * the budget and the download menu would go dark for everyone — so the menu is
 * allowed to be up to one minute stale, which for a desktop release is nothing.
 */
export const DOWNLOAD_FEED_REVALIDATE = 60;

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
      : ({ next: { revalidate: DOWNLOAD_FEED_REVALIDATE } } as const);

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
 * Whether Apple has accepted this macOS build, read from the release's own
 * provenance manifest rather than inferred from its name or its release notes.
 *
 * The manifest is a small JSON asset `native/Scripts/release-macos.sh` attaches
 * beside the installer, so this costs one extra fetch against the same
 * one-minute cache as the release list. It fails closed: a release with no
 * manifest, an unreachable one, or one written before the script recorded the
 * field all answer false. That is the correct answer for every macOS release
 * published up to v1.5.4, each of which was signed for development and never
 * submitted to Apple — and each of which the download menu was handing out.
 */
async function macosNotarized(
  release: GitHubRelease | null,
  forceRefresh: boolean,
): Promise<boolean> {
  const manifest = release?.assets ? manifestAsset(release.assets) : null;
  if (!manifest) return false;
  try {
    const response = await fetch(manifest.browser_download_url, {
      headers: { accept: "application/json", "user-agent": "juno-downloads" },
      ...(forceRefresh
        ? { cache: "no-store" as const }
        : { next: { revalidate: DOWNLOAD_FEED_REVALIDATE } }),
    });
    if (!response.ok) return false;
    return isNotarized(parseReleaseManifest(await response.text()));
  } catch {
    return false;
  }
}

export interface DownloadFeedOptions {
  /**
   * Native `next` builds ask for prereleases explicitly. The public surfaces
   * never do, which is what keeps a development-signed build out of them.
   */
  includePrerelease?: boolean;
  /** A manual updater check, which must not be answered from the cache. */
  forceRefresh?: boolean;
}

/**
 * The Apple apps and the Windows client publish from different repositories, so
 * both are asked and each platform reports independently — Windows staying
 * available while macOS has nothing published is a real state of the world, and
 * the menu says so rather than hiding the one that works.
 */
export async function buildDownloadFeed({
  includePrerelease = false,
  forceRefresh = false,
}: DownloadFeedOptions = {}): Promise<AppDownload[]> {
  const [apple, windows] = await Promise.all([
    latestRelease(DOWNLOAD_REPOS.apple, "macos", includePrerelease, forceRefresh),
    latestRelease(DOWNLOAD_REPOS.windows, "windows", includePrerelease, forceRefresh),
  ]);

  // Only macOS has a Gatekeeper verdict to report, and only when there is
  // actually an installer to report it about.
  const appleNotarized = apple ? await macosNotarized(apple, forceRefresh) : false;

  const build = (
    platform: DownloadPlatform,
    release: GitHubRelease | null,
    note: string,
    notarized: boolean | null = null,
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
      notarized: asset ? notarized : null,
      ...(asset ? {} : { note }),
    };
  };

  return [
    build("macos", apple, "Not published yet", appleNotarized),
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
      notarized: null,
      note: "On the App Store soon",
    },
  ];
}
