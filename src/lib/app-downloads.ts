/**
 * Where the desktop and mobile apps come from, and which one a visitor wants.
 *
 * Juno ships from two repositories: the Windows client is its own Tauri app in
 * `juno-windows`, and the Apple apps build out of this one. A public
 * repository's release asset is a plain, permanent URL. A private one's is not:
 * `github.com/…/releases/download/…` answers 404 to anyone without access, so
 * the feed hands out GitHub's short-lived signed URL for the asset instead
 * (`@/lib/download-feed`), and a page links to `/download/<platform>`, which
 * signs a fresh one at the moment of the click.
 *
 * NOTHING IS INVENTED. A platform with no published release reports
 * `available: false` rather than linking at a guessed asset name — a download
 * button that 404s is worse than one that says "not yet", because the reader
 * blames their machine.
 */

export type DownloadPlatform = "macos" | "windows" | "ios";

export interface AppDownload {
  platform: DownloadPlatform;
  label: string;
  /**
   * The asset itself. Absent until a release publishes one for this platform.
   *
   * This is what the Mac updater downloads, and the only URL an installed copy
   * will fetch: HTTPS on a GitHub release host (`UPDATER_DOWNLOAD_HOSTS`). For a
   * private repository it is a signed URL that stops working at `urlExpiresAt`,
   * so a page must not render it — see `downloadHref`.
   */
  url: string | null;
  /**
   * When `url` stops working, as an ISO 8601 instant, or null when it is a
   * permanent link. Only a signed URL has one.
   */
  urlExpiresAt: string | null;
  version: string | null;
  /** Bytes, when the asset reports a size. */
  size: number | null;
  /**
   * Lowercase hex SHA-256 of the asset, when GitHub publishes one.
   *
   * Read by the Mac app's updater, not by the download menu. Absent for older
   * releases — GitHub only started returning `digest` on assets recently — and
   * absent is honest: the updater skips the checksum comparison rather than
   * pretending it passed one.
   */
  sha256: string | null;
  available: boolean;
  /**
   * Whether Apple has notarized this build, for platforms where that decides
   * whether it opens at all. `null` on Windows and iOS, which have no such gate.
   *
   * This exists because the answer used to be unknowable. Every macOS release
   * from v0.15.15 to v1.5.4 was signed for development and never notarized, and
   * nothing in the feed could tell one of those from a production build — so the
   * download menu offered them, and macOS refused every one with "Apple could
   * not verify … is free of malware". Installed copies never saw it: the
   * updater strips `com.apple.quarantine` after a verified swap, so only a
   * fresh download hit the wall.
   */
  notarized: boolean | null;
  /** Shown in place of a version when there is nothing to download yet. */
  note?: string;
}

/**
 * The provenance manifest published beside a macOS installer.
 *
 * `native/Scripts/release-macos.sh` writes one per release and attaches it as
 * `Juno-<version>.release.json`. Only the fields read here are declared; the
 * manifest carries more.
 */
export interface ReleaseManifest {
  version?: string;
  /** Written by the release script. Absent on every release published before it was. */
  notarized?: boolean;
}

/** The `*.release.json` provenance manifest for a release, if it published one. */
export function manifestAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  return assets.find((asset) => asset.name.toLowerCase().endsWith(".release.json")) ?? null;
}

/**
 * Whether a build is *proven* notarized.
 *
 * Fails closed on purpose. A missing manifest, an unparseable one, or a manifest
 * with no `notarized` field all answer false, because every one of those is a
 * build nobody proved Apple had accepted — and that is exactly the set of
 * releases that were being handed to visitors before this existed. Only the
 * literal `true` counts.
 */
export function isNotarized(manifest: ReleaseManifest | null | undefined): boolean {
  return manifest?.notarized === true;
}

/** Parse a manifest body, tolerating anything that is not the JSON we expect. */
export function parseReleaseManifest(body: string): ReleaseManifest | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      version: typeof record.version === "string" ? record.version : undefined,
      notarized: typeof record.notarized === "boolean" ? record.notarized : undefined,
    };
  } catch {
    return null;
  }
}

export const DOWNLOAD_REPOS = {
  apple: "LiamMagnier/juno",
  windows: "LiamMagnier/juno-windows",
} as const;

export interface ReleaseVisibility {
  draft?: boolean;
  prerelease?: boolean;
}

/** Only a public, stable release is safe to put in the production download menu. */
export function isStableRelease(
  release: ReleaseVisibility | null | undefined,
): boolean {
  return Boolean(release && !release.draft && !release.prerelease);
}

export const PLATFORM_LABELS: Record<DownloadPlatform, string> = {
  macos: "macOS",
  windows: "Windows",
  ios: "iPhone & iPad",
};

/**
 * Which asset belongs to which platform.
 *
 * Matched on the extension rather than on a name pattern, because release asset
 * names carry the version and would need this list edited on every bump.
 * `.dmg` and `.zip` both appear for macOS — a zip is what Sparkle-style updaters
 * publish alongside the disk image — and the `.dmg` wins because it is the one a
 * person should double-click.
 */
export function assetPlatform(name: string): DownloadPlatform | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sig") || lower.endsWith(".json") || lower.endsWith(".txt")) return null;
  if (lower.endsWith(".dmg") || lower.endsWith(".pkg")) return "macos";
  if (lower.endsWith(".exe") || lower.endsWith(".msi")) return "windows";
  // A macOS zip only counts when nothing better is present; see `pickAsset`.
  if (lower.endsWith(".zip") && lower.includes("mac")) return "macos";
  return null;
}

/** `.dmg`/`.pkg` beat a `.zip` for the same platform. */
function rank(name: string): number {
  const lower = name.toLowerCase();
  if (lower.endsWith(".dmg") || lower.endsWith(".pkg") || lower.endsWith(".exe") || lower.endsWith(".msi")) return 2;
  return 1;
}

export interface ReleaseAsset {
  /** GitHub's id for the asset, which is how a private one is fetched through the API. */
  id?: number;
  name: string;
  browser_download_url: string;
  size?: number;
  /** `sha256:<hex>` on releases published since GitHub added the field. */
  digest?: string | null;
}

/** The release fields used when choosing the newest downloadable build. */
export interface ReleaseMetadata {
  tag_name?: string;
  published_at?: string;
}

interface ParsedReleaseVersion {
  normalized: string;
  core: [string, string, string];
  prerelease: string[] | null;
}

const RELEASE_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseReleaseVersion(tag: string | null | undefined): ParsedReleaseVersion | null {
  const raw = tag?.trim().replace(/^v/i, "");
  if (!raw) return null;
  const match = RELEASE_VERSION_PATTERN.exec(raw);
  if (!match) return null;

  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    return null;
  }

  return {
    normalized: raw,
    core: [match[1], match[2], match[3]],
    prerelease,
  };
}

function compareDecimalStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareDecimalStrings(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Returns the normalized version for a release tag, or null for a tag the app
 * cannot compare safely. Keeping malformed tags out of the feed matters: a
 * newer-looking `latest` release with an invalid tag would otherwise hide a
 * valid older release from the updater.
 */
export function releaseVersion(tag: string | null | undefined): string | null {
  return parseReleaseVersion(tag)?.normalized ?? null;
}

/**
 * Sorts releases newest first by SemVer, then by publication date.
 *
 * Stable and prerelease channels use the same ordering, so a `next` build sees
 * `0.12.0-beta.2` after `0.12.0-beta.1`, while a published `0.12.0` always
 * outranks its prereleases. Build metadata is deliberately ignored by SemVer.
 */
export function compareReleaseVersions(
  leftRelease: ReleaseMetadata,
  rightRelease: ReleaseMetadata,
): number {
  const left = parseReleaseVersion(leftRelease.tag_name);
  const right = parseReleaseVersion(rightRelease.tag_name);

  // Callers filter invalid tags before sorting. Keep this defensive ordering so
  // the helper remains safe if a future caller forgets that precondition.
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;

  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareDecimalStrings(left.core[index], right.core[index]);
    if (comparison !== 0) return -comparison;
  }

  if (left.prerelease === null && right.prerelease !== null) return -1;
  if (left.prerelease !== null && right.prerelease === null) return 1;
  if (left.prerelease && right.prerelease) {
    for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
      if (index >= left.prerelease.length) return 1;
      if (index >= right.prerelease.length) return -1;
      const comparison = comparePrereleaseIdentifiers(left.prerelease[index], right.prerelease[index]);
      if (comparison !== 0) return -comparison;
    }
  }

  const leftDate = Date.parse(leftRelease.published_at ?? "") || 0;
  const rightDate = Date.parse(rightRelease.published_at ?? "") || 0;
  return rightDate - leftDate;
}

/** The asset's digest as lowercase hex, or null when it has none we can use. */
export function assetSha256(asset: ReleaseAsset | null | undefined): string | null {
  const raw = asset?.digest?.toLowerCase();
  if (!raw) return null;
  const hex = raw.startsWith("sha256:") ? raw.slice("sha256:".length) : raw;
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function pickAsset(
  assets: ReleaseAsset[],
  platform: DownloadPlatform,
): ReleaseAsset | null {
  const candidates = assets.filter((a) => assetPlatform(a.name) === platform);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => rank(b.name) - rank(a.name))[0];
}

/**
 * The hosts an installed Mac app will download an update from.
 *
 * A copy of the list in `JunoUpdateFeed.validateOrigin`
 * (native/Packages/JunoNativeKit/Sources/JunoCore/JunoUpdateFeed.swift), held
 * to it by a test. The copy exists because that list cannot move: every Mac
 * already running v1.5.4 has it compiled in, so the server has to hand out a
 * URL the list accepts rather than the other way round.
 */
export const UPDATER_DOWNLOAD_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;

/** HTTPS on a release host or a subdomain of one: the updater's own rule, applied before it fetches a byte. */
export function isUpdaterDownloadUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return UPDATER_DOWNLOAD_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function decodeBase64Url(segment: string): string {
  // `atob` rather than Buffer so this module stays importable from the client,
  // where the download menu reads it.
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
}

/**
 * When a signed asset URL stops working, in milliseconds since the epoch, or
 * null when it carries no expiry this can read.
 *
 * GitHub's signed release-asset URLs carry more than one clock, and the earliest
 * is the one to believe. Observed for this repository's assets on 2026-09-22,
 * at release-assets.githubusercontent.com: a `jwt` whose `exp` is 30 minutes out
 * for the DMG and 5 for the small JSON and text assets, beside an Azure SAS `se`
 * 43 to 59 minutes out. Only the SAS was enforced that day, since a URL first
 * fetched after its JWT `exp` was still served, but nothing promises that stays
 * true, so the earlier clock wins. The older objects.githubusercontent.com form
 * was an S3 presign, `X-Amz-Date` plus `X-Amz-Expires` seconds. All three are
 * read, and a value that does not parse is dropped rather than trusted; the
 * caller treats "no expiry found" as the shortest lifetime GitHub was seen to
 * issue.
 */
export function signedUrlExpiry(raw: string): number | null {
  let params: URLSearchParams;
  try {
    params = new URL(raw).searchParams;
  } catch {
    return null;
  }
  const expiries: number[] = [];

  const sasExpiry = params.get("se");
  if (sasExpiry) expiries.push(Date.parse(sasExpiry));

  const jwt = params.get("jwt");
  const claims = jwt?.split(".")[1];
  if (claims) {
    try {
      const exp = (JSON.parse(decodeBase64Url(claims)) as { exp?: unknown } | null)?.exp;
      if (typeof exp === "number") expiries.push(exp * 1000);
    } catch {
      // Not a JWT this can read. The other clocks still count.
    }
  }

  const amzDate = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(params.get("X-Amz-Date") ?? "");
  const amzSeconds = params.get("X-Amz-Expires");
  if (amzDate && amzSeconds && /^\d+$/.test(amzSeconds)) {
    const [, year, month, day, hour, minute, second] = amzDate.map(Number);
    expiries.push(Date.UTC(year, month - 1, day, hour, minute, second) + Number(amzSeconds) * 1000);
  }

  const readable = expiries.filter(Number.isFinite);
  return readable.length > 0 ? Math.min(...readable) : null;
}

/**
 * What a page should link a person to for this download.
 *
 * The asset's own URL when that is permanent. When it is signed, Juno's
 * `/download/<platform>` route instead: a person can read a page for an hour
 * before clicking, and a signed URL rendered into it stops working in minutes.
 * The route signs a fresh one at the moment of the click, and carries the
 * version so the file that arrives is the one whose checksum the page showed.
 */
export function downloadHref(download: AppDownload): string | null {
  if (!download.available || !download.url) return null;
  if (!download.urlExpiresAt) return download.url;
  const version = download.version ? `?version=${encodeURIComponent(download.version)}` : "";
  return `/download/${download.platform}${version}`;
}

/**
 * The visitor's platform, from the User-Agent.
 *
 * Deliberately coarse. This picks which button is offered FIRST — every platform
 * stays reachable underneath it — so a wrong guess costs one extra click, and
 * that is the right trade against sniffing hard enough to be wrong in new ways.
 * `null` means "show them all", which is also what a bot or a Linux visitor gets.
 */
export function detectPlatform(userAgent: string | null | undefined): DownloadPlatform | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  // iPadOS reports itself as a Mac, and the giveaway is touch. On the server
  // there is no touch API, so an iPad lands on macOS — which is a download page
  // it can at least read, and the iOS row is one line below.
  if (/iphone|ipod/.test(ua)) return "ios";
  if (/ipad/.test(ua)) return "ios";
  if (/android/.test(ua)) return null;
  if (/mac os x|macintosh/.test(ua)) return "macos";
  if (/windows/.test(ua)) return "windows";
  return null;
}
