import test from "node:test";
import assert from "node:assert/strict";
import {
  compareReleaseVersions,
  isStableRelease,
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
