import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { insertSorted, matchesView, type LibraryItem } from "@/components/library/library-types";
import { quickListModels, QUICK_LIST_MAX } from "@/lib/model-picker";
import { MODELS, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID } from "@/lib/auto-model";

const ROUTE = readFileSync(new URL("../src/app/api/library/route.ts", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../src/app/(app)/library/page.tsx", import.meta.url), "utf8");

/*
 * The Library's search, filter and sort run on the server, and the page puts
 * rows back (Undo, a finished upload) with the client's copy of the same
 * ordering. These pin the two halves to each other, and the model menu's
 * short list to the rules its comment states.
 */

function item(id: string, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    kind: "FILE",
    fileName: `${id}.pdf`,
    mimeType: "application/pdf",
    size: 1000,
    url: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    conversationId: null,
    version: 1,
    versionCount: 0,
    origin: "upload",
    parserState: "ready",
    parserVersion: null,
    deletedAt: null,
    knowledge: null,
    ...patch,
  };
}

test("the library route searches, filters and sorts in the database", () => {
  assert.match(ROUTE, /fileName: \{ contains: q, mode: "insensitive" \}/);
  for (const sort of ["newest", "oldest", "name", "size"]) {
    assert.match(ROUTE, new RegExp(`${sort}: \\[`), `the route orders by ${sort}`);
  }
  // Counts and the storage figure are for the whole result, not the page.
  assert.match(ROUTE, /groupBy\(\{ by: \["kind"\]/);
  assert.match(ROUTE, /storage: \{ usedBytes, quotaBytes/);
});

test("the library page keeps the e2e contract: an h1 that says files", () => {
  assert.match(PAGE, /heading=\{deletedView \? "Recently deleted" : "Files"\}/);
});

test("a row put back lands in sort order without reordering the rows around it", () => {
  const list = [
    item("c", { createdAt: "2026-09-03T00:00:00.000Z" }),
    item("a", { createdAt: "2026-09-01T00:00:00.000Z" }),
  ];
  const back = item("b", { createdAt: "2026-09-02T00:00:00.000Z" });
  assert.deepEqual(
    insertSorted(list, [back], "newest").map((row) => row.id),
    ["c", "b", "a"],
  );
  // Already present: replaced, never duplicated.
  assert.equal(insertSorted(list, [list[0]], "newest").length, 2);
});

test("a row that sorts past a partial list waits for its own page", () => {
  const list = [item("new", { createdAt: "2026-09-05T00:00:00.000Z" })];
  const old = item("old", { createdAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(insertSorted(list, [old], "newest", true).map((row) => row.id), ["new"]);
  assert.deepEqual(insertSorted(list, [old], "newest", false).map((row) => row.id), ["new", "old"]);
});

test("the client's view test mirrors the route's where", () => {
  const photo = item("p", { kind: "IMAGE", fileName: "Holiday.PNG" });
  assert.equal(matchesView(photo, { q: "holi", kind: "all" }), true);
  assert.equal(matchesView(photo, { q: "holi", kind: "FILE" }), false);
  assert.equal(matchesView(photo, { q: "report", kind: "all" }), false);
});

const model = (id: string, patch: Partial<ModelInfo> = {}): ModelInfo => ({ ...MODELS[id], ...patch });
const opus = model("anthropic:claude-opus-5-5");
const sonnet = model("anthropic:claude-sonnet-5");
const sol = model("openai:gpt-6-sol");
const flash = model("google:gemini-3.8-flash");
const haiku = model("anthropic:claude-haiku-4-5");
const luna = model("openai:gpt-6-luna");
const all = [opus, sonnet, sol, flash, haiku, luna];

test("stage one lists favourites, then recents, without repeats", () => {
  const ids = quickListModels({
    models: all,
    favorites: [opus.id, sol.id],
    recent: [sol.id, flash.id],
    currentId: opus.id,
  }).map((m) => m.id);
  assert.deepEqual(ids, [opus.id, sol.id, flash.id]);
});

test("the current model always has a row, taking the last slot when the list is full", () => {
  const ids = quickListModels({
    models: all,
    favorites: [opus.id, sonnet.id, sol.id, flash.id, haiku.id],
    recent: [],
    currentId: luna.id,
  }).map((m) => m.id);
  assert.equal(ids.length, QUICK_LIST_MAX);
  assert.equal(ids.at(-1), luna.id);
  assert.deepEqual(ids.slice(0, 4), [opus.id, sonnet.id, sol.id, flash.id]);
});

test("stage one drops what this surface cannot pick", () => {
  const ids = quickListModels({
    models: [opus, model(sol.id, { comingSoon: true }), flash],
    favorites: [sol.id, "retired:model", AUTO_MODEL_ID],
    recent: [flash.id, opus.id],
    currentId: null,
    filter: (m) => m.provider !== "anthropic",
  }).map((m) => m.id);
  assert.deepEqual(ids, [flash.id]);
});
