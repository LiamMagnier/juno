import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MAX_SOURCE_SNIPPET_BYTES,
  MAX_SOURCE_TITLE_BYTES,
  normalizeSource,
  normalizeSources,
  SourceRegistry,
} from "@/lib/chat/source-registry";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";

/*
 * THE TURN'S ONE LIST OF SOURCES (SPEC §2.11, INV-3).
 *
 * A shipped native build refuses a whole `sources` frame — and on `done` the
 * whole answer — for one source with an empty title, a title with a line
 * break or a relative URL. Nothing reaches the wire without `normalizeSource`,
 * and the registry numbers every source once, so a citation [n] resolves to
 * the page the model was shown as [n].
 */

const bytes = (value: string) => new TextEncoder().encode(value).length;

test("normalizeSource: title single-line, bounded, falling back to the host (INV-3)", () => {
  assert.deepEqual(normalizeSource({ title: "", url: "https://www.example.com/a", snippet: "s" }), {
    title: "example.com",
    url: "https://www.example.com/a",
    snippet: "s",
  });
  assert.equal(normalizeSource({ title: "Line\none\r\ntwo\u2028three", url: "https://a.example/" })!.title, "Line one two three");
  assert.equal(normalizeSource({ title: "Soft\u00adhyphen \u200Fmark", url: "https://a.example/" })!.title, "Softhyphen mark");
  const long = normalizeSource({ title: "é".repeat(3_000), url: "https://a.example/" })!;
  assert.ok(bytes(long.title) <= MAX_SOURCE_TITLE_BYTES);
  const snippet = normalizeSource({ title: "t", url: "https://a.example/", snippet: "x".repeat(40_000) })!;
  assert.ok(bytes(snippet.snippet) <= MAX_SOURCE_SNIPPET_BYTES);
  assert.equal(normalizeSource({ title: "t", url: "https://a.example/" })!.snippet, "", "snippet is always a string");
});

test("normalizeSource: only absolute http(s) URLs with a host; others are dropped", () => {
  for (const url of ["", "/relative", "javascript:alert(1)", "ftp://a.example/", "https://", "https://user:pw@a.example/", `https://a.example/${"x".repeat(3_000)}`]) {
    assert.equal(normalizeSource({ title: "t", url }), null, url);
  }
  assert.equal(normalizeSource({ title: "t", url: "https://a.example/x?q=1#frag" })!.url, "https://a.example/x?q=1#frag", "plain ASCII URLs are kept byte for byte");
  assert.equal(normalizeSource({ title: "t", url: "https://a.example/a b" })!.url, "https://a.example/a%20b", "a URL native cannot parse is serialised");
  assert.equal(normalizeSource({ title: "t", url: "https://bücher.example/" })!.url, "https://xn--bcher-kva.example/");
});

test("normalizeSource keeps a known origin and cited, and drops an unknown origin", () => {
  assert.deepEqual(normalizeSource({ title: "t", url: "https://a.example/", origin: "juno_fetch", cited: true }), {
    title: "t",
    url: "https://a.example/",
    snippet: "",
    cited: true,
    origin: "juno_fetch",
  });
  assert.equal(normalizeSource({ title: "t", url: "https://a.example/", origin: "made_up" as never })!.origin, undefined);
  assert.equal(normalizeSources([{ title: "a", url: "x" }, { title: "b", url: "https://b.example/" }]).length, 1);
});

test("register numbers in order, 1-based, and returns the existing number for a duplicate", () => {
  const registry = new SourceRegistry();
  const first = registry.register(
    [
      { title: "A", url: "https://a.example/1", snippet: "" },
      { title: "B", url: "https://b.example/2", snippet: "" },
    ],
    { cited: true, origin: "juno_search" }
  );
  assert.deepEqual(first.map((entry) => entry.n), [1, 2]);
  const again = registry.register([{ title: "A again", url: "https://a.example/1#section", snippet: "" }], { cited: false });
  assert.equal(again[0].n, 1, "dedupe ignores the fragment");
  assert.equal(registry.all().length, 2);
  assert.equal(registry.all()[0].title, "A", "the first sighting's title stays");
  assert.equal(registry.numberOf("https://b.example/2"), 2);
  assert.equal(registry.numberOf("https://nowhere.example/"), undefined);
});

test("register: an invalid source gets no number; the rest keep theirs", () => {
  const registry = new SourceRegistry();
  const out = registry.register(
    [
      { title: "bad", url: "notaurl", snippet: "" },
      { title: "ok", url: "https://ok.example/", snippet: "" },
    ],
    { cited: false }
  );
  assert.deepEqual(out.map((entry) => [entry.n, entry.source.title]), [[1, "ok"]]);
});

test("origin is stamped on new sources, and the first origin wins for duplicates", () => {
  const registry = new SourceRegistry();
  registry.register([{ title: "P", url: "https://p.example/", snippet: "" }], { cited: false, origin: "provider_search" });
  registry.register([{ title: "P", url: "https://p.example/", snippet: "" }], { cited: false, origin: "juno_fetch" });
  registry.register([{ title: "Q", url: "https://q.example/", snippet: "", origin: "research" }], { cited: false });
  assert.deepEqual(
    registry.all().map((source) => source.origin),
    ["provider_search", "research"]
  );
});

test("a source first read and later handed to the model under a number becomes cited; never the reverse", () => {
  const registry = new SourceRegistry();
  registry.register([{ title: "R", url: "https://r.example/", snippet: "" }], { cited: false, origin: "juno_fetch" });
  assert.equal(registry.all()[0].cited, undefined);
  registry.register([{ title: "R", url: "https://r.example/", snippet: "" }], { cited: true });
  assert.equal(registry.all()[0].cited, true);
  registry.register([{ title: "R", url: "https://r.example/", snippet: "" }], { cited: false });
  assert.equal(registry.all()[0].cited, true);
});

test("drainAdded returns what was added since the last call", () => {
  const registry = new SourceRegistry();
  registry.register([{ title: "A", url: "https://a.example/", snippet: "" }], { cited: false });
  assert.deepEqual(registry.drainAdded().map((source) => source.url), ["https://a.example/"]);
  registry.register([{ title: "A", url: "https://a.example/", snippet: "" }, { title: "B", url: "https://b.example/", snippet: "" }], { cited: false });
  assert.deepEqual(registry.drainAdded().map((source) => source.url), ["https://b.example/"]);
  assert.deepEqual(registry.drainAdded(), []);
});

test("the accumulator numbers against the turn's registry when given one (SPEC §2.11)", () => {
  const registry = new SourceRegistry();
  registry.register([{ title: "Tool", url: "https://tool.example/", snippet: "" }], { cited: true, origin: "juno_search" });
  const acc = new GenerationAccumulator({ sources: registry });
  acc.apply({ type: "sources", origin: "provider_search", sources: [{ title: "", url: "https://prov.example/x", snippet: "" }] });
  assert.deepEqual(
    acc.sources.map((source) => [source.url, source.title, source.origin]),
    [
      ["https://tool.example/", "Tool", "juno_search"],
      ["https://prov.example/x", "prov.example", "provider_search"],
    ],
    "one list, normalised, in first-seen order"
  );
  assert.equal(registry.all().length, 2);
});

test("the registry stays free of server-only (harness rule 1)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/chat/source-registry.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  assert.deepEqual(
    [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]),
    ["@/types/chat", "@/types/run"]
  );
});
