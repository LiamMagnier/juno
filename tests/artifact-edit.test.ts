import assert from "node:assert/strict";
import test from "node:test";
import {
  applyArtifactPatch,
  ArtifactPatchError,
  buildArtifactEditMessage,
  parseArtifactPatch,
} from "../src/lib/artifact-edit";

test("parses a tagged JSON patch and changes only the exact anchored range", () => {
  const source = "before\nconst tone = 'red';\nafter\n";
  const patch = parseArtifactPatch(`<juno:artifact-patch>
{"summary":"Changed the accent color.","edits":[{"search":"const tone = 'red';","replace":"const tone = 'blue';"}]}
</juno:artifact-patch>`);

  assert.equal(applyArtifactPatch(source, patch), "before\nconst tone = 'blue';\nafter\n");
  assert.equal(patch.summary, "Changed the accent color.");
});

test("applies multiple source-relative edits without shifting later anchors", () => {
  const source = "alpha\nkeep\nomega";
  const updated = applyArtifactPatch(source, {
    edits: [
      { search: "alpha", replace: "a much longer beginning" },
      { search: "omega", replace: "end" },
    ],
  });
  assert.equal(updated, "a much longer beginning\nkeep\nend");
});

test("rejects missing, ambiguous, overlapping, and no-op patches", () => {
  assert.throws(() => applyArtifactPatch("same same", { edits: [{ search: "same", replace: "new" }] }), ArtifactPatchError);
  assert.throws(() => applyArtifactPatch("source", { edits: [{ search: "missing", replace: "new" }] }), ArtifactPatchError);
  assert.throws(
    () => applyArtifactPatch("abcdef", { edits: [{ search: "abc", replace: "x" }, { search: "bc", replace: "y" }] }),
    ArtifactPatchError
  );
  assert.throws(() => applyArtifactPatch("source", { edits: [{ search: "source", replace: "source" }] }), ArtifactPatchError);
});

test("rejects whole-artifact rewrites and oversized insertions", () => {
  const source = "a".repeat(1_000);
  assert.throws(
    () => applyArtifactPatch(source, { edits: [{ search: source, replace: "an entirely different website" }] }),
    /too broad/
  );
  assert.throws(
    () => applyArtifactPatch("<main>keep</main>", { edits: [{ search: "keep", replace: "x".repeat(21_000) }] }),
    /adds too much code/
  );
});

test("builds one same-identifier artifact message after the patch is applied", () => {
  const message = buildArtifactEditMessage(
    { identifier: "landing-page", title: "Landing Page", type: "HTML", language: "html", version: 4, content: "old" },
    "<main>Updated</main>",
    "Updated the hero."
  );
  assert.match(message, /^Updated the hero\./);
  assert.match(message, /<juno:artifact identifier="landing-page" type="HTML" title="Landing Page" language="html">/);
  assert.match(message, /<main>Updated<\/main>/);
});
