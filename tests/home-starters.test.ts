import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  HOME_STARTER_COPY,
  MAX_STARTER_CHIPS,
  STARTER_ACTION,
  STARTER_ORDER,
  codeHandoffHref,
  parsePicks,
  promptText,
  promptsFor,
  rankStarters,
  recentUse,
  recordPick,
  type ConversationSignal,
} from "@/lib/home-starters";
import { parseCodePrefill } from "@/lib/code-prefill";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const ALL = { research: true, image: true, code: true };
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-15T12:00:00Z");

/*
 * G34: starter prompts and capability chips on the home screen, ordered by
 * what this person actually uses, prefilling the composer and never sending.
 */

test("a new account sees the fixed order, one row of five", () => {
  assert.deepEqual(rankStarters(ALL), ["write", "research", "image", "code", "plan"]);
  assert.equal(rankStarters(ALL).length, MAX_STARTER_CHIPS);
});

test("a chip for something this account cannot use is not drawn", () => {
  assert.deepEqual(rankStarters({ research: false, image: false, code: false }), ["write", "plan", "learn"]);
  assert.deepEqual(rankStarters({ research: true, image: false, code: false }), ["write", "research", "plan", "learn"]);
});

test("recent use reorders the chips, and a pick on this device counts most", () => {
  const coder = rankStarters(ALL, { recent: { code: 4 }, picks: {} });
  assert.equal(coder[0], "code");
  const picked = rankStarters(ALL, { recent: { code: 2 }, picks: { learn: 1 } });
  assert.deepEqual(picked.slice(0, 2), ["learn", "code"], "one pick (x3) outranks two sessions");
  assert.ok(picked.includes("learn"), "a picked chip earns its way into the row of five");
});

test("recent use reads the last month of the person's own conversations", () => {
  const conversations: ConversationSignal[] = [
    { kind: "code", model: "x", lastMessageAt: new Date(NOW - 1 * DAY).toISOString(), codeWorkspaceName: "atlas-web" },
    { kind: "code", model: "x", lastMessageAt: new Date(NOW - 3 * DAY).toISOString(), codeWorkspaceName: "older-repo" },
    { kind: "chat", model: "img-1", lastMessageAt: new Date(NOW - 2 * DAY).toISOString() },
    { kind: "chat", model: "vid-1", lastMessageAt: new Date(NOW - 2 * DAY).toISOString() },
    { kind: "chat", model: "chat-1", lastMessageAt: new Date(NOW - 2 * DAY).toISOString() },
    { kind: "code", model: "x", lastMessageAt: new Date(NOW - 45 * DAY).toISOString(), codeWorkspaceName: "ancient" },
    { kind: "code", model: "x", lastMessageAt: new Date(NOW - 1 * DAY).toISOString(), archivedAt: new Date(NOW).toISOString() },
  ];
  const modality = (id: string) => (id.startsWith("img") ? "image" : id.startsWith("vid") ? "video" : "chat");
  const use = recentUse(conversations, modality, NOW);
  assert.deepEqual(use.recent, { code: 2, image: 2 });
  assert.equal(use.lastCodeProject, "atlas-web", "the newest Code project, by name");
  assert.equal(use.lastImageModel, "img-1", "a video model is not an image model");
});

test("picks remembered on this device are cleaned and forget after two months", () => {
  const once = recordPick(null, "write", NOW);
  const twice = recordPick(once, "write", NOW + 1000);
  assert.deepEqual(parsePicks(twice, NOW + 2000), { write: 2 });
  assert.deepEqual(parsePicks(twice, NOW + 61 * DAY), {}, "stale picks no longer reorder anything");
  assert.deepEqual(parsePicks("not json"), {});
  assert.deepEqual(parsePicks(JSON.stringify({ write: { n: "x", at: NOW }, rogue: { n: 9, at: NOW } }), NOW), {});
});

test("the Code chip offers to pick up the last project, by its own name", () => {
  const prompts = promptsFor("code", { lastCodeProject: "atlas-web" });
  assert.equal(prompts[0].phrase, HOME_STARTER_COPY.continueIn);
  assert.equal(prompts[0].argument, "atlas-web");
  assert.equal(promptText(prompts[0]), "Pick up where I left off in atlas-web");
  assert.equal(promptText(prompts[0], "Reprendre là où je me suis arrêté dans"), "Reprendre là où je me suis arrêté dans atlas-web");
  assert.equal(promptsFor("code", { lastCodeProject: null })[0].argument, undefined);
});

test("Code opens prefilled and waits; every other chip prefills the chat composer", () => {
  const href = codeHandoffHref("Fix the failing tests & ship");
  const query = Object.fromEntries(new URL(href, "https://alevr.test").searchParams);
  assert.equal(parseCodePrefill(query).prompt, "Fix the failing tests & ship");
  assert.equal(STARTER_ACTION.code, "code");
  assert.equal(STARTER_ACTION.research, "research");
  assert.equal(STARTER_ACTION.image, "image");
  for (const id of ["write", "plan", "learn"] as const) assert.equal(STARTER_ACTION[id], "seed");
});

test("the copy is plain, sentence-case English and never names the codename", () => {
  for (const id of STARTER_ORDER) {
    const chip = HOME_STARTER_COPY.chips[id];
    assert.match(chip.label, /^[A-Z][a-z]+(?: [a-z]+)*$/, `${id} label is sentence case`);
    assert.ok(chip.prompts.length >= 3, `${id} offers a few prompts`);
    for (const prompt of chip.prompts) {
      assert.match(prompt, /^[A-Z]/, prompt);
      assert.doesNotMatch(prompt, /\bJuno\b/, prompt);
      assert.ok(prompt.length <= 90, `"${prompt}" fits a phone row`);
    }
  }
});

test("the home draws the starters and calms its field while they show", () => {
  const view = read("src/components/chat/chat-view.tsx");
  assert.match(view, /<HomeStarters\s+composerRef=\{emptyComposerRef\}/);
  assert.match(view, /calm=\{startersShown\}/);
  const field = read("src/components/chat/empty-state.tsx");
  assert.match(field, /lamp=\{!calm\}/, "the pointer stops lighting the dots under the chips");
  const starters = read("src/components/chat/home-starters.tsx");
  assert.match(starters, /new CustomEvent\("juno:composer-seed"/, "a pick goes through the composer's own seed door");
  assert.doesNotMatch(starters, /submit\(|sendFromComposer/, "a starter never sends");
});

test("the composer takes the model a starter names, only from this account's list", () => {
  const composer = read("src/components/chat/composer.tsx");
  assert.match(composer, /current\.models\.some\(\(m\) => m\.id === wanted\)/);
  assert.match(composer, /wantedModality === "chat" && current\.modality !== "chat"/);
});
