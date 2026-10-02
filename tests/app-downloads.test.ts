import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  UPDATER_DOWNLOAD_HOSTS,
  compareReleaseVersions,
  isNotarized,
  isStableRelease,
  isUpdaterDownloadUrl,
  manifestAsset,
  parseReleaseManifest,
  releaseVersion,
  signedUrlExpiry,
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
  // Gatekeeper. It must not be promoted." Check every current marketing entry
  // point that offers the installer: the homepage hero, its closing, and the platform chooser.
  for (const file of ["../src/components/home/hero.tsx", "../src/components/home/home-page.tsx", "../src/components/landing/platform-chooser.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /href: "\/downloads\/Juno\.dmg"/);
    assert.match(source, /"\/download"/);
  }
});

/*
 * A private repository's assets go out as signed URLs, and two facts about one
 * decide whether it is safe to hand out: whether an installed Mac will fetch it
 * at all, and when it stops working.
 */

test("the server's host list is the one compiled into every installed Mac app", () => {
  // v1.5.4's updater cannot be changed, so the server is what has to agree.
  const swift = readFileSync(
    new URL("../native/Packages/JunoNativeKit/Sources/JunoCore/JunoUpdateFeed.swift", import.meta.url),
    "utf8",
  );
  const literal = /let allowed = \[([^\]]*)\]/.exec(swift)?.[1];
  assert.ok(literal, "JunoUpdateFeed.validateOrigin still declares its allow-list");
  const hosts = [...literal.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(hosts, [...UPDATER_DOWNLOAD_HOSTS]);
});

test("only HTTPS on a GitHub release host counts as a URL the updater will fetch", () => {
  assert.equal(
    isUpdaterDownloadUrl(
      "https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sig=a%2Bb&se=2026-09-22T21%3A36%3A11Z",
    ),
    true,
  );
  assert.equal(isUpdaterDownloadUrl("https://objects.githubusercontent.com/x"), true);
  assert.equal(isUpdaterDownloadUrl("https://github.com/LiamMagnier/juno/releases/download/v1.5.4/Juno-1.5.4.dmg"), true);
  assert.equal(isUpdaterDownloadUrl("http://release-assets.githubusercontent.com/x"), false);
  assert.equal(isUpdaterDownloadUrl("https://release-assets.githubusercontent.com.evil.example/x"), false);
  assert.equal(isUpdaterDownloadUrl("https://githubXcom/x"), false);
  assert.equal(isUpdaterDownloadUrl("not a url"), false);
});

const jwtWith = (payload: unknown) =>
  ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(payload)).toString("base64url"), "c2ln"].join(".");

test("a signed URL expires at the earliest clock it carries", () => {
  const base = "https://release-assets.githubusercontent.com/github-production-release-asset/1/x";
  const jwtExpiry = Date.parse("2026-09-22T21:17:06Z");
  // The shape observed on 2026-09-22: a JWT half an hour out beside a SAS fifty minutes out.
  assert.equal(signedUrlExpiry(`${base}?se=2026-09-22T21%3A36%3A11Z&sig=a&jwt=${jwtWith({ exp: jwtExpiry / 1000 })}`), jwtExpiry);
  assert.equal(
    signedUrlExpiry(`${base}?se=2026-09-22T21%3A00%3A00Z&jwt=${jwtWith({ exp: jwtExpiry / 1000 })}`),
    Date.parse("2026-09-22T21:00:00Z"),
  );
  // The older S3 presign on objects.githubusercontent.com.
  assert.equal(
    signedUrlExpiry("https://objects.githubusercontent.com/x?X-Amz-Date=20260922T204706Z&X-Amz-Expires=300&X-Amz-Signature=a"),
    Date.parse("2026-09-22T20:52:06Z"),
  );
});

test("an expiry that cannot be read is dropped rather than trusted", () => {
  const base = "https://release-assets.githubusercontent.com/x";
  assert.equal(signedUrlExpiry(`${base}?sig=a`), null);
  assert.equal(signedUrlExpiry(`${base}?se=soon&jwt=not.a-jwt.at-all&X-Amz-Date=yesterday&X-Amz-Expires=300`), null);
  assert.equal(signedUrlExpiry(`${base}?jwt=${jwtWith({ exp: "later" })}`), null);
  // One garbled clock does not hide a readable one.
  assert.equal(signedUrlExpiry(`${base}?se=soon&jwt=${jwtWith({ exp: 1_790_000_000 })}`), 1_790_000_000_000);
  assert.equal(signedUrlExpiry("not a url"), null);
});
