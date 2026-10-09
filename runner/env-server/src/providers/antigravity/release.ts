/**
 * Google's official Antigravity ACP runtime, as published in the ACP registry
 * (https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp).
 *
 * Alevr downloads exactly these archives from Google's own CDN and refuses
 * anything whose size or SHA-256 differs; the URLs, hashes and sizes are the
 * registry's (recorded by T3 Code, MIT, from registry commit dc55a349 on
 * 2026-10-05). A new release means a new row here, never a fetched manifest.
 */
export interface AntigravityReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: { readonly name: string; readonly bytes: number };
  readonly harness: { readonly name: string; readonly bytes: number };
}

export const ANTIGRAVITY_RELEASE_VERSION = "1.3.0";

const RELEASES: Readonly<Record<string, AntigravityReleaseAsset>> = {
  "darwin-arm64": {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip",
    sha256: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
    archiveBytes: 111_456_962,
    executable: { name: "agy_acp_server.par", bytes: 278_535_456 },
    harness: { name: "localharness_external", bytes: 118_611_392 },
  },
  "darwin-x64": {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip",
    sha256: "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646",
    archiveBytes: 117_245_544,
    executable: { name: "agy_acp_server.par", bytes: 282_840_688 },
    harness: { name: "localharness_external", bytes: 124_175_392 },
  },
  "linux-x64": {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip",
    sha256: "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96",
    archiveBytes: 333_727_150,
    executable: { name: "agy_acp_server.par", bytes: 926_533_965 },
    harness: { name: "localharness_external", bytes: 130_388_040 },
  },
  "linux-arm64": {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip",
    sha256: "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf",
    archiveBytes: 321_690_363,
    executable: { name: "agy_acp_server.par", bytes: 930_848_992 },
    harness: { name: "localharness_external", bytes: 123_224_968 },
  },
};

export function antigravityReleaseFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): AntigravityReleaseAsset | null {
  return RELEASES[`${platform}-${arch}`] ?? null;
}

/** File names inside a release (and next to a manually installed runtime). */
export const ANTIGRAVITY_EXECUTABLE = "agy_acp_server.par";
export const ANTIGRAVITY_HARNESS = "localharness_external";
