import test from "node:test";
import assert from "node:assert/strict";
import { readEditor, type EditorNodeLike } from "@/components/chat/context-editor-dom";
import { contextRangeIssues } from "@/lib/chat/context-tokens";

/*
 * The context field's one serialization (src/components/chat/context-editor-dom.ts):
 * the text a selection offset counts, the text the request sends and the
 * ranges its tokens carry all come from `readEditor`. Exercised here on plain
 * node trees, the same shapes the browser hands it (the field, and a copied
 * selection's fragment).
 */

const text = (value: string): EditorNodeLike => ({ nodeType: 3, textContent: value, childNodes: [] });
const element = (tagName: string, children: EditorNodeLike[], dataset?: { contextToken?: string }): EditorNodeLike => ({
  nodeType: 1,
  tagName,
  textContent: children.map((child) => child.textContent ?? "").join(""),
  childNodes: children,
  dataset: dataset ?? {},
});
const token = (data: object, label: string) =>
  element("SPAN", [element("SPAN", []), text(label)], { contextToken: JSON.stringify(data) });

const GITHUB = { kind: "app", id: "github", label: "GitHub", meta: { icon: "app:github" } };
const SHEET = { kind: "file", id: "cm000000000000000000000002", label: "Q3 Forecast.xlsx", meta: { icon: "file:sheet" } };

test("text and tokens read as one sentence with UTF-16 ranges that frame each label", () => {
  const root = element("DIV", [text("Compare "), token(SHEET, "Q3 Forecast.xlsx"), text(" with "), token(GITHUB, "GitHub"), text(" 👍")]);
  const read = readEditor(root);
  assert.equal(read.text, "Compare Q3 Forecast.xlsx with GitHub 👍");
  assert.deepEqual(
    read.tokens.map((t) => ({ label: t.label, range: t.range, icon: t.meta?.icon })),
    [
      { label: "Q3 Forecast.xlsx", range: { start: 8, end: 24 }, icon: "file:sheet" },
      { label: "GitHub", range: { start: 30, end: 36 }, icon: "app:github" },
    ],
  );
  assert.deepEqual(contextRangeIssues(read.text, read.tokens), []);
});

test("a token's mark slot adds nothing to the text, whatever React drew in it", () => {
  const drawn = element("SPAN", [element("SPAN", [text("svg-title")]), text("GitHub")], { contextToken: JSON.stringify(GITHUB) });
  assert.equal(readEditor(element("DIV", [text("on "), drawn])).text, "on GitHub");
});

test("line breaks and block lines read as newlines", () => {
  const root = element("DIV", [text("first"), element("BR", []), text("second"), element("DIV", [text("third")])]);
  assert.equal(readEditor(root).text, "first\nsecond\nthird");
});

test("a copied selection (a fragment) serializes the same way", () => {
  const fragment: EditorNodeLike = { nodeType: 11, textContent: null, childNodes: [token(GITHUB, "GitHub"), text(" issues")] };
  const read = readEditor(fragment);
  assert.equal(read.text, "GitHub issues");
  assert.deepEqual(read.tokens[0].range, { start: 0, end: 6 });
});

test("a token whose data does not parse reads as its plain words", () => {
  const broken = element("SPAN", [text("GitHub")], { contextToken: "{not json" });
  const read = readEditor(element("DIV", [text("see "), broken]));
  assert.equal(read.text, "see GitHub");
  assert.deepEqual(read.tokens, []);
});
