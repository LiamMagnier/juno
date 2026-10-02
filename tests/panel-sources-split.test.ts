import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  citableSourceCount,
  citationOrder,
  sourceDomain,
  sourceKey,
  splitSources,
} from "@/lib/panel/sources-split";
import type { ClientActivityEvent, ClientSource } from "@/types/chat";
import type { ToolCallRecord } from "@/types/run";

/*
 * The Activity panel's Sources tab (SPEC §8.3.2): Cited, Also read, and —
 * only when there is neither — Found. Owned by WS6.
 */

test("the split stays importable from client components (no server-only in its graph)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/panel/sources-split.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  const valueImports = source.split("\n").filter((line) => /^import (?!type )/.test(line));
  assert.deepEqual(valueImports, [], "types only: nothing at runtime but its own code");
});

const src = (url: string, extra: Partial<ClientSource> = {}): ClientSource => ({
  title: `Title of ${url}`,
  url,
  snippet: "",
  ...extra,
});

let seq = 0;
function fetchEvent(url: string, extra: Partial<ToolCallRecord> = {}, event: Partial<ClientActivityEvent> = {}): ClientActivityEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    seq,
    kind: "visit",
    title: "Visited source",
    createdAt: "2026-09-24T10:00:00.000Z",
    call: {
      v: 1,
      callId: `f${seq}`,
      tool: "web_fetch",
      origin: "juno",
      title: "Read web page",
      status: "succeeded",
      round: 1,
      index: 0,
      startedAt: "2026-09-24T10:00:00.000Z",
      endedAt: "2026-09-24T10:00:02.000Z",
      args: { url },
      web: { requestedUrl: url, finalUrl: url },
      ...extra,
    },
    ...event,
  };
}

test("[n] resolves by position, only on a numbered-corpus message, ordered by first citation", () => {
  const sources = [
    src("https://a.example/1", { cited: true, origin: "juno_search" }),
    src("https://b.example/2", { cited: true, origin: "juno_search" }),
    src("https://c.example/3", { cited: true, origin: "juno_search" }),
  ];
  const split = splitSources({ sources, content: "First [3], then [1] and [3] again.", activity: [] });
  assert.deepEqual(
    split.cited.map((row) => [row.url, row.citedAs]),
    [
      ["https://c.example/3", [3]],
      ["https://a.example/1", [1]],
    ]
  );
  // The uncited search result was never opened: listed nowhere while there is
  // something cited (it is not "read"), and not as Found either.
  assert.deepEqual(split.alsoRead, []);
  assert.deepEqual(split.found, []);

  // The same text on a message whose sources were never numbered cites nothing:
  // a bracketed number there is prose (markdown.tsx renders no chip either).
  const plain: ClientSource[] = sources.map(({ cited: _cited, ...rest }) => rest);
  const unnumbered = splitSources({ sources: plain, content: "First [3], then [1].", activity: [] });
  assert.deepEqual(unnumbered.cited, []);
  assert.equal(citableSourceCount(plain), 0);
});

test("markers in code, link labels, definitions and past the list never cite", () => {
  const content = [
    "Real [1].",
    "Inline `arr[2]` is code.",
    "```",
    "matrix[3] = 0",
    "```",
    "A link [2](https://x.example) and a definition:",
    "[3]: https://y.example",
    "Invented [9] and [0].",
  ].join("\n");
  assert.deepEqual(citationOrder(content, 3), [1]);
  assert.deepEqual(citationOrder("no brackets at all", 3), []);
  assert.deepEqual(citationOrder("[1]", 0), []);
});

test("a page cited under two numbers is one row carrying both, in citation order", () => {
  const sources = [
    src("https://www.example.com/page/", { cited: true, origin: "juno_search" }),
    src("http://example.com/page#section", { cited: true, origin: "juno_fetch" }),
  ];
  const split = splitSources({ sources, content: "See [2] and [1].", activity: [] });
  assert.equal(split.cited.length, 1);
  assert.deepEqual(split.cited[0].citedAs, [2, 1]);
  assert.equal(split.cited[0].domain, "example.com");
  // First appearance wins the row's title and origin.
  assert.equal(split.cited[0].origin, "juno_search");
});

test("a search result counts as read only once a fetch of that page succeeded", () => {
  const sources = [
    src("https://read.example/a", { origin: "juno_search" }),
    src("https://unread.example/b", { origin: "juno_search" }),
  ];
  const activity = [
    fetchEvent("https://read.example/a"),
    fetchEvent("https://failed.example/c", { status: "failed", error: { code: "url_not_accessible" } }),
  ];
  const split = splitSources({ sources, content: "", activity });
  assert.deepEqual(split.alsoRead.map((row) => row.url), ["https://read.example/a"]);
  assert.equal(split.alsoRead[0].readAt, "2026-09-24T10:00:02.000Z");
  // Something was read, so the unopened result is not listed as Found.
  assert.deepEqual(split.found, []);
  // A failed fetch is not a reading.
  assert.ok(!split.alsoRead.some((row) => row.url.includes("failed.example")));
});

test("Found lists unopened search results only when nothing was cited or read", () => {
  const sources = [src("https://one.example/", { origin: "juno_search" }), src("https://two.example/", { origin: "juno_search" })];
  const split = splitSources({ sources, content: "", activity: [] });
  assert.deepEqual(split.cited, []);
  assert.deepEqual(split.alsoRead, []);
  assert.deepEqual(split.found.map((row) => row.domain), ["one.example", "two.example"]);
});

test("provider sources and legacy sources without an origin are read by the provider", () => {
  const sources = [src("https://grounded.example/x", { origin: "provider_grounding" }), src("https://legacy.example/y")];
  const split = splitSources({ sources, content: "", activity: [] });
  assert.deepEqual(split.alsoRead.map((row) => row.origin), ["provider_grounding", "provider_search"]);
  assert.deepEqual(split.found, []);
});

test("a page the run fetched that never reached `sources` still counts as read", () => {
  const redirected = fetchEvent("https://short.example/r", {
    web: { requestedUrl: "https://short.example/r", finalUrl: "https://long.example/article" },
  }, { detail: "The article title" });
  const split = splitSources({ sources: [], content: "", activity: [redirected] });
  assert.equal(split.alsoRead.length, 1);
  assert.equal(split.alsoRead[0].url, "https://long.example/article");
  assert.equal(split.alsoRead[0].origin, "juno_fetch");
  assert.equal(split.alsoRead[0].title, "The article title");

  // The search result for the short address and the fetch that landed on the
  // long one are the same reading: a redirect is one page.
  const withResult = splitSources({
    sources: [src("https://short.example/r", { origin: "juno_search" })],
    content: "",
    activity: [redirected],
  });
  assert.deepEqual(withResult.alsoRead.map((row) => row.url), ["https://short.example/r"]);
  assert.deepEqual(withResult.found, []);
});

test("rows are display-safe: host titles for URL-shaped titles, no non-web links, research quotes kept", () => {
  const sources = [
    src("https://www.titled.example/a", { title: "https://www.titled.example/a", origin: "juno_search", cited: true }),
    src("javascript:alert(1)", { cited: true }),
    src("https://research.example/q", { origin: "research", snippet: "  The verbatim quote.  ", cited: true }),
  ];
  const split = splitSources({ sources, content: "[1] [2] [3]", activity: [] });
  assert.deepEqual(split.cited.map((row) => row.title), ["titled.example", "Title of https://research.example/q"]);
  assert.equal(split.cited[1].quote, "The verbatim quote.");
  assert.equal(split.cited[0].favicon, "https://www.titled.example/favicon.ico");
  assert.ok(![...split.cited, ...split.alsoRead, ...split.found].some((row) => row.url.startsWith("javascript:")));
});

test("keys and domains ignore scheme, www, trailing slash and fragment, and keep the query", () => {
  assert.equal(sourceKey("https://www.Example.com/a/?q=1#frag"), sourceKey("http://example.com/a?q=1"));
  assert.notEqual(sourceKey("https://example.com/a?q=1"), sourceKey("https://example.com/a?q=2"));
  assert.equal(sourceKey("mailto:someone@example.com"), null);
  assert.equal(sourceDomain("https://www.example.com/x"), "example.com");
  assert.equal(sourceDomain("not a url"), null);
});

test("the split never reads an English title: a fetch row is found by its record", () => {
  const renamed = fetchEvent("https://typed.example/p", {}, { title: "Anything at all" });
  const split = splitSources({ sources: [], content: "", activity: [renamed] });
  assert.equal(split.alsoRead.length, 1);
  const legacyRow: ClientActivityEvent = {
    id: "legacy",
    kind: "visit",
    title: "Visited source",
    url: "https://legacy.example/",
    createdAt: "2026-09-24T10:00:00.000Z",
  };
  // A legacy visit row with no call record reads nothing on its own; its page
  // arrives through `sources`, like every pre-rework provider source.
  assert.deepEqual(splitSources({ sources: [], content: "", activity: [legacyRow] }).alsoRead, []);
});
