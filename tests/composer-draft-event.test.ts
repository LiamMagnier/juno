import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * The composer and the surfaces that hand it a draft (a message's "Edit in
 * composer", the skills menu's "Create a skill", chat-view's own seeds) talk
 * through one window event and share no import for its name, so a rename on
 * one side fails silently: a seed would land nowhere. Pinned on both sides.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const composer = read("../src/components/chat/composer.tsx");
const skills = read("../src/components/skills/add-skill-menu.tsx");

test("surfaces seed the composer through the event it listens for", () => {
  assert.match(composer, /window\.addEventListener\("juno:composer-seed", seed\);/);
  assert.match(skills, /new CustomEvent\("juno:composer-seed"/);
});

test("the composer's drop target is the depth-counted hook, not an enter/leave boolean", () => {
  assert.match(composer, /useFileDrop\(\{\s*onFiles: addComposerFiles,\s*enabled: features\.storage && !privateMode,\s*\}\)/);
  assert.doesNotMatch(composer, /setDragging/);
});
