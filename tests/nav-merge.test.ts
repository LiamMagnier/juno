import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildSandboxDoc } from "@/components/canvas/sandbox-frame";
import { designCardFace } from "@/components/chat/artifact-inline-card";
import { readSession } from "@/components/chat/session-outputs";
import type { ClientArtifact } from "@/types/chat";

/*
 * DESIGN IS A TYPE, NOT A PLACE (docs/design/artifacts-design/04-MERGE-PLAN.md
 * §1.1, §4.1, §4.6).
 *
 * What the chat shell owes the merge at First light, held in one place:
 *
 *   - the sidebar has no Design door: Chat's destinations are Projects,
 *     Library and Customize (shell contract v2; Artifacts live inside
 *     Library), on the panel and the rail alike (they are one list, drawn
 *     twice);
 *   - ⌘K still answers the word "design", and every design row lands on
 *     Artifacts filtered to designs, never on the retired `/design` page;
 *   - no word keys two destinations, which is how "canvas" used to offer two
 *     answers to one thought (L34);
 *   - a design is a picture wherever the chat shows it — the inline card, the
 *     Outputs tiles and any sandbox preview — and its JSON is not (X-20).
 */

const SIDEBAR = readFileSync(new URL("../src/components/app/app-sidebar.tsx", import.meta.url), "utf8");
const PALETTE = readFileSync(new URL("../src/components/app/command-palette.tsx", import.meta.url), "utf8");

/** Source with comments removed, so an assertion about code cannot pass or
 *  fail on the prose explaining it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("Chat's destinations are Projects, Library and Customize, with no Design row", () => {
  const sidebar = withoutComments(SIDEBAR);
  // The Chat list is the second array in the `isCode ? [...] : [...]` choice,
  // after Code's; read it from its first row to its close.
  const start = sidebar.indexOf('{ href: "/projects"');
  assert.ok(start >= 0, "the Chat list starts with Projects");
  const chat = sidebar.slice(start, sidebar.indexOf("] as const)", start));
  const hrefs = [...chat.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
  // The shell contract's Chat destinations, in its order (v2: Artifacts are a
  // view of Library, agents are a section of the list, not a door).
  assert.deepEqual(hrefs, ["/projects", "/library", "/customize"]);
  // Library stays lit on /artifacts, so a design opened from it keeps its place.
  assert.match(chat, /label: "Library", active: pathname === "\/library" \|\| pathname === "\/artifacts"/);

  // Nowhere else in the column either: not a pinned row, not the rail.
  assert.ok(!sidebar.includes('"/design"'), "no sidebar row links to /design");
  assert.ok(!/label: "Design"/.test(sidebar), "no row is labelled Design");
});

type PaletteRow = { id: string; label: string; keywords: string; href: string };

/** The palette's one-line navigation rows, as data. */
function paletteRows(): PaletteRow[] {
  const source = withoutComments(PALETTE);
  const rows: PaletteRow[] = [];
  const pattern = /\{ id: "([^"]+)", group: "[^"]+", label: "([^"]+)",[^\n]*?keywords: "([^"]*)",[^\n]*?go\("([^"]+)"\)/g;
  for (const m of source.matchAll(pattern)) rows.push({ id: m[1], label: m[2], keywords: m[3], href: m[4] });
  return rows;
}

/** The palette's own rule: a query matches at the start of a word. */
function atWordStart(hay: string, needle: string): boolean {
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (i === 0 || !/[a-z0-9]/.test(hay[i - 1])) return true;
  }
  return false;
}

test("⌘K sends every design row to Artifacts, and New design opens its presets", () => {
  const rows = paletteRows();
  assert.ok(rows.length >= 10, `the row pattern still reads the palette (${rows.length} rows)`);
  assert.ok(!rows.some((r) => r.href === "/design" || r.href.startsWith("/design/")), "nothing goes to the Design page");

  const byLabel = new Map(rows.map((r) => [r.label, r]));
  assert.equal(byLabel.get("New design")?.href, "/artifacts?type=DESIGN&new=design");
  assert.equal(byLabel.get("Open Designs")?.href, "/artifacts?type=DESIGN");
  assert.equal(byLabel.get("Open Artifacts")?.href, "/artifacts");

  // "Design" is still a word that finds designs: typing it offers the list
  // and the way to make one, and nothing that leads anywhere else.
  const found = rows.filter((r) => atWordStart(r.label.toLowerCase(), "design") || atWordStart(r.keywords, "design"));
  assert.ok(found.length > 0, "typing design finds something");
  for (const r of found) assert.match(r.href, /^\/artifacts\?type=DESIGN/, `${r.label} leads to designs`);
});

test("no word keys two of the design and artifact destinations", () => {
  const rows = paletteRows();
  const canvas = rows.filter((r) => atWordStart(r.keywords, "canvas"));
  assert.deepEqual(
    canvas.map((r) => r.label),
    ["Open Designs"],
    "canvas finds one place (L34)"
  );

  // Matching is at word starts, so two rows collide when either's word BEGINS
  // the other's — "frame" and "frames" — not only when they are equal.
  const merged = rows.filter((r) => r.href.startsWith("/artifacts"));
  assert.equal(merged.length, 3, "New design, Open Designs and Open Artifacts");
  for (const a of merged) {
    for (const word of a.keywords.split(/\s+/).filter(Boolean)) {
      for (const b of rows) {
        if (b === a) continue;
        assert.ok(
          !atWordStart(b.keywords, word) && !atWordStart(b.label.toLowerCase(), word),
          `"${word}" keys ${a.label} and also finds ${b.label}`
        );
      }
    }
  }
});

test("a design card shows its glyph while it is written and its poster once it is a row", () => {
  // Still being written: the glyph, even when the row exists — an update's
  // row still holds the version being replaced.
  assert.equal(designCardFace({ streaming: true, hasContent: true }), "making");
  assert.equal(designCardFace({ streaming: true, artifactId: "a1", hasContent: true }), "making");
  // A row: its picture, whatever the source says.
  assert.equal(designCardFace({ artifactId: "a1", hasContent: true }), "poster");
  assert.equal(designCardFace({ artifactId: "a1", hasContent: false }), "poster");
  // Closed but not yet (or never) a row: an honest line, not a picture of nothing.
  assert.equal(designCardFace({ artifactId: null, hasContent: true }), "unsaved");
  // Nothing at all: the failure every card shows.
  assert.equal(designCardFace({ hasContent: false }), "missing");
});

function artifact(over: Partial<ClientArtifact>): ClientArtifact {
  return {
    id: "art_1",
    identifier: "thing",
    type: "HTML",
    title: "Thing",
    currentVersion: 1,
    content: "<h1>hi</h1>",
    versions: [],
    messageId: "m1",
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T10:00:00.000Z",
    ...over,
  };
}

test("a design's Outputs tile is its poster, pinned to its version, and never its source", () => {
  const json = JSON.stringify({ version: 2, pages: [{ id: "p1", frames: [] }] });
  const { outputs } = readSession(
    [
      artifact({ id: "art_design", identifier: "screen", type: "DESIGN", title: "Sign-in", content: json, currentVersion: 4 }),
      artifact({ id: "art_page", identifier: "page", type: "HTML", updatedAt: "2026-09-24T09:00:00.000Z" }),
    ],
    []
  );
  const design = outputs.find((o) => o.id === "art_design");
  assert.ok(design);
  assert.deepEqual(design.poster, { artifactId: "art_design", version: 4 });
  assert.equal(design.preview, null, "the JSON is not handed to the tile as a fallback");

  const page = outputs.find((o) => o.id === "art_page");
  assert.ok(page);
  assert.equal(page.poster, undefined, "only a design has a poster");
  assert.equal(page.preview, "<h1>hi</h1>");
});

test("a sandbox asked to preview a design says so instead of printing it", () => {
  const json = JSON.stringify({ version: 2, pages: [{ id: "p1", name: "SECRET-LAYER-NAME" }] });
  const html = buildSandboxDoc("DESIGN", json);
  assert.ok(!html.includes("SECRET-LAYER-NAME"), "the document's JSON is not in the frame");
  assert.ok(!html.includes("<pre"), "no source block");
  // No script at all, so no status bridge: nothing beside the frame can
  // report the design as "Live" when nothing ran.
  assert.ok(!/<script/i.test(html), "the placeholder runs nothing");
  assert.match(html, /Content-Security-Policy/, "it still carries the frame's policy");
  assert.match(html, /Open the design to see it/);

  // The component draws a saved design's poster without an iframe at all.
  const frame = withoutComments(readFileSync(new URL("../src/components/canvas/sandbox-frame.tsx", import.meta.url), "utf8"));
  assert.match(
    frame,
    /if \(type === "DESIGN" && artifactId\) \{\s*return <DesignPosterFrame artifactId=\{artifactId\} version=\{version\}/
  );
  assert.match(frame, /const src = designPosterUrl\(artifactId, version\);/);
  assert.match(frame, /<img\s+src=\{src\}[^>]*loading="lazy"\s+decoding="async"/);
});
