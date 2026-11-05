import test from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEW_BELOW_CHARS,
  isPreviewOnly,
  openedUrlsFrom,
  readStateCounts,
  sourceReadState,
} from "@/lib/research/source-provenance";
import { DEEPEN_BELOW_CHARS } from "@/lib/research/stages/limits";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * Sources opened versus text the search engine handed back (master brief 7.1).
 * The ledger is the run's `source_read` events; these are the exact payload
 * shapes the stages write (stages/corpus.ts, stages/workers.ts).
 */

const page = "https://vendor.example/pricing";
const preview = "https://news.example/story";
const full = "https://blog.example/long-read";

test("pure: no server-only module in the provenance graph", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/source-provenance.ts"), []);
});

test("the preview threshold is the reader stage's own deepen threshold", () => {
  assert.equal(PREVIEW_BELOW_CHARS, DEEPEN_BELOW_CHARS);
});

test("a fetch is opened; the READ stage's bookkeeping line is not", () => {
  const opened = openedUrlsFrom({
    events: [
      // READ stage, required fetch.
      { kind: "source_read", payload: { url: page, title: "Pricing" } },
      // The wave's bookkeeping line, emitted for every source fetched or not.
      { kind: "source_read", payload: { url: preview, title: "Story", ranked: true } },
      { kind: "source_read", payload: { url: page, title: "Pricing", ranked: true } },
      // Not reads at all.
      { kind: "source_found", payload: { url: full, title: "Long read" } },
      { kind: "query_issued", payload: { query: "x" } },
    ],
  });
  assert.ok(opened);
  assert.deepEqual([...opened], ["https://vendor.example/pricing"]);
  assert.equal(sourceReadState({ url: page, textChars: 400 }, opened), "opened", "a short page that was opened is still opened");
  assert.equal(sourceReadState({ url: preview, textChars: 300 }, opened), "search_preview");
  assert.equal(sourceReadState({ url: full, textChars: PREVIEW_BELOW_CHARS }, opened), "search_text");
  assert.equal(sourceReadState({ url: full, textChars: PREVIEW_BELOW_CHARS - 1 }, opened), "search_preview");
});

test("every fetching stage's event shape counts: deepen, link hop, a worker's open_page", () => {
  const opened = openedUrlsFrom({
    events: [
      { kind: "source_read", payload: { url: "https://a.example/1", title: "A", deepened: true } },
      { kind: "source_read", payload: { url: "https://b.example/2", title: "B", hop: 1 } },
      { kind: "source_read", payload: { url: "https://c.example/3", title: "C", workerId: "w1", round: 2 } },
    ],
  })!;
  for (const url of ["https://a.example/1", "https://b.example/2", "https://c.example/3"]) {
    assert.equal(sourceReadState({ url, textChars: 100 }, opened), "opened", url);
  }
});

test("URLs match the way the store keys rows: www, fragments and tracking parameters do not matter", () => {
  const opened = openedUrlsFrom({ events: [{ kind: "source_read", payload: { url: "https://www.vendor.example/pricing/?utm_source=x#plans" } }] })!;
  assert.equal(sourceReadState({ url: "https://vendor.example/pricing", textChars: 50 }, opened), "opened");
});

test("the plan's sweepFetched list is the same fact and is unioned in", () => {
  const opened = openedUrlsFrom({ events: [], sweepFetched: [full] })!;
  assert.equal(sourceReadState({ url: full, textChars: 120 }, opened), "opened");
});

test("no ledger at all is unknown, never 'opened' and never 'preview'", () => {
  const opened = openedUrlsFrom({ events: [{ kind: "source_found", payload: { url: page } }] });
  assert.equal(opened, null);
  assert.equal(sourceReadState({ url: page, textChars: 500 }, opened), null);
  // What the URL and the length settle on their own is still answered.
  assert.equal(sourceReadState({ url: page, textChars: 0 }, opened), "not_read");
  assert.equal(sourceReadState({ url: "https://private.invalid/attachment/abc", textChars: 10 }, opened), "private");
});

test("malformed payloads are skipped, not trusted", () => {
  const opened = openedUrlsFrom({
    events: [
      { kind: "source_read", payload: null },
      { kind: "source_read", payload: ["https://x.example"] },
      { kind: "source_read", payload: { url: 42 } },
      { kind: "source_read", payload: { url: "   " } },
    ],
  });
  assert.ok(opened, "the ledger exists — reads were recorded");
  assert.equal(opened!.size, 0);
});

test("only a preview demotes a verdict, and the counts add up", () => {
  assert.equal(isPreviewOnly("search_preview"), true);
  for (const state of ["opened", "search_text", "private", "not_read", null, undefined] as const) assert.equal(isPreviewOnly(state), false);
  assert.deepEqual(readStateCounts(["opened", "opened", "search_preview", null, "private"]), {
    opened: 2,
    search_text: 0,
    search_preview: 1,
    private: 1,
    not_read: 0,
  });
});
