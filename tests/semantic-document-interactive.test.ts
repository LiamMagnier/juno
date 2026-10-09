import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";
import {
  documentPlainText,
  interactiveSummary,
  normalizeDocument,
  outlineDocument,
  serializeDocument,
  type InteractiveBlock,
} from "@/lib/work/deliverables/semantic/document/model";
import { applyDocumentOps } from "@/lib/work/deliverables/semantic/document/ops";
import { exportDocumentDocx } from "@/lib/work/deliverables/semantic/document/docx-export";

/*
 * An "interactive" block holds a Live UI view inside a DOCUMENT artifact
 * (owner, 2026-10-09: artifacts must be compatible with Live UI). The canvas
 * runs it; the plain text, the outline and the .docx keep its readable parts,
 * and never a quiz's answer.
 */

const view = {
  title: "How Oracle runs a SELECT",
  ui: [
    {
      type: "steps",
      steps: [
        { title: "FROM", summary: "Opens the table.", notice: "The alias is born here." },
        { title: "WHERE", summary: "Filters the rows." },
      ],
      takeaway: "Written SELECT first, run FROM first.",
    },
    {
      type: "quiz",
      questions: [
        {
          question: "Which clause runs first?",
          options: ["SELECT", "FROM"],
          answer: 1,
          explanation: "FROM opens the table before anything else.",
        },
      ],
    },
  ],
};

function model(blocks: unknown[]) {
  return normalizeDocument({ title: "Chapitre 1", blocks });
}

test("a valid view is accepted, keeps its JSON and serializes with the block's keys", () => {
  const doc = model([{ type: "heading", level: 1, text: "Chapitre 1" }, { type: "interactive", view, caption: "Essaie chaque étape." }]);
  const block = doc.blocks[1] as InteractiveBlock;
  assert.equal(block.type, "interactive");
  assert.deepEqual(block.view, view);
  const round = normalizeDocument(JSON.parse(serializeDocument(doc)));
  assert.deepEqual(round.blocks[1], block);
});

test("a view that is not a Live UI view is refused", () => {
  assert.throws(() => model([{ type: "interactive", view: { title: "Nothing to draw" } }]), SemanticError);
  assert.throws(() => model([{ type: "interactive", view: "not an object" }]), SemanticError);
  assert.throws(() => model([{ type: "interactive", view: { title: "Huge", ui: [{ type: "text", text: "x".repeat(30_000) }] } }]), SemanticError);
});

test("plain text and the outline keep the steps and the question, never the answer", () => {
  const doc = model([{ type: "interactive", view }]);
  const text = documentPlainText(doc);
  assert.match(text, /How Oracle runs a SELECT/);
  assert.match(text, /1\. FROM: Opens the table\./);
  assert.match(text, /Q1\. Which clause runs first\?/);
  assert.doesNotMatch(text, /FROM opens the table before anything else/);
  assert.match(outlineDocument(doc), /INTERACTIVE "How Oracle runs a SELECT"/);
  const { lines } = interactiveSummary(doc.blocks[0] as InteractiveBlock);
  assert.ok(lines.includes("   b) FROM"));
});

test("the .docx keeps a readable note of the view", async () => {
  const buffer = await exportDocumentDocx(model([{ type: "interactive", view }]));
  const xml = await (await JSZip.loadAsync(buffer)).file("word/document.xml")!.async("string");
  assert.match(xml, /How Oracle runs a SELECT/);
  assert.match(xml, /Which clause runs first\?/);
  assert.match(xml, /open this document in Alevr to use it/);
  assert.doesNotMatch(xml, /FROM opens the table before anything else/);
});

test("the model can insert an interactive block with an operation", () => {
  const doc = model([{ type: "paragraph", text: "Intro" }]);
  const { model: next } = applyDocumentOps(doc, [{ op: "insertBlock", after: doc.blocks[0].id, block: { type: "interactive", view } }]);
  assert.equal(next.blocks.at(-1)?.type, "interactive");
});
