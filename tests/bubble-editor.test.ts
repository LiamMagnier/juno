import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * THE BUBBLE EDITOR TAKES THE COMPOSER'S KEYS, IME GUARD INCLUDED.
 *
 * Editing a sent message happens in its bubble (message-item.tsx,
 * `BubbleEditor`), where Enter sends. An Enter that confirms an IME candidate
 * must not: `isComposing` catches it in Chrome and Firefox, but Safari fires
 * the confirming Enter after `compositionend`, so there only keyCode 229 says
 * the key belonged to the IME. The editor shipped with the first check alone,
 * which re-sent a Japanese or Chinese edit on Safari the moment its first
 * word was converted. Pinned beside the composer's own guard so the two
 * cannot drift apart again.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const item = read("../src/components/chat/message-item.tsx");
const composer = read("../src/components/chat/composer.tsx");

const IME_GUARD = /e\.nativeEvent\.isComposing \|\| e\.nativeEvent\.keyCode === 229/;

test("the composer guards Enter against both IME signals", () => {
  assert.match(composer, IME_GUARD);
});

test("the bubble editor guards Enter against both IME signals before it sends", () => {
  const editor = /function BubbleEditor\([\s\S]*?\n\}\n/.exec(item)?.[0] ?? "";
  assert.ok(editor, "message-item.tsx defines BubbleEditor");
  const keyDown = /onKeyDown=\{\(e\) => \{([\s\S]*?)\n\s*\}\}/.exec(editor)?.[1] ?? "";
  assert.match(keyDown, IME_GUARD, "the editor's keydown returns early for an IME key");
  assert.ok(
    keyDown.search(IME_GUARD) < keyDown.indexOf('e.key === "Enter"'),
    "the guard runs before Enter is read as a send"
  );
});

test("closing the editor from the keyboard hands focus back", () => {
  // The editor holds focus while open; unmounting it drops focus on <body>.
  assert.match(item, /restoreFocusRef\.current = document\.activeElement\?\.matches\(":focus-visible"\)/);
  assert.match(item, /editOpenerRef\.current = focusedOpener\(\);/);
  assert.match(item, /buttonRef=\{editButtonRef\}/);
});
