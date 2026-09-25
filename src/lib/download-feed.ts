import { env } from "@/lib/env";
import {
  DOWNLOAD_REPOS,
  PLATFORM_LABELS,
  assetSha256,
  compareReleaseVersions,
  isNotarized,
  isStableRelease,
  isUpdaterDownloadUrl,
  manifestAsset,
  parseReleaseManifest,
  pickAsset,
  releaseVersion,
  signedUrlExpiry,
  type AppDownload,
  type DownloadPlatform,
  type ReleaseAsset,
} from "@/lib/app-downloads";

/**
 * What a visitor can download today, assembled from the GitHub releases of both
 * app repositories.
 *
 * Lives here rather than inside the route handler because three surfaces need
 * the same answer: `/api/downloads`, which the sidebar menu and the Mac app's
 * updater both read, the public `/download` page, and the `/download/<platform>`
 * route those pages link through. Separate copies would be separate chances to
 * disagree about which build is safe to hand someone.
 *
 * **A private repository.** LiamMagnier/juno is private, and GitHub answers an
 * anonymous request for its releases with 404 — so with no credential the feed
 * sees nothing, reports "Not published yet", and every installed Mac is told it
 * is current. With `JUNO_RELEASES_GITHUB_TOKEN` set the releases are listed with
 * that token, and each private asset is handed out as the signed URL GitHub
 * redirects its API download to: HTTPS on release-assets.githubusercontent.com,
 * which the updater already built into every installed copy accepts, serving
 * the same bytes the listing's size and digest describe. Without the token
 * nothing here changes.
 */

/**
 * Cached for one minute.
 *
 * GitHub rate-limits unauthenticated API calls to 60/hour per IP, and this is the
 * server's IP for every visitor. Without the cache a busy minute would exhaust
 * the budget and the download menu would go dark for everyone — so the menu is
 * allowed to be up to one minute stale, which for a desktop release is nothing.
 * With a token the budget is that token's 5,000/hour instead, and the cache
 * stays, so ordinary traffic costs the token a handful of requests a minute.
 */
export const DOWNLOAD_FEED_REVALIDATE = 60;

/**
 * How long one signed asset URL may be handed out again after GitHub issued it.
 *
 * A signed URL is not cached the way the release list is. Next's data cache
 * serves an entry once more after its revalidate window has passed — harmless
 * for a list of releases, a dead link for a URL that expired while nobody was
 * asking. So signed URLs live in memory here, under two rules that both have to
 * hold: issued less than a minute ago, and still at least four minutes from
 * expiry. The shortest lifetime GitHub was seen to issue is five minutes (see
 * `signedUrlExpiry`), so a link handed out always has minutes to run — the
 * updater starts its download within seconds of reading the feed — and the API
 * sees at most one signing per asset per minute however busy the feed is.
 */
export const SIGNED_URL_REUSE_MS = 60_000;
export const SIGNED_URL_MIN_REMAINING_MS = 4 * 60_000;
/** The lifetime assumed for a signed URL whose own expiry cannot be read. */
export const SIGNED_URL_ASSUMED_LIFETIME_MS = 5 * 60_000;

const GITHUB_API = "https://api.github.com";

/**
 * The longest any one GitHub request behind the feed may take.
 *
 * Without a bound, one request that never answers holds the whole feed, and an
 * installed app asking "is there an update?" waits with it. Ten seconds is far
 * beyond a healthy answer (well under a second from the VM) and short enough
 * that a stalled one fails closed as "not published" instead of hanging.
 */
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

function timeout(): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS) };
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  assets?: ReleaseAsset[];
}

function fetchCache(forceRefresh: boolean) {
  return forceRefresh
    ? ({ cache: "no-store" as const })
    : ({ next: { revalidate: DOWNLOAD_FEED_REVALIDATE } } as const);
}

function githubHeaders(token: string | null, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    accept,
    // GitHub asks for one, and an unidentified client is the first thing
    // they throttle.
    "user-agent": "juno-downloads",
    ...(token ? { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } : {}),
  };
}

/** The newest release a repository offers for one platform, and how to hand out its assets. */
interface RepositoryRelease {
  repo: string;
  release: GitHubRelease;
  /** The token the release list was read with, or null when GitHub answered anonymously. */
  token: string | null;
  /** Whether the assets' github.com URLs work for anyone, which only a public repository's do. */
  publicAssets: boolean;
}

async function latestRelease(
  repo: string,
  platform: DownloadPlatform,
  includePrerelease: boolean,
  forceRefresh: boolean,
  token: string | null,
): Promise<RepositoryRelease | null> {
  try {
    // Never trust GitHub's single `/releases/latest` pointer. It is based on
    // publication order rather than the highest SemVer and can temporarily
    // point at an older backport or a release without a Mac installer. A full
    // page costs one cached API request and lets us choose the highest valid
    // version that actually has this platform's asset.
    const endpoint = `${GITHUB_API}/repos/${repo}/releases?per_page=100&juno_feed=semver-v2`;
    const read = (credential: string | null) =>
      fetch(endpoint, { headers: githubHeaders(credential), ...fetchCache(forceRefresh), ...timeout() });
    let credential = token;
    let response = await read(credential);
    // A revoked or expired token is refused with 401 even by a public
    // repository, which never needed one. Asking again without it keeps a
    // broken credential from ever being worse than no credential.
    if (response.status === 401 && credential) {
      credential = null;
      response = await read(null);
    }
    if (!response.ok) return null;
    const payload = (await response.json()) as GitHubRelease[];
    const release = payload
      .filter((release) => (includePrerelease ? !release?.draft : isStableRelease(release)))
      .filter((release) => releaseVersion(release.tag_name) !== null)
      .filter((release) => Boolean(release.assets && pickAsset(release.assets, platform)))
      .sort(compareReleaseVersions)[0];
    if (!release) return null;
    return {
      repo,
      release,
      token: credential,
      publicAssets: await assetsArePublic(repo, credential, forceRefresh),
    };
  } catch {
    return null;
  }
}

/**
 * Whether a repository's assets can go out as their permanent github.com URLs.
 *
 * Asked only when the releases were read with a token: a release list GitHub
 * showed anonymously belongs to a public repository by definition, so without a
 * token this costs nothing and changes nothing. With one, anything short of
 * GitHub saying `private: false` answers no, because the two mistakes are not
 * alike — a signed URL works for a public asset too, while a github.com link to
 * a private one is a 404 for everyone who follows it.
 */
async function assetsArePublic(repo: string, token: string | null, forceRefresh: boolean): Promise<boolean> {
  if (!token) return true;
  try {
    const response = await fetch(`${GITHUB_API}/repos/${repo}`, {
      headers: githubHeaders(token),
      ...fetchCache(forceRefresh),
      ...timeout(),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { private?: unknown } | null;
    return body?.private === false;
  } catch {
    return false;
  }
}

/** The API address of one release asset, or null for an asset without a usable id. */
function assetEndpoint(repo: string, asset: ReleaseAsset): string | null {
  const id = asset.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  return `${GITHUB_API}/repos/${repo}/releases/assets/${id}`;
}

interface SignedLink {
  url: string;
  /** Milliseconds since the epoch. */
  resolvedAt: number;
  /** Milliseconds since the epoch; the earliest expiry the URL carries. */
  expiresAt: number;
}

const signedLinks = new Map<string, SignedLink>();
const pendingLinks = new Map<string, Promise<SignedLink | null>>();

/** Test seam. */
export function resetDownloadFeedCache(): void {
  signedLinks.clear();
  pendingLinks.clear();
}

function reusable(link: SignedLink, now: number): boolean {
  return now - link.resolvedAt < SIGNED_URL_REUSE_MS && link.expiresAt - now >= SIGNED_URL_MIN_REMAINING_MS;
}

/**
 * A signed URL for a private asset: the Location GitHub answers an API download
 * with, which anyone can fetch until it expires.
 *
 * Only a URL the installed updater would fetch is accepted — HTTPS on one of its
 * GitHub hosts — so a change on GitHub's side shows up here as "temporarily
 * unavailable" rather than as an update every installed copy refuses. Concurrent
 * asks for the same asset share one request.
 */
async function signedAssetLink(
  repo: string,
  asset: ReleaseAsset,
  token: string | null,
  forceRefresh: boolean,
  now: () => number,
): Promise<SignedLink | null> {
  const endpoint = assetEndpoint(repo, asset);
  if (!endpoint) return null;
  const cached = signedLinks.get(endpoint);
  if (cached && !forceRefresh && reusable(cached, now())) return cached;
  const pending = pendingLinks.get(endpoint);
  if (pending) return pending;

  const resolving = (async (): Promise<SignedLink | null> => {
    try {
      const response = await fetch(endpoint, {
        headers: githubHeaders(token, "application/octet-stream"),
        // The Location is the answer; following it would download the DMG
        // into a server that only wanted its address.
        redirect: "manual",
        // And never through Next's data cache, for the reason on
        // SIGNED_URL_REUSE_MS.
        cache: "no-store",
        ...timeout(),
      });
      // Read the redirect's few bytes rather than cancelling the body. Next's
      // server fetch keeps a clone of every response, and a body that has been
      // cloned only finishes cancelling once the clone is cancelled too — which
      // Next never does — so `await response.body.cancel()` here never resolved,
      // and every request for the feed waited on it forever once the token made
      // this branch reachable. Reading to the end completes on both branches.
      await response.arrayBuffer().catch(() => undefined);
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location || !isUpdaterDownloadUrl(location)) return null;
      const resolvedAt = now();
      const link: SignedLink = {
        url: location,
        resolvedAt,
        expiresAt: signedUrlExpiry(location) ?? resolvedAt + SIGNED_URL_ASSUMED_LIFETIME_MS,
      };
      for (const [key, held] of signedLinks) if (!reusable(held, resolvedAt)) signedLinks.delete(key);
      signedLinks.set(endpoint, link);
      return link;
    } catch {
      return null;
    }
  })().finally(() => pendingLinks.delete(endpoint));
  pendingLinks.set(endpoint, resolving);
  return resolving;
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
async function macosNotarized(source: RepositoryRelease, forceRefresh: boolean): Promise<boolean> {
  const manifest = source.release.assets ? manifestAsset(source.release.assets) : null;
  if (!manifest) return false;
  try {
    let response: Response;
    if (source.publicAssets) {
      response = await fetch(manifest.browser_download_url, {
        headers: { accept: "application/json", "user-agent": "juno-downloads" },
        ...fetchCache(forceRefresh),
        ...timeout(),
      });
    } else {
      // A private manifest is read through the API, which redirects to a
      // signed URL. The fetch standard drops `Authorization` on a cross-origin
      // redirect, so the token stays with api.github.com. The cache is keyed by
      // this stable API address and holds the manifest's bytes, which never
      // expire, so the one-minute cache works as it does for a public manifest.
      const endpoint = assetEndpoint(source.repo, manifest);
      if (!endpoint) return false;
      response = await fetch(endpoint, {
        headers: githubHeaders(source.token, "application/octet-stream"),
        ...fetchCache(forceRefresh),
        ...timeout(),
      });
    }
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
  /**
   * The GitHub token to read releases with. Defaults to
   * `JUNO_RELEASES_GITHUB_TOKEN`; null reads anonymously.
   */
  token?: string | null;
  /** Milliseconds since the epoch. Injectable for tests. */
  now?: () => number;
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
  token = env.releasesGithubToken ?? null,
  now = Date.now,
}: DownloadFeedOptions = {}): Promise<AppDownload[]> {
  const [apple, windows] = await Promise.all([
    latestRelease(DOWNLOAD_REPOS.apple, "macos", includePrerelease, forceRefresh, token),
    latestRelease(DOWNLOAD_REPOS.windows, "windows", includePrerelease, forceRefresh, token),
  ]);

  const unavailable = (platform: DownloadPlatform, note: string): AppDownload => ({
    platform,
    label: PLATFORM_LABELS[platform],
    url: null,
    urlExpiresAt: null,
    version: null,
    size: null,
    sha256: null,
    available: false,
    notarized: null,
    note,
  });

  const build = async (
    platform: DownloadPlatform,
    source: RepositoryRelease | null,
    note: string,
    notarized: () => Promise<boolean | null>,
  ): Promise<AppDownload> => {
    const asset = source?.release.assets ? pickAsset(source.release.assets, platform) : null;
    if (!source || !asset) return unavailable(platform, note);
    // Started before the link is signed, so the two requests overlap.
    const verdict = notarized();

    let url = asset.browser_download_url;
    let urlExpiresAt: string | null = null;
    if (!source.publicAssets) {
      const link = await signedAssetLink(source.repo, asset, source.token, forceRefresh, now);
      // A release exists but no working link to it could be made. Saying
      // "not published" would be false, and a github.com link would 404.
      if (!link) return unavailable(platform, "Temporarily unavailable");
      url = link.url;
      urlExpiresAt = new Date(link.expiresAt).toISOString();
    }

    return {
      platform,
      label: PLATFORM_LABELS[platform],
      url,
      urlExpiresAt,
      version: version(source.release),
      size: asset.size ?? null,
      sha256: assetSha256(asset),
      available: true,
      notarized: await verdict,
    };
  };

  return Promise.all([
    // Only macOS has a Gatekeeper verdict to report, and it is only asked for
    // when there is actually an installer to report it about.
    build("macos", apple, "Not published yet", () =>
      apple ? macosNotarized(apple, forceRefresh) : Promise.resolve(false),
    ),
    build("windows", windows, "Not published yet", () => Promise.resolve(null)),
    // The iPhone app is not a file. It installs from the App Store, and there is
    // no listing yet — so it reports unavailable with a reason rather than
    // linking at a store page that does not exist.
    Promise.resolve(unavailable("ios", "On the App Store soon")),
  ]);
}
