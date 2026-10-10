import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * ONE DOOR EACH (owner, 2026-10-10): on the home the tray under the composer
 * holds Select project, Apps and Skills, so the + menu leaves those rows out
 * there. Where the tray is not drawn the + menu keeps them, because it is
 * then their only door. The contract (shell-contract.test.ts) still sees all
 * three rows, as optional ones.
 */

const COMPOSER = readFileSync(new URL("../src/components/chat/composer.tsx", import.meta.url), "utf8");

function plusSections(): string {
  const start = COMPOSER.indexOf("const plusSections: PlusMenuSection[] = voiceActive");
  assert.ok(start > 0, "plusSections");
  return COMPOSER.slice(start, COMPOSER.indexOf("];\n\n", start));
}

test("the tray is the home's: landing frame, a new chat, not incognito, not in a call, not steering", () => {
  assert.match(
    COMPOSER,
    /const showTray = frame === "landing" && !conversationId && !privateMode && !voiceActive && !steerMode;/,
  );
  assert.match(COMPOSER, /const trayHasProject = showTray;/);
  assert.match(COMPOSER, /const trayHasAppsAndSkills = showTray && !mediaParams\.caps;/, "a generation tray keeps only Project");
});

test("the + menu leaves out Add to project, Apps and Run a skill only while the tray carries them", () => {
  const sections = plusSections();
  assert.match(sections, /\.\.\.\(!privateMode && !trayHasProject\s*\?\s*\[\s*\{\s*kind: "sub" as const,\s*id: "project"/);
  assert.match(sections, /\.\.\.\(showConnectors && !trayHasAppsAndSkills\s*\?\s*\[\s*\{\s*kind: "sub" as const,\s*id: "connectors"/);
  assert.match(sections, /\.\.\.\(skillRow && !trayHasAppsAndSkills \? \[skillRow\] : \[\]\)/);
});

test("everything else stays in the + menu", () => {
  const sections = plusSections();
  for (const id of ["files", "screenshot", "sketch", "library", "research", "search", "memory"]) {
    assert.match(sections, new RegExp(`id: "${id}"|${id}Row`), `${id} is still in the + menu`);
  }
  assert.match(sections, /mentionRow \? \[mentionRow\]/, "Mention stays");
});

test("the tray offers the same three panels the + menu would have", () => {
  const tray = COMPOSER.slice(COMPOSER.indexOf("<ComposerTray"), COMPOSER.indexOf("/>", COMPOSER.indexOf("<ComposerTray")));
  assert.match(tray, /projectPanel=\{projectPanel\}/);
  assert.match(tray, /appsPanel=\{showConnectors \? connectorsPanel : null\}/);
  assert.match(tray, /skillsPanel=\{skillRow \? skillsPanel : null\}/);
  // The tray draws Apps and Skills only outside a generation model's row.
  const traySource = readFileSync(new URL("../src/components/chat/composer-tray.tsx", import.meta.url), "utf8");
  const media = traySource.slice(traySource.indexOf("if (params) {"), traySource.indexOf('<div className="composer-tray" data-disabled'));
  assert.doesNotMatch(media, /panel="apps"|panel="skills"/);
  assert.match(media, /panel="project"/);
});
