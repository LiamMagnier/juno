import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * Project, Apps and Skills are the + menu's last group on every surface, and
 * the rows say what they bring in two or three words (the contract,
 * shell-contract.test.ts, holds the labels). On the home the tray under the
 * composer carries the same three as a shortcut (owner, 7 Nov 2026).
 */

const COMPOSER = readFileSync(new URL("../src/components/chat/composer.tsx", import.meta.url), "utf8");

function plusSections(): string {
  const start = COMPOSER.indexOf("const plusSections: PlusMenuSection[] = voiceActive");
  assert.ok(start > 0, "plusSections");
  return COMPOSER.slice(start, COMPOSER.indexOf("];\n\n", start));
}

test("the tray is back on the home only: landing frame, a new chat, not incognito, not in a call, not steering", () => {
  // Owner, 7 Nov 2026: bring back Project, Apps, Skills and the Mac app under the composer.
  assert.match(
    COMPOSER,
    /const showTray = frame === "landing" && !conversationId && !privateMode && !voiceActive && !steerMode;/,
  );
  // The + menu stays complete: the tray is a shortcut, not the only door.
  assert.doesNotMatch(COMPOSER, /trayHasProject|trayHasAppsAndSkills/);
  // In a thread the generation row keeps its own shelf.
  assert.match(COMPOSER, /\{!showTray && mediaParams\.caps && !voiceActive && !steerMode && \(/);
});

test("the tray offers the same three panels the + menu does, in one capsule", () => {
  const tray = COMPOSER.slice(COMPOSER.indexOf("<ComposerTray"), COMPOSER.indexOf("/>", COMPOSER.indexOf("<ComposerTray")));
  assert.match(tray, /projectPanel=\{projectPanel\}/);
  assert.match(tray, /appsPanel=\{showConnectors \? connectorsPanel : null\}/);
  assert.match(tray, /skillsPanel=\{skillRow \? skillsPanel : null\}/);
  const traySource = readFileSync(new URL("../src/components/chat/composer-tray.tsx", import.meta.url), "utf8");
  const dock = traySource.slice(traySource.indexOf('<div className="composer-tray composer-tray--dock"'));
  const capsule = dock.slice(dock.indexOf('className="composer-tray__capsule"'), dock.indexOf("macApp.visible"));
  for (const panel of ["project", "apps", "skills"]) assert.match(capsule, new RegExp(`panel="${panel}"`));
});

test("Project and Apps open on a search box", () => {
  assert.match(COMPOSER, /<MenuSearch value=\{projectQuery\} onChange=\{setProjectQuery\} placeholder="Search projects"/);
  assert.match(COMPOSER, /<MenuSearch value=\{connectorQuery\} onChange=\{setConnectorQuery\} placeholder="Search apps"/);
  assert.doesNotMatch(COMPOSER, /connectors\.length > 5 \? \(\s*<MenuSearch/, "the apps search is not gated on a length any more");
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
