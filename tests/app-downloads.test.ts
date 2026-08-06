import test from "node:test";
import assert from "node:assert/strict";
import { isStableRelease } from "@/lib/app-downloads";

test("download menus never expose draft or prerelease builds", () => {
  assert.equal(isStableRelease({ draft: true }), false);
  assert.equal(isStableRelease({ prerelease: true }), false);
  assert.equal(isStableRelease({ draft: true, prerelease: true }), false);
  assert.equal(isStableRelease({}), true);
  assert.equal(isStableRelease(null), false);
});
