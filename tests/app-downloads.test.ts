import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareReleaseVersions,
  isNotarized,
  isStableRelease,
  manifestAsset,
  parseReleaseManifest,
  releaseVersion,
} from "@/lib/app-downloads";

test("download menus never expose draft or prerelease builds", () => {
  assert.equal(isStableRelease({ draft: true }), false);
  assert.equal(isStableRelease({ prerelease: true }), false);
  assert.equal(isStableRelease({ draft: true, prerelease: true }), false);
  assert.equal(isStableRelease({}), true);
  assert.equal(isStableRelease(null), false);
});

test("release selection uses the highest valid SemVer, not publication order", () => {
  const newerVersion = { tag_name: "v0.12.0", published_at: "2026-08-01T00:00:00Z" };
  const laterBackport = { tag_name: "v0.11.2", published_at: "2026-08-02T00:00:00Z" };
  assert.ok(compareReleaseVersions(newerVersion, laterBackport) < 0);
});

test("stable releases outrank their prereleases", () => {
  const stable = { tag_name: "v0.12.0", published_at: "2026-08-01T00:00:00Z" };
  const prerelease = { tag_name: "v0.12.0-rc.1", published_at: "2026-08-02T00:00:00Z" };
  assert.ok(compareReleaseVersions(stable, prerelease) < 0);
});

test("malformed release tags are excluded rather than hiding a valid build", () => {
  assert.equal(releaseVersion("v0.12"), null);
  assert.equal(releaseVersion("v0.12.0-01"), null);
  assert.equal(releaseVersion("v0.12.0"), "0.12.0");
});

/**
 * The regression this file existed without.
 *
 * Every macOS release from v0.15.15 to v1.5.4 was signed for development and
 * never notarized — each one says so in its own release notes — and the download
 * menu offered every one of them, because nothing in the feed could tell a
 * notarized build from an unnotarized one. A visitor's Mac answered with "Apple
 * could not verify Juno-1.5.4.dmg is free of malware", offering only Move to
 * Trash. Notarization is now a fact the release carries, and reading it fails
 * closed.
 */
test("a build is only notarized when its manifest says so", () => {
  assert.equal(isNotarized({ notarized: true }), true);
  assert.equal(isNotarized({ notarized: false }), false);
  // No field: every release published before the script recorded one.
  assert.equal(isNotarized({ version: "1.5.4" }), false);
  // No manifest at all, or one that could not be read.
  assert.equal(isNotarized(null), false);
  assert.equal(isNotarized(undefined), false);
});

test("an unreadable or hostile manifest never reads as notarized", () => {
  assert.equal(parseReleaseManifest("not json at all"), null);
  assert.equal(isNotarized(parseReleaseManifest("not json at all")), false);
  assert.equal(isNotarized(parseReleaseManifest("null")), false);
  assert.equal(isNotarized(parseReleaseManifest("[]")), false);
  // A truthy non-boolean must not be mistaken for proof.
  assert.equal(isNotarized(parseReleaseManifest('{"notarized":"yes"}')), false);
  assert.equal(isNotarized(parseReleaseManifest('{"notarized":1}')), false);
  assert.equal(isNotarized(parseReleaseManifest('{"notarized":true}')), true);
});

test("the published v1.5.4 manifest does not claim notarization", () => {
  // The real asset, trimmed to the fields read here. It is the shape every
  // release published to date has: no `notarized` key.
  const published = JSON.stringify({
    schema_version: 1,
    product: "Juno",
    platform: "macos",
    channel: "stable",
    version: "1.5.4",
    build: "86",
    team_id: "58PVP763WX",
  });
  const manifest = parseReleaseManifest(published);
  assert.equal(manifest?.version, "1.5.4");
  assert.equal(isNotarized(manifest), false);
});

test("the provenance manifest is found among the release assets", () => {
  const assets = [
    { name: "Juno-1.5.4.dmg", browser_download_url: "https://example.test/dmg" },
    { name: "Juno-1.5.4.dSYM.zip", browser_download_url: "https://example.test/dsym" },
    { name: "Juno-1.5.4.release.json", browser_download_url: "https://example.test/manifest" },
    { name: "SHA256SUMS.txt", browser_download_url: "https://example.test/sums" },
  ];
  assert.equal(manifestAsset(assets)?.browser_download_url, "https://example.test/manifest");
  assert.equal(manifestAsset(assets.slice(0, 2)), null);
});

test("the two download surfaces revalidate on the same clock", () => {
  // Both route segments hard-code 60 because Next reads that config by static
  // analysis and an imported constant is not reliably resolvable. This keeps the
  // literals honest about the constant they mirror.
  const feed = readFileSync(new URL("../src/lib/download-feed.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/app/api/downloads/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/download/page.tsx", import.meta.url), "utf8");
  assert.match(feed, /export const DOWNLOAD_FEED_REVALIDATE = 60;/);
  assert.match(route, /export const revalidate = 60;/);
  assert.match(page, /export const revalidate = 60;/);
});

test("no surface links at the deleted self-signed installer", () => {
  // docs/native/RELEASE.md described public/downloads/Juno.dmg as "rejected by
  // Gatekeeper. It must not be promoted." The landing hero and the features list
  // both linked straight at it.
  for (const file of ["../src/components/landing/landing-page.tsx", "../src/components/landing/features.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /href: "\/downloads\/Juno\.dmg"/);
    assert.match(source, /"\/download"/);
  }
});
