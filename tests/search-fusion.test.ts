import test from "node:test";
import assert from "node:assert/strict";
import { fuseRankedLists, RRF_K, type SearchResult } from "@/lib/search/fusion";
import { canonicalUrl, isDisallowedHost } from "@/lib/search/url-safety";

/**
 * The judgement in the search stack, held down.
 *
 * fusion.ts and url-safety.ts were split out of the `server-only`
 * search-engine.ts precisely so this file could exist — see the header comment
 * on each. Everything here is pure and needs no network.
 */

// ---------------------------------------------------------------------------
// The host guard
// ---------------------------------------------------------------------------

/*
 * These are the addresses the guard exists to stop, written as URLs rather than
 * hostnames because several of them only become dangerous after `URL` has
 * normalised them — `http://2130706433/` is loopback and does not look it.
 */
const MUST_BLOCK: Array<[string, string]> = [
  ["http://localhost/", "the obvious one"],
  ["http://LOCALHOST./", "the fully-qualified form resolves identically to the bare one"],
  ["http://svc.internal./", "…and the same trailing dot defeats a naive .internal suffix check"],
  ["http://runner.local/", "mDNS names are the local network by definition"],
  ["http://127.0.0.1/", "loopback"],
  ["http://127.0.0.2/", "the whole of 127.0.0.0/8 is loopback, not just .1"],
  ["http://127.1/", "URL expands the short form back to 127.0.0.1"],
  ["http://0177.0.0.1/", "…and the octal form"],
  ["http://2130706433/", "…and the integer form"],
  ["http://0.0.0.0/", "the unspecified address routes to local services"],
  ["http://[::1]/", "IPv6 loopback: URL reports it bracketed, so a bare '::1' test misses it"],
  ["http://[0:0:0:0:0:0:0:1]/", "…including the uncompressed spelling"],
  ["http://[::]/", "the IPv6 unspecified address"],
  ["https://[::ffff:127.0.0.1]/", "IPv4-mapped loopback is a second path to 127.0.0.1"],
  ["http://[::ffff:10.0.0.1]/", "…and to RFC 1918"],
  ["http://[fd00::1]/", "fc00::/7 unique-local is IPv6's RFC 1918"],
  ["http://[fe80::1]/", "fe80::/10 link-local"],
  ["http://169.254.169.254/latest/meta-data/", "cloud instance metadata: the crown jewels"],
  ["http://169.254.1.1/", "the rest of link-local"],
  ["http://10.0.0.5/", "RFC 1918"],
  ["http://192.168.1.1/", "RFC 1918"],
  ["http://172.16.0.1/", "RFC 1918, low edge"],
  ["http://172.31.255.255/", "RFC 1918, high edge"],
  ["data:text/html,<b>hi", "no host at all: hands the extractor attacker-authored text"],
  ["file:///etc/passwd", "not a network scheme"],
  ["javascript:alert(1)", "not a network scheme"],
  ["httpsss://example.com", "unparseable fails closed"],
];

for (const [url, why] of MUST_BLOCK) {
  test(`isDisallowedHost blocks ${url} — ${why}`, () => {
    assert.equal(isDisallowedHost(url), true);
  });
}

test("the guard does not overblock: public addresses that merely resemble private ones", () => {
  // Each of these is a string-prefix near-miss of a rule above. Blocking them
  // would quietly shrink the corpus, which is the failure mode nobody notices.
  for (const url of [
    "https://example.com/ok",
    "https://example.com.", // trailing dot on a PUBLIC name is still public
    "http://172.32.0.1/", // one past the top of 172.16/12
    "http://172.15.0.1/", // one below the bottom
    "http://11.0.0.1/", // not 10/8
    "http://192.169.1.1/", // not 192.168/16
    "http://126.0.0.1/", // not 127/8
    "https://[2606:4700::1111]/", // a real public resolver
    "https://sub.localhostage.com/", // contains "localhost" as a substring
    "https://notinternal.example.com/", // ends with "internal" but not ".internal"
  ]) {
    assert.equal(isDisallowedHost(url), false, `${url} is public and must remain fetchable`);
  }
});

// ---------------------------------------------------------------------------
// The dedupe key
// ---------------------------------------------------------------------------

test("canonicalUrl collapses the spellings engines disagree about", () => {
  const canonical = "https://example.com/a/b";
  for (const variant of [
    "https://example.com/a/b",
    "https://www.example.com/a/b",
    "https://EXAMPLE.com/a/b",
    "https://example.com/a/b/",
    "https://example.com/a/b#section",
    "https://example.com/a/b?utm_source=x&utm_campaign=y",
    "https://example.com/a/b?fbclid=z",
    "https://example.com/a/b?gclid=z",
    "https://example.com/a/b?ref=news",
  ]) {
    assert.equal(canonicalUrl(variant), canonical, `${variant} is the same page`);
  }
});

test("canonicalUrl keeps the query parameters that select the content", () => {
  // Dropping these would fuse genuinely different pages into one, which is the
  // opposite failure and the more damaging of the two.
  assert.notEqual(canonicalUrl("https://example.com/view?id=1"), canonicalUrl("https://example.com/view?id=2"));
  assert.equal(canonicalUrl("https://example.com/view?id=1&utm_source=x"), "https://example.com/view?id=1");
});

test("canonicalUrl keeps the scheme, so http and https are not silently merged", () => {
  assert.notEqual(canonicalUrl("http://example.com/a"), canonicalUrl("https://example.com/a"));
});

test("canonicalUrl falls back to a trimmed string rather than throwing", () => {
  assert.equal(canonicalUrl("  Not A URL  "), "not a url");
});

// ---------------------------------------------------------------------------
// Reciprocal-rank fusion
// ---------------------------------------------------------------------------

function hit(url: string, over: Partial<SearchResult> = {}): SearchResult {
  return { title: url, url, snippet: "…", engine: "unset", ...over };
}

test("agreement between weaker engines beats a lone strong one", () => {
  /*
   * The property the whole design rests on, at the weights search-engine.ts
   * actually ships: the two keyless scrapers (0.7 each) agreeing on a page sum
   * to 1.4 and outrank a page only the keyed index (1.0) returned. Agreement is
   * what climbs — which is also why the sum, not the max, is the score.
   */
  const fused = fuseRankedLists(
    [
      { engine: { name: "tavily", weight: 1.0 }, hits: [hit("https://example.com/lone")] },
      { engine: { name: "duckduckgo", weight: 0.7 }, hits: [hit("https://example.com/agreed")] },
      { engine: { name: "searxng", weight: 0.7 }, hits: [hit("https://example.com/agreed")] },
    ],
    10
  );
  assert.equal(fused[0].url, "https://example.com/agreed");
  // …and the merged row names every engine that voted for it, sorted, so the
  // provenance string is stable rather than dependent on fan-out completion order.
  assert.equal(fused[0].engine, "duckduckgo+searxng");
});

test("agreement is not unconditional: it has to outweigh, not merely outnumber", () => {
  /*
   * The mirror of the test above, and the reason the weights are not decorative.
   * Wikipedia and OpenAlex both answer almost anything, so two of them agreeing
   * (0.35 + 0.3) must NOT displace a keyed web result — otherwise a question
   * about a kitchen appliance gets a reference-desk corpus at the top.
   */
  const fused = fuseRankedLists(
    [
      { engine: { name: "tavily", weight: 1.0 }, hits: [hit("https://example.com/web")] },
      { engine: { name: "wikipedia", weight: 0.35 }, hits: [hit("https://example.com/reference")] },
      { engine: { name: "openalex", weight: 0.3 }, hits: [hit("https://example.com/reference")] },
    ],
    10
  );
  assert.equal(fused[0].url, "https://example.com/web");
});

test("a lone hit from a low-weight corpus ranks below a lone hit from a trusted one", () => {
  const fused = fuseRankedLists(
    [
      { engine: { name: "openalex", weight: 0.3 }, hits: [hit("https://openalex.example/paper")] },
      { engine: { name: "web", weight: 1.0 }, hits: [hit("https://web.example/page")] },
    ],
    10
  );
  assert.equal(fused[0].url, "https://web.example/page");
});

test("rank matters within a list, and K flattens the head", () => {
  // Two engines ranking a page #2 beats one engine ranking a page #1, at equal
  // weight — that is what RRF_K buys and why it is not simply 1/rank.
  const fused = fuseRankedLists(
    [
      { engine: { name: "a", weight: 1 }, hits: [hit("https://example.com/top"), hit("https://example.com/second")] },
      { engine: { name: "b", weight: 1 }, hits: [hit("https://example.com/other"), hit("https://example.com/second")] },
    ],
    10
  );
  assert.equal(fused[0].url, "https://example.com/second");
  assert.ok(RRF_K > 1, "a K of 1 would make the #1 slot unbeatable");
});

test("the same page from two engines is one row carrying the richer copy of every field", () => {
  const published = new Date("2026-02-02T00:00:00.000Z");
  const fused = fuseRankedLists(
    [
      {
        engine: { name: "thin", weight: 1 },
        hits: [hit("https://example.com/p", { title: "P", snippet: "short" })],
      },
      {
        engine: { name: "rich", weight: 1 },
        // Same page, different spelling — this only merges if canonicalUrl is
        // the dedupe key, so it pins the two modules together.
        hits: [
          hit("https://www.example.com/p/?utm_source=x", {
            snippet: "a considerably longer snippet",
            rawContent: "the whole body",
            publishedAt: published,
            author: "A. Writer",
          }),
        ],
      },
    ],
    10
  );
  assert.equal(fused.length, 1, "one page must not appear twice and read as two corroborating sources");
  assert.equal(fused[0].rawContent, "the whole body");
  assert.equal(fused[0].publishedAt, published);
  assert.equal(fused[0].author, "A. Writer");
  assert.equal(fused[0].snippet, "a considerably longer snippet");
  assert.equal(fused[0].engine, "rich+thin");
});

test("a richer first copy is never downgraded by a thinner second one", () => {
  const fused = fuseRankedLists(
    [
      {
        engine: { name: "rich", weight: 1 },
        hits: [hit("https://example.com/p", { snippet: "a long snippet", rawContent: "body" })],
      },
      { engine: { name: "thin", weight: 1 }, hits: [hit("https://example.com/p", { snippet: "x" })] },
    ],
    10
  );
  assert.equal(fused[0].rawContent, "body");
  assert.equal(fused[0].snippet, "a long snippet");
});

test("fusion applies the host guard, so no engine can smuggle an internal URL into the corpus", () => {
  const fused = fuseRankedLists(
    [
      {
        engine: { name: "hostile", weight: 10 },
        hits: [
          hit("http://169.254.169.254/latest/meta-data/"),
          hit("http://[::1]/admin"),
          hit("ftp://example.com/file"),
          hit(""),
          hit("https://example.com/fine"),
        ],
      },
    ],
    10
  );
  assert.deepEqual(
    fused.map((r) => r.url),
    ["https://example.com/fine"]
  );
});

test("the result count is honoured and ties break deterministically", () => {
  const fused = fuseRankedLists(
    [
      {
        engine: { name: "a", weight: 1 },
        // Equal weight at equal rank across separate lists ⇒ identical scores,
        // so only the title tiebreak keeps the order stable between runs.
        hits: [hit("https://example.com/1", { title: "Beta" })],
      },
      { engine: { name: "b", weight: 1 }, hits: [hit("https://example.com/2", { title: "Alpha" })] },
      { engine: { name: "c", weight: 1 }, hits: [hit("https://example.com/3", { title: "Gamma" })] },
    ],
    2
  );
  assert.equal(fused.length, 2);
  assert.deepEqual(
    fused.map((r) => r.title),
    ["Alpha", "Beta"]
  );
});

test("no engines and no hits fuse to nothing rather than throwing", () => {
  assert.deepEqual(fuseRankedLists([], 10), []);
  assert.deepEqual(fuseRankedLists([{ engine: { name: "a", weight: 1 }, hits: [] }], 10), []);
});
