import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

/*
 * The i18n extractor never harvests model-facing text (SPEC §10.5, INV-29).
 *
 * Tool specs (`defineTool(...)`) and `*.prompt.ts` files are English written
 * for a model. Their `title`/`description` keys match the extractor's copy
 * properties, so without the skip they would land in the UI catalog, be sent
 * for translation, and cost a translation budget on strings no reader sees.
 * Runs the extractor's pure collection function on a fixture directory: a
 * tool spec, a prompt file and a `*_COPY` object.
 */

interface Extractor {
  collectCatalogStrings(dir: string, opts?: { skip?: string[] }): Set<string>;
  collectFromSource(content: string, file: string, strings?: Set<string>): Set<string>;
  catalogEntry(source: string): { id: string; source: string };
}

const script = path.join(process.cwd(), "scripts/generate-i18n-catalog.mjs");
const fixtures = path.join(process.cwd(), "tests/fixtures/i18n-extractor");

async function extractor(): Promise<Extractor> {
  // A computed specifier: the .mjs has no type declaration, and importing it only exports.
  return (await import(pathToFileURL(script).href)) as Extractor;
}

test("only the *_COPY phrases are collected from the fixtures", async () => {
  const { collectCatalogStrings } = await extractor();
  const strings = collectCatalogStrings(fixtures);
  assert.deepEqual([...strings].sort(), ["Fixture panel title", "Searching the web for", "sources"]);
});

test("defineTool arguments and prompt files are skipped, wherever they sit", async () => {
  const { collectFromSource } = await extractor();
  const spec = readFileSync(path.join(fixtures, "web-search.ts"), "utf8");
  assert.equal(collectFromSource(spec, "web-search.ts").size, 0);
  const prompt = readFileSync(path.join(fixtures, "web-search.prompt.ts"), "utf8");
  assert.equal(collectFromSource(prompt, "src/lib/tools/specs/web-search.prompt.ts").size, 0);
  // The same text outside a tool spec is copy, and is collected.
  assert.deepEqual([...collectFromSource('export const panelCopy = { title: "Web search fixture title" };', "panel.ts")], [
    "Web search fixture title",
  ]);
  // A method-style call (`tools.defineTool(...)`) is a tool spec too.
  assert.equal(collectFromSource('tools.defineTool({ title: "Method call title", description: "Model text." });', "x.ts").size, 0);
});

test("importing the extractor writes nothing; ids are the browser's catalog ids", async () => {
  const { catalogEntry } = await extractor();
  const id = createHash("sha256").update("Thinking", "utf8").digest("hex").slice(0, 16);
  assert.deepEqual(catalogEntry("Thinking"), { id, source: "Thinking" });
  const source = readFileSync(script, "utf8");
  assert.match(source, /if \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\) main\(\);/);
});
