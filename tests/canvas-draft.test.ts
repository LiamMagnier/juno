import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CANVAS_DRAFT_COPY,
  LOCAL_CANVAS_DRAFT_TTL_MS,
  canvasDraftOffer,
  canvasDraftStorageKey,
  clearLocalCanvasDraft,
  draftAtRisk,
  draftSyncWords,
  parseServerCanvasDraft,
  readLocalCanvasDraft,
  relativeDraftAge,
  syncAfterLocalWrite,
  syncAfterServerWrite,
  writeLocalCanvasDraft,
} from "@/lib/canvas-draft";
import { OWNER_COLUMN } from "@/lib/db";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * G12: never lose canvas edits. The client half's decisions — the device copy,
 * which copy is offered back, the words for where an edit is kept, and when
 * leaving the page must ask first — and the canvas's wiring to them.
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  failWrites = false;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
}

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test("canvas-draft.ts is client-safe", () => {
  assert.deepEqual(serverOnlyIn("src/lib/canvas-draft.ts"), []);
});

test("the device copy round-trips, keyed by artifact", () => {
  const storage = new MemoryStorage();
  assert.equal(writeLocalCanvasDraft(storage, "a1", { content: "<p>hi</p>", baseVersion: 3, updatedAt: iso(1000) }), true);
  assert.ok(storage.getItem(canvasDraftStorageKey("a1")));
  assert.deepEqual(readLocalCanvasDraft(storage, "a1", NOW), { content: "<p>hi</p>", baseVersion: 3, updatedAt: iso(1000) });
  assert.equal(readLocalCanvasDraft(storage, "a2", NOW), null);
  clearLocalCanvasDraft(storage, "a1");
  assert.equal(readLocalCanvasDraft(storage, "a1", NOW), null);
});

test("an expired or corrupt device copy is dropped, not offered", () => {
  const storage = new MemoryStorage();
  writeLocalCanvasDraft(storage, "old", { content: "x", baseVersion: 1, updatedAt: iso(LOCAL_CANVAS_DRAFT_TTL_MS + 1) });
  assert.equal(readLocalCanvasDraft(storage, "old", NOW), null);
  assert.equal(storage.getItem(canvasDraftStorageKey("old")), null, "removed on read");
  storage.setItem(canvasDraftStorageKey("bad"), "{not json");
  assert.equal(readLocalCanvasDraft(storage, "bad", NOW), null);
  assert.equal(storage.getItem(canvasDraftStorageKey("bad")), null);
  storage.setItem(canvasDraftStorageKey("shape"), JSON.stringify({ content: 1, baseVersion: "2" }));
  assert.equal(readLocalCanvasDraft(storage, "shape", NOW), null);
});

test("blocked or missing storage never throws", () => {
  const storage = new MemoryStorage();
  storage.failWrites = true;
  assert.equal(writeLocalCanvasDraft(storage, "a", { content: "x", baseVersion: 1, updatedAt: iso(0) }), false);
  assert.equal(writeLocalCanvasDraft(null, "a", { content: "x", baseVersion: 1, updatedAt: iso(0) }), false);
  assert.equal(readLocalCanvasDraft(null, "a", NOW), null);
  clearLocalCanvasDraft(null, "a");
});

test("the server's answer is read defensively", () => {
  assert.deepEqual(parseServerCanvasDraft({ draft: { content: "c", baseVersion: 2, updatedAt: iso(0) } }), {
    content: "c",
    baseVersion: 2,
    updatedAt: iso(0),
  });
  assert.equal(parseServerCanvasDraft({ draft: null }), null);
  assert.equal(parseServerCanvasDraft({ draft: { content: "c", baseVersion: 0, updatedAt: iso(0) } }), null);
  assert.equal(parseServerCanvasDraft("<html>"), null);
});

test("the newer copy is offered; an edit equal to the head is not", () => {
  const local = { content: "local edit", baseVersion: 4, updatedAt: iso(60_000) };
  const server = { content: "server edit", baseVersion: 4, updatedAt: iso(5 * 60_000) };
  assert.equal(canvasDraftOffer({ local, server, headContent: "head", currentVersion: 4 })?.content, "local edit");
  assert.equal(canvasDraftOffer({ local: { ...local, updatedAt: iso(10 * 60_000) }, server, headContent: "head", currentVersion: 4 })?.content, "server edit");
  assert.equal(canvasDraftOffer({ local: null, server, headContent: "head", currentVersion: 4 })?.content, "server edit");
  assert.equal(canvasDraftOffer({ local: null, server: null, headContent: "head", currentVersion: 4 }), null);
  assert.equal(canvasDraftOffer({ local: { ...local, content: "head" }, server: null, headContent: "head", currentVersion: 4 }), null);
});

test("an offer says when the artifact moved on, and a copy from an unseen version is held back", () => {
  const copy = { content: "edit", baseVersion: 2, updatedAt: iso(0) };
  assert.equal(canvasDraftOffer({ local: copy, server: null, headContent: "head", currentVersion: 5 })?.stale, true);
  assert.equal(canvasDraftOffer({ local: copy, server: null, headContent: "head", currentVersion: 2 })?.stale, false);
  assert.equal(canvasDraftOffer({ local: { ...copy, baseVersion: 6 }, server: null, headContent: "head", currentVersion: 5 }), null);
});

test("sync states follow the writes, and only an edit written nowhere is at risk", () => {
  assert.equal(syncAfterLocalWrite(true, true), "saving");
  assert.equal(syncAfterLocalWrite(false, true), "pending");
  assert.equal(syncAfterLocalWrite(true, false), "device");
  assert.equal(syncAfterLocalWrite(false, false), "unsaved");
  assert.equal(syncAfterServerWrite(true, false), "saved");
  assert.equal(syncAfterServerWrite(false, true), "device");
  assert.equal(syncAfterServerWrite(false, false), "unsaved");
  assert.equal(draftAtRisk("pending"), true);
  assert.equal(draftAtRisk("unsaved"), true);
  for (const safe of ["saving", "saved", "device", null] as const) assert.equal(draftAtRisk(safe), false);
});

test("the words for where an edit is kept do not flicker while typing", () => {
  assert.equal(draftSyncWords("pending").text, draftSyncWords("saving").text);
  assert.equal(draftSyncWords("saved").text, CANVAS_DRAFT_COPY.saved);
  assert.equal(draftSyncWords("device").text, CANVAS_DRAFT_COPY.device);
  assert.equal(draftSyncWords("unsaved").attention, true);
  assert.equal(draftSyncWords("saved").attention, false);
  for (const value of Object.values(CANVAS_DRAFT_COPY)) {
    assert.doesNotMatch(value, /juno/i);
    // Sentence case: no Title Case Words after the first.
    assert.doesNotMatch(value, /^\S+ [A-Z][a-z]+ [A-Z][a-z]+/);
  }
});

test("a draft's age reads in words", () => {
  assert.equal(relativeDraftAge(iso(10_000), NOW, "en"), CANVAS_DRAFT_COPY.justNow);
  assert.equal(relativeDraftAge(iso(3 * 60_000), NOW, "en"), "3 minutes ago");
  assert.equal(relativeDraftAge(iso(2 * 3_600_000), NOW, "en"), "2 hours ago");
  assert.equal(relativeDraftAge(iso(26 * 3_600_000), NOW, "en"), "yesterday");
  assert.equal(relativeDraftAge("not a date", NOW, "en"), "");
});

test("the canvas guards Close, autosaves every change and drops the draft on save and discard", () => {
  const panel = readFileSync("src/components/canvas/canvas-panel.tsx", "utf8");
  // Close asks first when the editor holds an edit.
  assert.match(panel, /const requestClose = \(\) => \{\s*if \(dirty\) setCloseConfirm\(true\);\s*else onClose\(\);/);
  assert.match(panel, /onClick=\{requestClose\} aria-label="Close canvas"/);
  assert.doesNotMatch(panel, /onClick=\{onClose\} aria-label="Close canvas"/);
  // Every change is recorded — but never over a kept edit still on offer.
  assert.match(panel, /if \(!canvasDraft\.offer\) canvasDraft\.record\(next, base\);/);
  // Save and discard clear the kept copies, and leave an unresolved offer alone.
  assert.match(panel, /if \(!canvasDraft\.offer\) canvasDraft\.clear\(\);\s*toast\.success\(`Saved as v/);
  assert.match(panel, /const discardDraft = React\.useCallback\(\(\) => \{\s*setDraft\(null\);\s*setStaleConflict\(null\);[\s\S]{0,200}if \(!canvasDraft\.offer\) canvasDraft\.clear\(\);/);
  // Incognito and designs keep nothing past the page; incognito still holds
  // the edit in memory so switching artifacts and back does not lose it.
  assert.match(panel, /const persistDraft = !!shareable && !isDesign;/);
  assert.match(panel, /persist: persistDraft,\s*remember: !isDesign,/);
  // The restore offer is drawn whatever tab is open, until the reader decides.
  assert.match(panel, /\{canvasDraft\.offer && \(\s*<DraftRestoreBar/);
  // An edit recorded nowhere says so in the header.
  assert.match(panel, /draftSyncWords\(canvasDraft\.sync \?\? "unsaved"\)/);
});

test("leaving the page flushes, and asks only when the edit is at risk", () => {
  const hook = readFileSync("src/components/canvas/use-canvas-draft.ts", "utf8");
  assert.match(hook, /window\.addEventListener\("beforeunload", onBeforeUnload\)/);
  assert.match(hook, /window\.addEventListener\("pagehide", flush\)/);
  assert.match(hook, /keepalive: true/);
  // A discard waits for an autosave in flight, so a late write cannot bring the draft back.
  assert.match(hook, /const before = inflight\.current \?\? Promise\.resolve\(\);\s*void before\.then\(\(\) => fetch\(draftUrl\(artifactId\), \{ method: "DELETE" \}\)\)/);
  // The incognito memory copy never reaches storage or the server, and goes on discard.
  assert.match(hook, /if \(remember\) memoryDrafts\.set\(artifactId,/);
  assert.match(hook, /memoryDrafts\.delete\(artifactId\);/);
  assert.match(hook, /atRiskRef\.current = dirty && \(!persist \|\| sync === null \|\| draftAtRisk\(sync\)\)/);
});

test("the canvas draft table is owner-guarded", () => {
  assert.equal(OWNER_COLUMN.get("ArtifactCanvasDraft"), "userId");
});
