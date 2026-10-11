import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enterIntent } from "@/lib/composer-keys";
import { composerKeyIntent } from "@/lib/code-v2/composer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

test("Enter sends; Shift+Enter and Option+Enter break the line", () => {
  assert.equal(enterIntent({ key: "Enter" }), "send");
  assert.equal(enterIntent({ key: "Enter", shiftKey: true }), "newline");
  assert.equal(enterIntent({ key: "Enter", altKey: true }), "newline");
  assert.equal(enterIntent({ key: "a" }), null);
});

test("an input method's Enter confirms its text and never sends", () => {
  assert.equal(enterIntent({ key: "Enter", isComposing: true }), "ime");
  // Safari: the confirming keydown arrives after compositionend.
  assert.equal(enterIntent({ key: "Enter", isComposing: false, keyCode: 229 }), "ime");
  assert.equal(enterIntent({ key: "Enter", shiftKey: true, isComposing: true }), "ime");
});

test("Code's composer follows the same rule", () => {
  const idle = { running: false, hasDraft: true, canSteer: true, canQueue: true };
  assert.equal(composerKeyIntent({ key: "Enter", alt: true }, idle), "newline");
  assert.equal(composerKeyIntent({ key: "Enter", shift: true }, idle), "newline");
  assert.equal(composerKeyIntent({ key: "Enter" }, idle), "send");
  assert.equal(composerKeyIntent({ key: "Enter" }, { ...idle, composing: true }), null);
});

test("Chat and Code composers read the shared rule", () => {
  assert.match(source("src/components/chat/context-composer-field.tsx"), /enterIntent\(enterKeyOf\(event\)\) === "newline"/);
  assert.match(source("src/components/chat/composer.tsx"), /enterIntent\(enterKeyOf\(e\)\) === "send"/);
  const code = source("src/components/code/v2/composer.tsx");
  assert.match(code, /keyCode === 229/);
  assert.match(code, /intent === "newline" && e\.altKey/);
});
