import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseArtifacts,
  parseStreamingArtifact,
  rewriteArtifactMarkup,
  splitMessageContent,
} from "@/lib/message-content";
import {
  artifactRefusalNotice,
  artifactVerificationDetail,
  artifactVerificationTitle,
  verifyAndRepairChatArtifacts,
} from "@/lib/chat-artifact-verification";

/*
 * A STOPPED OR CUT-OFF REVISION NEVER BECOMES THE CURRENT VERSION (X-07).
 *
 * A reply that ends inside an artifact, because the reader pressed Stop or the
 * model reached its output limit, leaves a block whose closing tag never
 * arrived. The parser used to return that block exactly like a closed one,
 * verification then passed it ("Artifact verified"), the message rewrite added
 * the missing closing tag, and the chat route saved it as the artifact's next
 * version, so a half-written revision replaced the finished one and read as
 * complete on every later load (docs/design/artifacts-design/00-AUDIT-OVERVIEW.md).
 *
 * The rule, end to end: the parser flags the block `incomplete`, verification
 * refuses it with its own problem code and never repairs it, the rewrite can
 * withdraw it but never seal it, and both of the route's persistence spots
 * (the finished turn and the stopped one) write only finished artifacts.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const REVISION_START =
  'Here is the updated page.\n\n<juno:artifact identifier="landing" type="html" title="Landing Page" language="html">' +
  "<!doctype html><html><body><h1>Launch</h1><p>Half of the new";

test("the parser flags a trailing block whose closing tag never arrived", () => {
  const [artifact] = parseArtifacts(REVISION_START);
  assert.equal(artifact?.identifier, "landing");
  assert.equal(artifact?.incomplete, true);
  // What arrived is still there for a reader (the research report dialog).
  assert.match(artifact?.content ?? "", /Half of the new$/);
});

test("a closed block is not flagged, even when an unclosed one follows it", () => {
  const message =
    '<juno:artifact identifier="icon" type="svg" title="Icon"><svg viewBox="0 0 1 1"></svg></juno:artifact>\n' +
    'And the page:\n<juno:artifact identifier="page" type="html" title="Page"><html><body>';
  const parsed = parseArtifacts(message);
  assert.deepEqual(
    parsed.map((artifact) => [artifact.identifier, artifact.incomplete ?? false]),
    [
      ["icon", false],
      ["page", true],
    ]
  );
});

test("a cut-off re-emission of an identifier already closed in the reply leaves the closed one alone", () => {
  const message =
    '<juno:artifact identifier="notes" type="markdown" title="Notes"># Done</juno:artifact>\n' +
    '<juno:artifact identifier="notes" type="markdown" title="Notes"># Redo, half';
  const parsed = parseArtifacts(message);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.content, "# Done");
  assert.equal(parsed[0]?.incomplete, undefined);
});

test("verification refuses an unfinished artifact with its own code, and does not repair it", () => {
  const result = verifyAndRepairChatArtifacts(parseArtifacts(REVISION_START));
  assert.equal(result.report.status, "refused");
  assert.equal(result.report.attempts, 0);
  assert.deepEqual(result.artifacts, [], "nothing is handed to persistence");
  assert.deepEqual(result.report.accepted, []);
  assert.deepEqual(result.report.refused, ["landing"]);
  assert.equal(result.report.problems.length, 1);
  assert.equal(result.report.problems[0]?.code, "incomplete");
  assert.equal(result.report.problems[0]?.repairable, false);
  assert.deepEqual(result.report.repairs, []);
});

test("a cut-off SVG is refused as unfinished, not closed with a repaired </svg>", () => {
  // The old repair: an unclosed SVG got "</svg>" appended and the block
  // sealed, so a truncated drawing was saved and labelled "repaired".
  const message = '<juno:artifact identifier="icon" type="SVG" title="Icon"><svg viewBox="0 0 1 1"><path d="M0 0';
  const result = verifyAndRepairChatArtifacts(parseArtifacts(message));
  assert.equal(result.report.status, "refused");
  assert.equal(result.report.attempts, 0);
  assert.deepEqual(
    result.report.problems.map((item) => item.code),
    ["incomplete"]
  );
});

test("a closed block still verifies", () => {
  const message =
    'Done.\n<juno:artifact identifier="landing" type="html" title="Landing Page">' +
    "<!doctype html><html><body><h1>Launch</h1></body></html></juno:artifact>";
  const result = verifyAndRepairChatArtifacts(parseArtifacts(message));
  assert.equal(result.report.status, "verified");
  assert.deepEqual(result.report.accepted, ["landing"]);
  assert.equal(result.artifacts[0]?.incomplete, undefined);
  assert.equal(artifactVerificationTitle(result.report), "Artifact verified");
  assert.match(artifactVerificationDetail(result.report), /1 artifact opened and verified/);
});

test("a closed SVG missing only </svg> still gets its one bounded repair", () => {
  const message = '<juno:artifact identifier="icon" type="SVG" title="Icon"><svg viewBox="0 0 1 1"></juno:artifact>';
  const result = verifyAndRepairChatArtifacts(parseArtifacts(message));
  assert.equal(result.report.status, "repaired");
  assert.equal(result.report.attempts, 1);
  assert.equal(result.artifacts[0]?.content.endsWith("</svg>"), true);
  assert.equal(result.report.repairs[0]?.code, "svg_close_missing");
});

test("a Stop inside the second artifact does not cost the finished first one its repair", () => {
  const message =
    '<juno:artifact identifier="icon" type="SVG" title="Icon"><svg viewBox="0 0 1 1"></juno:artifact>\n' +
    '<juno:artifact identifier="page" type="html" title="Page"><html><body><p>Hal';
  const result = verifyAndRepairChatArtifacts(parseArtifacts(message));
  assert.equal(result.report.status, "refused");
  assert.equal(result.report.attempts, 1);
  assert.deepEqual(result.report.accepted, ["icon"]);
  assert.deepEqual(result.report.refused, ["page"]);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.content.endsWith("</svg>"), true, "the finished SVG was repaired");
  assert.deepEqual(
    result.report.repairs.map((item) => [item.identifier, item.code]),
    [["icon", "svg_close_missing"]]
  );
  assert.deepEqual(
    result.report.problems.map((item) => [item.identifier, item.code]),
    [["page", "incomplete"]]
  );
});

test("an unfinished artifact is described as stopped, not as a verification failure", () => {
  const unfinished = verifyAndRepairChatArtifacts(parseArtifacts(REVISION_START)).report;
  assert.equal(artifactVerificationTitle(unfinished), "Artifact not saved");
  assert.equal(artifactVerificationDetail(unfinished), "1 artifact stopped before it was finished, so it was not saved.");
  assert.equal(artifactRefusalNotice(unfinished, "landing"), "Artifact not saved: it stopped before it was finished.");

  // A genuinely bad artifact keeps the verification wording.
  const bad = verifyAndRepairChatArtifacts(
    parseArtifacts('<juno:artifact identifier="bad" type="SVG" title="Bad">just text</juno:artifact>')
  ).report;
  assert.equal(artifactVerificationTitle(bad), "Artifact refused");
  assert.equal(artifactVerificationDetail(bad), "1 artifact refused after 0 repair attempts.");
  assert.match(artifactRefusalNotice(bad, "bad"), /verification failed/);

  // Both at once: each is counted under its own reason.
  const mixed = verifyAndRepairChatArtifacts(
    parseArtifacts(
      '<juno:artifact identifier="bad" type="SVG" title="Bad">just text</juno:artifact>\n' +
        '<juno:artifact identifier="page" type="html" title="Page"><html><body><p>Hal'
    )
  ).report;
  assert.equal(artifactVerificationTitle(mixed), "Artifact refused");
  assert.equal(
    artifactVerificationDetail(mixed),
    "1 artifact stopped before it was finished, so it was not saved; 1 artifact refused after 0 repair attempts."
  );
});

test("the message rewrite can withdraw an unfinished block but never seal it", () => {
  // A content update naming the unclosed block leaves it exactly as it arrived:
  // closing the tag is what made a stopped revision read as complete on reload.
  assert.equal(rewriteArtifactMarkup(REVISION_START, [{ identifier: "landing", content: "<html></html>" }]), REVISION_START);

  const withdrawn = rewriteArtifactMarkup(REVISION_START, [
    { identifier: "landing", refusal: "Artifact not saved: it stopped before it was finished." },
  ]);
  assert.doesNotMatch(withdrawn, /juno:artifact/);
  assert.match(withdrawn, /^Here is the updated page\./, "the answer's own text is kept");
  assert.match(withdrawn, /Artifact not saved: it stopped before it was finished\./);
});

test("the route's pipeline, run on a Stop mid-revision, saves the text and no version", () => {
  // What prepareChatArtifactOutput does with the partial reply, step by step.
  const parsed = parseArtifacts(REVISION_START);
  const { artifacts, report } = verifyAndRepairChatArtifacts(parsed);
  const text = rewriteArtifactMarkup(REVISION_START, [
    ...artifacts.map((artifact) => ({ identifier: artifact.identifier, content: artifact.content })),
    ...report.refused.map((identifier) => ({ identifier, refusal: artifactRefusalNotice(report, identifier) })),
  ]);
  assert.deepEqual(
    artifacts.filter((artifact) => !artifact.incomplete),
    [],
    "persistArtifacts receives nothing, so the artifact keeps its current version"
  );
  assert.deepEqual(parseArtifacts(text), [], "the saved message holds no artifact to re-read later");
  assert.match(text, /Here is the updated page\./);
});

test("both of the route's persistence spots write only finished artifacts", () => {
  const route = read("src/app/api/chat/route.ts");
  const writes = [...route.matchAll(/persistArtifacts\(\s*conversationId,\s*assistant\.id,\s*([^;]*?)\)\s*;/g)];
  assert.equal(writes.length, 2, "the finished turn and the stopped one");
  for (const [, argument] of writes) {
    assert.match(argument, /preparedArtifacts\?\.result\.artifacts \?\? \[\]/);
    assert.match(argument, /\.filter\(\(artifact\) => !artifact\.incomplete\)/);
  }
});

test("streaming is unchanged: an open block still renders as a live card", () => {
  const streaming = parseStreamingArtifact(REVISION_START);
  assert.equal(streaming?.streaming, true);
  assert.equal(streaming?.identifier, "landing");
  assert.equal("incomplete" in (streaming ?? {}), false);

  const parts = splitMessageContent(REVISION_START);
  const card = parts.find((part) => part.type === "artifact");
  assert.equal(card?.type, "artifact");
  assert.equal(card?.type === "artifact" && card.streaming, true);
  assert.equal(card?.type === "artifact" && card.identifier, "landing");
});
