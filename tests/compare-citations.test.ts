import test from "node:test";
import assert from "node:assert/strict";
import { collectCitations, compareCitations, extractAnswerLinks, normalizeCitationUrl } from "@/lib/compare/citations";

/*
 * Master brief 4.3, citation comparison: which pages each model's answer rests
 * on, which the models share, with returned sources and in-text links kept
 * apart and the same page counted once however it was spelled.
 */

const src = (url: string, title = "") => ({ url, title, snippet: "" });

test("the same page spelled differently normalises to one key", () => {
  const key = normalizeCitationUrl("https://example.com/guide")?.key;
  for (const variant of [
    "http://www.example.com/guide/",
    "https://EXAMPLE.com/guide#section-2",
    "https://example.com/guide?utm_source=chatgpt.com&utm_medium=x",
    "https://example.com/guide?gclid=abc",
  ]) {
    assert.equal(normalizeCitationUrl(variant)?.key, key, variant);
  }
  assert.equal(normalizeCitationUrl("https://example.com/a?b=2&a=1")?.key, normalizeCitationUrl("https://example.com/a?a=1&b=2")?.key);
  assert.notEqual(normalizeCitationUrl("https://example.com/a?id=1")?.key, normalizeCitationUrl("https://example.com/a?id=2")?.key, "real parameters still count");
  assert.equal(normalizeCitationUrl("https://example.com/")?.key, "example.com");
  assert.equal(normalizeCitationUrl("https://www.example.com")?.host, "example.com");
  assert.equal(normalizeCitationUrl("mailto:someone@example.com"), null);
  assert.equal(normalizeCitationUrl("javascript:alert(1)"), null);
  assert.equal(normalizeCitationUrl("not a url"), null);
});

test("links are read from the prose: Markdown links with their text, bare URLs without trailing punctuation", () => {
  const links = extractAnswerLinks(
    [
      "See [the MDN guide](https://developer.mozilla.org/en-US/docs/Web) for details.",
      "Also https://web.dev/articles/vitals. And <https://example.org/x>!",
      "![a chart](https://img.example/chart.png)",
      "```",
      "curl https://api.example.com/v1",
      "```",
      "Run `fetch('https://inline.example/code')` first.",
    ].join("\n")
  );
  assert.deepEqual(links, [
    { url: "https://developer.mozilla.org/en-US/docs/Web", title: "the MDN guide" },
    { url: "https://web.dev/articles/vitals", title: "" },
    { url: "https://example.org/x", title: "" },
  ]);
});

test("one pane's citations merge returned sources and in-text links, flagging each", () => {
  const refs = collectCitations({
    sources: [src("https://a.example/one", "One"), src("https://b.example/two", "Two"), src("https://a.example/one/", "dupe")],
    content: "As [One](https://www.a.example/one) shows, and https://c.example/three too.",
  });
  assert.equal(refs.length, 3);
  const byHost = Object.fromEntries(refs.map((r) => [r.host, r]));
  assert.deepEqual([byHost["a.example"].inSources, byHost["a.example"].inText], [true, true]);
  assert.equal(byHost["a.example"].title, "One");
  assert.deepEqual([byHost["b.example"].inSources, byHost["b.example"].inText], [true, false]);
  assert.deepEqual([byHost["c.example"].inSources, byHost["c.example"].inText], [false, true]);
});

test("comparison: shared and unique per pane, pages every model cites, and sites more than one draws on", () => {
  const result = compareCitations([
    { paneId: "a", sources: [src("https://shared.example/x"), src("https://only-a.example/")], content: "" },
    { paneId: "b", sources: [src("https://shared.example/x?utm_source=b")], content: "See https://news.example/story" },
    { paneId: "c", sources: [src("https://www.shared.example/x/"), src("https://news.example/other")], content: "" },
  ]);
  assert.equal(result.union, 4);
  assert.deepEqual(result.sharedByAll.map((r) => r.key), ["shared.example/x"]);
  const a = result.panes.find((p) => p.paneId === "a")!;
  assert.deepEqual([a.total, a.shared, a.unique], [2, 1, 1]);
  assert.deepEqual(a.refs.find((r) => r.host === "shared.example")?.sharedWith, ["b", "c"]);
  assert.deepEqual(a.refs.find((r) => r.host === "only-a.example")?.sharedWith, []);
  assert.deepEqual(result.sharedHosts, [
    { host: "shared.example", paneIds: ["a", "b", "c"] },
    { host: "news.example", paneIds: ["b", "c"] },
  ]);
});

test("a single pane, or panes without sources, share nothing", () => {
  assert.deepEqual(compareCitations([{ paneId: "a", sources: [src("https://x.example/")], content: "" }]).sharedByAll, []);
  const empty = compareCitations([
    { paneId: "a", sources: [], content: "No links here." },
    { paneId: "b", sources: [], content: "" },
  ]);
  assert.equal(empty.union, 0);
  assert.deepEqual(empty.sharedByAll, []);
  assert.deepEqual(empty.panes.map((p) => p.total), [0, 0]);
});

test("URLs with parentheses are read whole, as GFM and CommonMark read them", () => {
  const MERCURY = "https://en.wikipedia.org/wiki/Mercury_(planet)";
  const links = extractAnswerLinks(
    [
      `Read [Mercury](${MERCURY}) first.`,
      `With a title: [The planet](${MERCURY} "Mercury").`,
      `Or the bare link ${MERCURY}.`,
      `Inside a sentence's own brackets (see ${MERCURY}).`,
      "Plain brackets close a sentence (https://example.com/x), not a URL.",
      "Deeper nesting falls back to the bare-URL rule: [f](https://example.com/f_(a_(b))",
    ].join("\n")
  );
  assert.deepEqual(links, [
    // Markdown links first, then bare URLs, each in order.
    { url: MERCURY, title: "Mercury" },
    { url: MERCURY, title: "The planet" },
    { url: MERCURY, title: "" },
    { url: MERCURY, title: "" },
    { url: "https://example.com/x", title: "" },
    { url: "https://example.com/f_(a_(b))", title: "" },
  ]);
});

test("a percent-encoded parenthesis is the same page as a literal one", () => {
  const key = normalizeCitationUrl("https://en.wikipedia.org/wiki/Mercury_(planet)")?.key;
  assert.equal(key, "en.wikipedia.org/wiki/Mercury_(planet)");
  assert.equal(normalizeCitationUrl("https://en.wikipedia.org/wiki/Mercury_%28planet%29")?.key, key);
  assert.equal(normalizeCitationUrl("https://en.wikipedia.org/wiki/Mercury_%28planet%29/")?.key, key);
  // An escaped slash is a different path and stays escaped (hex upper-cased, so its spelling does not matter).
  assert.equal(normalizeCitationUrl("https://example.com/a%2fb")?.key, "example.com/a%2Fb");
  assert.notEqual(normalizeCitationUrl("https://example.com/a%2Fb")?.key, normalizeCitationUrl("https://example.com/a/b")?.key);
});

test("the same page returned by one model and linked by another is shared, parentheses and all", () => {
  const result = compareCitations([
    { paneId: "a", sources: [src("https://en.wikipedia.org/wiki/Mercury_(planet)", "Mercury")], content: "" },
    { paneId: "b", sources: [], content: "Per [Wikipedia](https://en.wikipedia.org/wiki/Mercury_(planet))." },
    { paneId: "c", sources: [], content: "(https://en.wikipedia.org/wiki/Mercury_%28planet%29)" },
  ]);
  assert.deepEqual(result.sharedByAll.map((r) => r.url), ["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
  assert.equal(result.union, 1);
  assert.deepEqual(result.panes.map((p) => [p.total, p.shared]), [[1, 1], [1, 1], [1, 1]]);
});
