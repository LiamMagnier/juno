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
  const message = '<p>Here is the icon.</p><juno:artifact identifier="icon" type="SVG" title="Icon"><svg viewBox="0 0 1 1">';
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
