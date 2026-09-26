/**
 * The transcript markdown's fence and streaming helpers (src/lib/markdown-fence.ts):
 * the filename a fence declares, the file a diff names, and a link held back
 * as its words until its syntax is complete.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffFilename, fenceFilename, hideDanglingLink } from "@/lib/markdown-fence";

test("a fence's filename comes from title=, filename= or a bare path", () => {
  assert.equal(fenceFilename('title="src/auth.ts"'), "src/auth.ts");
  assert.equal(fenceFilename("filename=src/auth.ts"), "src/auth.ts");
  assert.equal(fenceFilename("title='a b.py' showLineNumbers"), "a b.py");
  assert.equal(fenceFilename("src/lib/cache-meter.ts"), "src/lib/cache-meter.ts");
  assert.equal(fenceFilename("Dockerfile/"), undefined);
  assert.equal(fenceFilename("showLineNumbers"), undefined);
  assert.equal(fenceFilename("{1,3-5}"), undefined);
  assert.equal(fenceFilename(undefined), undefined);
});

test("a diff names the file from +++ b/, falling back to --- a/ for a deletion", () => {
  assert.equal(diffFilename("--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b"), "src/x.ts");
  assert.equal(diffFilename("--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a"), "old.ts");
  assert.equal(diffFilename("+++ b/f.ts\t2026-09-26 10:00"), "f.ts");
  assert.equal(diffFilename("-a\n+b"), undefined);
});

test("a link still streaming shows its label, never its syntax", () => {
  assert.equal(hideDanglingLink("See [the pricing"), "See the pricing");
  assert.equal(hideDanglingLink("See [the pricing notes](https://exa"), "See the pricing notes");
  assert.equal(hideDanglingLink("See [the notes](https://example.com)"), "See [the notes](https://example.com)");
  assert.equal(hideDanglingLink("As shown [3] and"), "As shown [3] and");
  // Inside an open inline code span the bracket is code, not a link.
  assert.equal(hideDanglingLink("Run `arr[0"), "Run `arr[0");
});
