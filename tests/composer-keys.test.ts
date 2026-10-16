import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enterIntent,
  enterKeyHintFor,
  isHardwareOnlyKey,
  onScreenKeyboard,
  returnSends,
  type ReturnContext,
} from "@/lib/composer-keys";
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

/* ——— G35: Return on an on-screen keyboard breaks the line ——————————————— */

const phone: ReturnContext = {
  sendKey: "enter",
  touchReturn: "newline",
  touchPrimary: true,
  hardwareKeyboardSeen: false,
  softKeyboardOpen: true,
};
const laptop: ReturnContext = { ...phone, touchPrimary: false, softKeyboardOpen: null };

test("on a phone's keyboard Return breaks the line and the button sends", () => {
  assert.equal(onScreenKeyboard(phone), true);
  assert.equal(returnSends(phone, false), false);
  assert.equal(enterKeyHintFor(phone), "enter");
  // Unmeasurable viewport and no physical key seen yet: still a phone.
  assert.equal(returnSends({ ...phone, softKeyboardOpen: null }, false), false);
});

test("a desktop keyboard keeps Return-to-send", () => {
  assert.equal(onScreenKeyboard(laptop), false);
  assert.equal(returnSends(laptop, false), true);
  assert.equal(enterKeyHintFor(laptop), "send");
});

test("a tablet with a keyboard attached sends once a physical key proves it", () => {
  const tablet = { ...phone, softKeyboardOpen: false, hardwareKeyboardSeen: true };
  assert.equal(onScreenKeyboard(tablet), false);
  assert.equal(returnSends(tablet, false), true);
  // Keyboard detached: the on-screen one is measurably up again, so Return breaks the line.
  assert.equal(returnSends({ ...tablet, softKeyboardOpen: true }, false), false);
});

test("Settings override both ways, and ⌘/Ctrl+Return always sends", () => {
  assert.equal(returnSends({ ...phone, touchReturn: "send" }, false), true);
  assert.equal(enterKeyHintFor({ ...phone, touchReturn: "send" }), "send");
  assert.equal(returnSends({ ...laptop, sendKey: "mod-enter" }, false), false);
  assert.equal(returnSends({ ...laptop, sendKey: "mod-enter" }, true), true);
  assert.equal(returnSends(phone, true), true);
  assert.equal(enterKeyHintFor({ ...laptop, sendKey: "mod-enter" }), "enter");
});

test("only keys an on-screen keyboard never sends count as a physical keyboard", () => {
  for (const key of ["Tab", "Escape", "ArrowUp", "ArrowLeft", "Home", "PageDown", "F5"]) {
    assert.equal(isHardwareOnlyKey({ key }), true, key);
  }
  assert.equal(isHardwareOnlyKey({ key: "k", metaKey: true }), true, "a ⌘ chord");
  assert.equal(isHardwareOnlyKey({ key: "c", ctrlKey: true }), true, "a Ctrl chord");
  for (const key of ["a", "Enter", "Backspace", "Shift", " ", "Unidentified", "Fn"]) {
    assert.equal(isHardwareOnlyKey({ key }), false, key);
  }
});

test("every composer asks the touch rule before Return sends", () => {
  assert.match(source("src/components/chat/composer.tsx"), /if \(!plainReturnSends\(e\)\) return;/);
  const field = source("src/components/chat/context-composer-field.tsx");
  assert.match(field, /!plainReturnSends\(event\)/);
  assert.match(field, /enterKeyHint=\{enterKeyHint\}/);
  assert.match(source("src/components/code/v2/composer.tsx"), /touchReturnBreaksLine\(e\)\) return;/);
  // The Code landing hosts the v2 composer (G58), which asks the rule above.
  assert.match(source("src/components/code/code-composer.tsx"), /<Composer[\s\S]*?variant="landing"/);
  assert.match(source("src/components/code/code-session-composer.tsx"), /!touchReturnBreaksLine\(e\)/);
  assert.match(source("src/components/work/composer/work-thread-composer.tsx"), /!touchReturnBreaksLine\(event\)/);
  // Orbit's two "describe an agent" composers and Compare's prompt box each
  // have a send button, so Return on a phone can break the line there too.
  const orbit = source("src/components/agents/agents-home.tsx");
  assert.equal(orbit.match(/!touchReturnBreaksLine\(event\)/g)?.length, 2);
  assert.match(source("src/components/compare/compare-view.tsx"), /!touchReturnBreaksLine\(e\)/);
});
