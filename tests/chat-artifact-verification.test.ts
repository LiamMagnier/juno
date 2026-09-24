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
