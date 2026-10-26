import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isEmptiedEditor } from "@/components/chat/context-editor-empty";
import type { EditorNodeLike } from "@/components/chat/context-editor-dom";

/*
 * The composer's placeholder returns once the field is emptied
 * (src/components/chat/context-editor-empty.ts). Chromium leaves a lone <br>
 * in a contenteditable whose last character was deleted; `readEditor` reads
 * it as "\n", so the field reported a value, `data-empty` never came back and
 * "How can I help you today?" stayed gone. Exercised on the node shapes the
 * browser leaves, as context-editor-dom.test.ts does.
 */

const text = (value: string): EditorNodeLike => ({ nodeType: 3, textContent: value, childNodes: [] });
const element = (tagName: string, children: EditorNodeLike[], dataset?: { contextToken?: string }): EditorNodeLike => ({
  nodeType: 1,
  tagName,
  textContent: children.map((child) => child.textContent ?? "").join(""),
  childNodes: children,
  dataset: dataset ?? {},
});
const br = () => element("BR", []);
const field = (...children: EditorNodeLike[]) => element("DIV", children);
const GITHUB = { kind: "app", id: "github", label: "GitHub", meta: { icon: "app:github" } };
const token = () => element("SPAN", [element("SPAN", []), text("GitHub")], { contextToken: JSON.stringify(GITHUB) });

test("what Backspace, select-all + Delete or a cut leave behind is an emptied field", () => {
  assert.equal(isEmptiedEditor(field(br())), true, "a lone <br> (typed 'hello', then 5 × Backspace)");
  assert.equal(isEmptiedEditor(field(element("DIV", [br()]))), true, "a <div><br></div>");
  assert.equal(isEmptiedEditor(field(text(""))), true, "an empty text node");
  assert.equal(isEmptiedEditor(field(text(""), br())), true, "an empty text node and the <br>");
});

test("a field with nothing in it is already empty: nothing to clear", () => {
  assert.equal(isEmptiedEditor(field()), false);
});

test("anything a person wrote is kept", () => {
  assert.equal(isEmptiedEditor(field(text("h"))), false, "one character");
  assert.equal(isEmptiedEditor(field(text(" "))), false, "a space is a draft");
  assert.equal(isEmptiedEditor(field(br(), br())), false, "Shift+Enter in an empty field: the break and the browser's placeholder <br>");
  assert.equal(
    isEmptiedEditor(field(element("DIV", [br()]), element("DIV", [br()]))),
    false,
    "Shift+Enter as Chromium writes it in this field: two lines",
  );
  assert.equal(isEmptiedEditor(field(token())), false, "a context token alone");
  assert.equal(isEmptiedEditor(field(token(), br())), false, "a token and a trailing <br>");
});

test("the field clears through the helper on every input", () => {
  const source = readFileSync(new URL("../src/components/chat/context-composer-field.tsx", import.meta.url), "utf8");
  const publish = source.slice(source.indexOf("const publish = React.useCallback"), source.indexOf("const writeDraft"));
  assert.match(publish, /if \(isEmptiedEditor\(root\)\) \{\s*root\.replaceChildren\(\);\s*result = \{ text: "", tokens: \[\] \};/);
  assert.doesNotMatch(publish, /if \(!result\.text && root\.childNodes\.length\)/, "the old guard missed the <br>, read as \"\\n\"");
  // `data-empty` is drawn from the published value, so the placeholder follows.
  assert.match(source, /data-empty=\{value === "" \? "" : undefined\}/);
});
