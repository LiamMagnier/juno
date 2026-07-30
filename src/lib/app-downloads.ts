/**
 * Where the desktop and mobile apps come from, and which one a visitor wants.
 *
 * Juno ships from two repositories: the Windows client is its own Tauri app in
 * `juno-windows`, and the Apple apps build out of this one. Both are public, so
 * a release asset is a plain URL and nothing here needs a token.
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
  /** Absent until a release publishes an asset for this platform. */
  url: string | null;
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
  /** Shown in place of a version when there is nothing to download yet. */
  note?: string;
}

export const DOWNLOAD_REPOS = {
  apple: "LiamMagnier/juno",
  windows: "LiamMagnier/juno-windows",
} as const;

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
  name: string;
  browser_download_url: string;
  size?: number;
  /** `sha256:<hex>` on releases published since GitHub added the field. */
  digest?: string | null;
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
