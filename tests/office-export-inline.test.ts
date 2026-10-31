import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import JSZip from "jszip";

// office-export.ts is server-only; load it the way the other server-module tests do.
const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const { toDocx } = createRequire(import.meta.url)("../src/lib/office-export") as typeof import("@/lib/office-export");

/*
 * The Word export keeps the writer's words. Underscores inside a word
 * (snake_case, CONSTANT_NAMES, file_names.txt) are part of the word, as in
 * CommonMark and in the canvas's own preview; only an underscore at a word's
 * edge opens or closes emphasis. The export used to treat every pair of
 * underscores as italics, so "READER_EDIT_LINE" came out of Word as
 * "READEREDITLINE" with EDIT in italics.
 */

async function documentRuns(markdown: string) {
  const zip = await JSZip.loadAsync(await toDocx(markdown, "Inline test"));
  const xml = await zip.file("word/document.xml")!.async("string");
  const runs = [...xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => ({
    text: [...m[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(""),
    italic: /<w:i\/>|<w:i [^>]*\/>/.test(m[1]),
    bold: /<w:b\/>|<w:b [^>]*\/>/.test(m[1]),
  }));
  // The title is the first paragraph; the body follows it.
  return { runs, text: runs.map((r) => r.text).join("").replace(/^Inline test/, "") };
}

test("underscores inside words survive the Word export as written", async () => {
  const { text, runs } = await documentRuns("Keep READER_EDIT_LINE, snake_case_name and file_v2_final.txt exactly.");
  assert.match(text, /READER_EDIT_LINE/);
  assert.match(text, /snake_case_name/);
  assert.match(text, /file_v2_final\.txt/);
  assert.equal(runs.some((r) => r.italic), false, "nothing in the sentence is emphasis");
});

test("underscores at a word's edge are still emphasis, and bold still works both ways", async () => {
  const { text, runs } = await documentRuns("A _quiet_ word, a __loud__ one, *stars* and **double stars**.");
  assert.equal(text, "A quiet word, a loud one, stars and double stars.");
  assert.ok(runs.find((r) => r.text === "quiet")?.italic, "_quiet_ is italic");
  assert.ok(runs.find((r) => r.text === "stars")?.italic, "*stars* is italic");
  assert.ok(runs.find((r) => r.text === "loud")?.bold, "__loud__ is bold");
  assert.ok(runs.find((r) => r.text === "double stars")?.bold, "**double stars** is bold");
});

test("a word-internal underscore next to real emphasis keeps both", async () => {
  const { text, runs } = await documentRuns("Set _MAX_RETRIES_ to 3 in config_local.");
  assert.equal(text, "Set MAX_RETRIES to 3 in config_local.");
  assert.ok(runs.find((r) => r.text === "MAX_RETRIES")?.italic, "the emphasised constant keeps its inner underscore");
});
