import test from "node:test";
import assert from "node:assert/strict";
import { applySemanticEditReply, buildSemanticArtifactContext, resolveArtifactOps, type OpsTarget } from "@/lib/artifact-ops";
import { splitMessageContent, parseArtifacts, cleanForSpeech } from "@/lib/message-content";
import { verifyAndRepairChatArtifacts } from "@/lib/chat-artifact-verification";
import { storableContent } from "@/lib/artifact-content";
import { canonicalSemanticBody, describeSemantic, outlineSemantic } from "@/lib/work/deliverables/semantic";

/*
 * The chat side of semantic artifacts: the <juno:artifact-ops> protocol, how
 * a streaming edit renders, verification of model-authored bodies and the
 * whole-body save boundary. The database path is in
 * tests/semantic-artifact-chat.integration.test.ts.
 */

const workbook = canonicalSemanticBody(
  "SPREADSHEET",
  JSON.stringify({
    title: "Plan",
    names: { rate: "S!$B$1" },
    sheets: [{ name: "S", rows: [["Rate", 0.05], ["Base", 100], ["Result", { f: "=B2*(1+rate)" }]] }],
  })
);

const target = (content = workbook): OpsTarget => ({ identifier: "plan", type: "SPREADSHEET", title: "Plan", version: 3, content });
const ops = (body: unknown, identifier = "plan") => `<juno:artifact-ops identifier="${identifier}">${JSON.stringify(body)}</juno:artifact-ops>`;

test("an ops block becomes the artifact tag carrying the edited body", async () => {
  const text = `Done.\n\n${ops({ summary: "Raised the rate", ops: [{ op: "setCell", sheet: "S", cell: "rate", value: 0.075 }] })}\n\nAnything else?`;
  const result = await resolveArtifactOps(text, async (id) => (id === "plan" ? target() : null));
  assert.ok(result);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].baseVersion, 3);
  const [artifact] = parseArtifacts(result.text);
  assert.equal(artifact.identifier, "plan");
  assert.equal(artifact.type, "SPREADSHEET");
  assert.equal(JSON.parse(artifact.content).sheets[0].cells.B1.v, 0.075);
  assert.match(result.text, /^Done\.\n\nRaised the rate\n\n<juno:artifact /);
  assert.match(result.text, /Anything else\?$/);
});

test("a failing block is replaced by a notice and nothing is applied", async () => {
  const bad = await resolveArtifactOps(ops({ ops: [{ op: "setFormula", sheet: "S", cell: "B1", formula: "=B3" }] }), async () => target());
  assert.equal(bad?.applied.length, 0);
  assert.match(bad!.text, /Couldn't apply that edit to “Plan”: The formula in S!B1 would depend on itself/);
  assert.equal(parseArtifacts(bad!.text).length, 0);

  const missing = await resolveArtifactOps(ops({ ops: [] }, "nope"), async () => null);
  assert.match(missing!.text, /no artifact with that identifier/);

  const markdown = await resolveArtifactOps(ops({ ops: [{ op: "x" }] }), async () => ({ ...target(), type: "MARKDOWN" }));
  assert.match(markdown!.text, /only spreadsheets, documents and decks take operations/);

  const notJson = await resolveArtifactOps(`<juno:artifact-ops identifier="plan">{nope</juno:artifact-ops>`, async () => target());
  assert.match(notJson!.text, /not valid JSON/);
});

test("two blocks for one artifact apply in order and save one version", async () => {
  const text =
    ops({ summary: "first", ops: [{ op: "setCell", sheet: "S", cell: "B2", value: 200 }] }) +
    "\n" +
    ops({ summary: "second", ops: [{ op: "setCell", sheet: "S", cell: "B1", value: 0.1 }] });
  const result = await resolveArtifactOps(text, async () => target());
  const artifacts = parseArtifacts(result!.text);
  assert.equal(artifacts.length, 1);
  const cells = JSON.parse(artifacts[0].content).sheets[0].cells;
  assert.equal(cells.B2.v, 200);
  assert.equal(cells.B1.v, 0.1);
  assert.match(result!.text, /^first\nsecond\n\n<juno:artifact /);
});

test("an unclosed ops block is dropped, never applied", async () => {
  const result = await resolveArtifactOps(`Working…<juno:artifact-ops identifier="plan">{"ops":[`, async () => target());
  assert.equal(result!.text, "Working…");
});

test("a streaming edit renders as a reference to the artifact, never as raw JSON", () => {
  const streaming = splitMessageContent(`Updating now. <juno:artifact-ops identifier="plan">{"ops":[{"op":"setCell"`);
  assert.deepEqual(streaming.map((part) => part.type), ["text", "artifact"]);
  assert.equal(streaming[1].type === "artifact" && streaming[1].identifier, "plan");
  assert.ok(!JSON.stringify(streaming).includes("setCell"));
  const closed = splitMessageContent(`A ${ops({ ops: [] })} B`);
  assert.deepEqual(closed.map((part) => part.type), ["text", "artifact", "text"]);
  assert.equal(cleanForSpeech(`Sure. ${ops({ ops: [] })}`), "Sure. I've updated that in the canvas.");
});

test("verification accepts a valid semantic body and refuses an invalid one", () => {
  const good = verifyAndRepairChatArtifacts([
    { identifier: "plan", type: "SPREADSHEET", title: "Plan", content: JSON.stringify({ title: "Plan", sheets: [{ name: "S", rows: [[1, { f: "=A1*2" }]] }] }) },
  ]);
  assert.equal(good.report.status, "verified");
  const bad = verifyAndRepairChatArtifacts([
    { identifier: "plan", type: "SPREADSHEET", title: "Plan", content: JSON.stringify({ title: "Plan", sheets: [{ name: "S", rows: [[{ f: "=WEBSERVICE(\"x\")" }]] }] }) },
    { identifier: "deck", type: "PRESENTATION", title: "Deck", content: "not json" },
  ]);
  assert.deepEqual(bad.report.refused.sort(), ["deck", "plan"]);
  assert.ok(bad.report.problems.every((p) => p.code === "semantic_invalid"));
});

test("a whole-body save stores the canonical model or refuses", () => {
  const saved = storableContent("SPREADSHEET", JSON.stringify({ title: "x", sheets: [{ name: "S", rows: [[{ f: "= sum( 1 , 2 )" }]] }] }));
  assert.ok(saved.ok);
  assert.equal(JSON.parse(saved.content).sheets[0].cells.A1.f, "SUM(1,2)");
  const refused = storableContent("DOCUMENT", JSON.stringify({ title: "x", blocks: [{ type: "table", header: ["a"], rows: [["1", "2"]] }] }));
  assert.equal(refused.ok, false);
  assert.deepEqual(storableContent("MARKDOWN", "# hi"), { ok: true, content: "# hi" });
});

test("the targeted-edit reply applies to the selected version", () => {
  const edited = applySemanticEditReply(target(), ops({ summary: "x", ops: [{ op: "setCell", sheet: "S", cell: "B2", value: 1 }] }));
  assert.equal(JSON.parse(edited.content).sheets[0].cells.B2.v, 1);
  assert.throws(() => applySemanticEditReply(target(), "no ops here"), /did not return operations/);
});

test("the prompt section lists outlines and the ops contract", () => {
  const section = buildSemanticArtifactContext([
    { identifier: "plan", type: "SPREADSHEET", title: "Plan", version: 3, outline: outlineSemantic("SPREADSHEET", workbook) },
  ]);
  assert.match(section!, /identifier "plan", SPREADSHEET, version 3/);
  assert.match(section!, /B3: =B2\*\(1\+rate\) → 105/);
  assert.match(section!, /<juno:artifact-ops identifier="IDENTIFIER">/);
  assert.equal(buildSemanticArtifactContext([]), null);
  assert.equal(describeSemantic("SPREADSHEET", workbook), "1 sheet · 1 formula");
});
