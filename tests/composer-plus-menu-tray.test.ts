import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * ONE DOOR (owner, 6 Nov 2026: "rework the composer from zero"). The tray
 * under the home composer is gone: Project, Apps and Skills are the + menu's
 * last group on every surface, and the rows say what they bring in two or
 * three words. The contract (shell-contract.test.ts) holds the labels.
 */

const COMPOSER = readFileSync(new URL("../src/components/chat/composer.tsx", import.meta.url), "utf8");

function plusSections(): string {
  const start = COMPOSER.indexOf("const plusSections: PlusMenuSection[] = voiceActive");
  assert.ok(start > 0, "plusSections");
  return COMPOSER.slice(start, COMPOSER.indexOf("];\n\n", start));
}

test("the composer draws no tray of its own any more", () => {
  assert.doesNotMatch(COMPOSER, /<ComposerTray\b/);
  assert.doesNotMatch(COMPOSER, /showTray|trayHasProject|trayHasAppsAndSkills/);
  // The generation row (image, video, music models) keeps its shelf.
  assert.match(COMPOSER, /\{mediaParams\.caps && !voiceActive && !steerMode && \(/);
});

test("Project, Apps and Skills close the + menu, in that order", () => {
  const sections = plusSections();
  const last = sections.slice(sections.lastIndexOf("// Where this chat sits and what it can reach."));
  const project = last.indexOf('id: "project"');
  const apps = last.indexOf('id: "connectors"');
  const skills = last.indexOf("skillRow ? [skillRow] : []");
  assert.ok(project > 0 && apps > project && skills > apps, "project, then apps, then skills");
});

test("everything else stays in the + menu, and the @ row is the palette's alone", () => {
  const sections = plusSections();
  for (const id of ["files", "screenshot", "sketch", "library", "research", "search", "memory"]) {
    assert.match(sections, new RegExp(`id: "${id}"|${id}Row`), `${id} is still in the + menu`);
  }
  assert.doesNotMatch(COMPOSER, /mentionRow/);
});

test("Google Drive / OneDrive are drawn only while that drive is connected and CLOUD_ATTACH_ENABLED is on", () => {
  const sections = plusSections();
  // Off (the default), neither row is drawn whatever is connected.
  assert.match(COMPOSER, /const cloudAttachOn = features\.cloudAttach === true;/);
  assert.match(COMPOSER, /const driveConnected = cloudAttachOn && connectors\.some\(\(connector\) => connector\.id === "google-drive"\);/);
  assert.match(COMPOSER, /const oneDriveConnected = cloudAttachOn && connectors\.some\(\(connector\) => connector\.id === "microsoft-365"\);/);
  assert.match(sections, /\.\.\.\(driveConnected\s*\?\s*\[\s*\{\s*kind: "action" as const,\s*id: "google-drive"/);
  assert.match(sections, /\.\.\.\(oneDriveConnected\s*\?\s*\[\s*\{\s*kind: "action" as const,\s*id: "onedrive"/);
  // One picker, told which drive; it files the import in this chat, like an upload.
  const start = COMPOSER.indexOf("<CloudFilePicker");
  const picker = COMPOSER.slice(start, COMPOSER.indexOf("/>", start));
  assert.match(picker, /provider=\{cloudPicker\.provider\}/);
  assert.match(picker, /onAttach=\{addComposerAttachments\}/);
  assert.match(picker, /existingCount=\{uploads\.length\}/);
  assert.match(picker, /conversationId=\{conversationId\}/);
});
