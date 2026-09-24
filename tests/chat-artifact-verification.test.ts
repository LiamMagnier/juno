import test from "node:test";
import assert from "node:assert/strict";
import { parseArtifacts, rewriteArtifactMarkup } from "@/lib/message-content";
import {
  artifactVerificationDetail,
  verifyAndRepairChatArtifacts,
} from "@/lib/chat-artifact-verification";

test("valid chat artifacts pass the open/parse/verify boundary", () => {
  const parsed = parseArtifacts(
    '<juno:artifact identifier="icon" type="SVG" title="Icon"><svg viewBox="0 0 1 1"></svg></juno:artifact>'
  );
  const result = verifyAndRepairChatArtifacts(parsed);
  assert.equal(result.report.status, "verified");
  assert.equal(result.report.attempts, 0);
  assert.equal(result.artifacts[0]?.content.endsWith("</svg>"), true);
});

test("one unambiguous SVG failure gets one bounded repair and the message is rewritten", () => {
  // The artifact block is closed and only the SVG inside it is not. A block
  // whose own closing tag never arrived is unfinished, and is refused rather
  // than repaired (X-07, tests/artifact-truncation.test.ts).
  const message =
    '<p>Here is the icon.</p><juno:artifact identifier="icon" type="SVG" title="Icon"><svg viewBox="0 0 1 1"></juno:artifact>';
  const parsed = parseArtifacts(message);
  const result = verifyAndRepairChatArtifacts(parsed);
  assert.equal(result.report.status, "repaired");
  assert.equal(result.report.attempts, 1);
  assert.equal(result.report.refused.length, 0);
  assert.equal(result.report.repairs[0]?.code, "svg_close_missing");
  const rewritten = rewriteArtifactMarkup(message, [
    { identifier: "icon", content: result.artifacts[0]?.content },
  ]);
  assert.match(rewritten, /<\/svg><\/juno:artifact>/);
  assert.match(artifactVerificationDetail(result.report), /bounded repair/);
});

test("unrecoverable artifacts are refused and removed from the renderable message", () => {
  const message = '<juno:artifact identifier="bad" type="SVG" title="Bad">just text</juno:artifact>';
  const result = verifyAndRepairChatArtifacts(parseArtifacts(message));
  assert.equal(result.report.status, "refused");
  assert.equal(result.report.attempts, 0);
  assert.deepEqual(result.artifacts, []);
  const rewritten = rewriteArtifactMarkup(message, [
    { identifier: "bad", refusal: "Artifact unavailable: verification failed." },
  ]);
  assert.doesNotMatch(rewritten, /juno:artifact/);
  assert.match(rewritten, /verification failed/);
});

/** A compact dashboard of `cards` cards, the shape the model writes for DESIGN. */
function compactDashboard(cards: number): string {
  const card = (i: number) => ({
    type: "frame",
    name: `Card ${i}`,
    x: (i % 6) * 220,
    y: Math.floor(i / 6) * 180,
    width: 200,
    height: 160,
    fill: "#ffffff",
    radius: 12,
    layout: { direction: "vertical", gap: 8, padding: 16 },
    children: [
      { type: "text", name: "Title", text: `Item ${i}`, fontSize: 18, fontWeight: 600 },
      { type: "text", name: "Body", text: "Short description.", fontSize: 13 },
      { type: "rectangle", name: "Bar", width: 168, height: 6, fill: "#3b82f6", radius: 3 },
    ],
  });
  return JSON.stringify({
    name: "Dashboard",
    nodes: [{ type: "frame", name: "Screen", width: 1440, height: 2000, children: Array.from({ length: cards }, (_, i) => card(i)) }],
  });
}

test("a design is size-checked as stored, after expansion, not as written", () => {
  const compact = compactDashboard(100);
  assert.ok(compact.length < 200_000, "the compact form is under the limit");
  const result = verifyAndRepairChatArtifacts([
    { identifier: "dash", type: "DESIGN", title: "Dashboard", content: compact },
  ]);
  assert.equal(result.report.status, "refused");
  assert.deepEqual(result.report.refused, ["dash"]);
  assert.equal(result.report.problems[0]?.code, "too_large");
  assert.match(result.report.problems[0]?.detail ?? "", /expands to/);
});

test("a design that stays under the limit once expanded is accepted", () => {
  const result = verifyAndRepairChatArtifacts([
    { identifier: "dash", type: "DESIGN", title: "Dashboard", content: compactDashboard(25) },
  ]);
  assert.equal(result.report.status, "verified");
  assert.equal(result.artifacts.length, 1);
});

/** A compact design with `pictures` image layers, the shape a model writes for a photo. */
function compactWithPictures(pictures: number): string {
  return JSON.stringify({
    name: "Profile",
    nodes: [
      {
        type: "frame",
        name: "Screen",
        width: 375,
        height: 812,
        fill: "#ffffff",
        children: Array.from({ length: pictures }, (_, i) => ({
          type: "image",
          name: `Photo ${i + 1}`,
          x: 24,
          y: 24 + i * 140,
          width: 120,
          height: 120,
        })),
      },
    ],
  });
}

test("a picture that became a placeholder is a note on a verified design, and the detail says so", () => {
  const result = verifyAndRepairChatArtifacts([
    { identifier: "profile", type: "DESIGN", title: "Profile", content: compactWithPictures(1) },
  ]);
  // A note never moves the status: the design is saved either way.
  assert.equal(result.report.status, "verified");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.report.notes?.length, 1);
  assert.equal(result.report.notes?.[0]?.identifier, "profile");
  assert.equal(result.report.notes?.[0]?.code, "image_placeholder");
  assert.match(result.report.notes?.[0]?.detail ?? "", /Photo 1/);
  assert.equal(artifactVerificationDetail(result.report), "1 artifact opened and verified. 1 picture became a placeholder.");
});

test("several pictures read as one plural sentence; a design without any adds nothing", () => {
  const three = verifyAndRepairChatArtifacts([
    { identifier: "profile", type: "DESIGN", title: "Profile", content: compactWithPictures(3) },
  ]);
  assert.equal(three.report.notes?.length, 3);
  assert.match(artifactVerificationDetail(three.report), / 3 pictures became placeholders\.$/);

  const none = verifyAndRepairChatArtifacts([
    { identifier: "dash", type: "DESIGN", title: "Dashboard", content: compactDashboard(2) },
  ]);
  assert.deepEqual(none.report.notes, []);
  assert.equal(artifactVerificationDetail(none.report), "1 artifact opened and verified.");
});

test("a refused design leaves no note, and a report from before notes still reads", () => {
  // Over the stored limit once expanded: refused, so nothing of it was saved.
  const tooBig = JSON.parse(compactDashboard(100)) as { nodes: Array<{ children: unknown[] }> };
  tooBig.nodes[0].children.push({ type: "image", name: "Hero", width: 100, height: 100 });
  const refused = verifyAndRepairChatArtifacts([
    { identifier: "dash", type: "DESIGN", title: "Dashboard", content: JSON.stringify(tooBig) },
  ]);
  assert.equal(refused.report.status, "refused");
  assert.deepEqual(refused.report.notes, []);

  // An activity row persisted before this release has no `notes` key at all.
  const legacy = { ...verifyAndRepairChatArtifacts([]).report, checked: 1 };
  delete legacy.notes;
  assert.equal(artifactVerificationDetail(legacy), "1 artifact opened and verified.");
});
