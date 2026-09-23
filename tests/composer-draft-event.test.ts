import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * The composer and the starter chips talk through two window events and share
 * no import for either name, so a rename on one side fails silently: the chips
 * would sit under a seeded draft, or a seed would land nowhere. Pinned here on
 * both sources so the names cannot drift apart.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const composer = read("../src/components/chat/composer.tsx");
const chips = read("../src/components/chat/starter-chips.tsx");

test("the composer announces its draft's emptiness under the name the chips listen for", () => {
  assert.match(
    composer,
    /window\.dispatchEvent\(new CustomEvent\("juno:composer-draft", \{ detail: \{ empty: draftEmpty \} \}\)\);/
  );
  // Once per flip, not per keystroke.
  assert.match(composer, /\}, \[draftEmpty\]\);/);
  assert.match(chips, /window\.addEventListener\("juno:composer-draft", onDraft\);/);
});

test("the chips seed the composer through the event it listens for", () => {
  assert.match(composer, /window\.addEventListener\("juno:composer-seed", seed\);/);
  assert.match(chips, /"juno:composer-seed"/);
});

test("the composer's drop target is the depth-counted hook, not an enter/leave boolean", () => {
  assert.match(composer, /useFileDrop\(\{\s*onFiles: addComposerFiles,\s*enabled: features\.storage && !privateMode,\s*\}\)/);
  assert.doesNotMatch(composer, /setDragging/);
});
