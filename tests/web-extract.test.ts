import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import test from "node:test";

import { isDisallowedHost } from "@/lib/search/url-safety";
import { extractUrlDocument } from "@/lib/web/extract";
import { htmlToCleanText, htmlToCleanTextAsync, looksLikeShell, MAX_PAGE_LINKS, type PageLink } from "@/lib/web/html-text";

/*
 * The page extractor (SPEC §6.4 item 1, gap-web W2).
 *
 * The old extractor was a chain of lazy `[\s\S]*?` regular expressions between
 * an opening and a closing tag, so an opening tag that never closed made the
 * engine retry from every such tag to the end of the document: quadratic in
 * bytes a stranger chose, on the server's one event loop. The acceptance is
 * relative, because absolute timings are flaky on shared runners: time grows
 * linearly across 1, 2 and 4 MB, and the event loop's p99 delay while the async
 * extractor runs stays under a generous ceiling.
 *
 * Parity: on well-formed pages the new extractor reads what the old one read.
 * The old one is kept below, verbatim minus its comments, as the oracle.
 * "Parity" is exact for the title, author, date and links, and exact for the
 * text up to blank lines: a closing `</p>` now ends its paragraph (the old
 * chain dropped it, gluing "end.Next" together whenever text followed it).
 */

// ── The oracle: the extractor at d0997af2 (src/lib/search/search-engine.ts:97-243) ──

const LEGACY_CHROME_TAGS = ["nav", "header", "footer", "aside", "form", "dialog"];

function stripChrome(html: string): string {
  let out = html;
  for (const tag of LEGACY_CHROME_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  return out;
}

const LEGACY_MAIN_REGION_MIN_CHARS = 600;

function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
}

function mainRegion(html: string): string {
  for (const tag of ["article", "main"]) {
    const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (match && visibleLength(match[1]) >= LEGACY_MAIN_REGION_MIN_CHARS) return match[1];
  }
  return html;
}

const LEGACY_MAX_PAGE_LINKS = 120;

function collectLinks(html: string, baseUrl?: string): PageLink[] {
  if (!baseUrl) return [];
  const out: PageLink[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let resolved: string;
    try {
      resolved = new URL(match[1], baseUrl).toString();
    } catch {
      continue;
    }
    if (isDisallowedHost(resolved)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const text = match[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    out.push({ href: resolved, text });
    if (out.length >= LEGACY_MAX_PAGE_LINKS) break;
  }
  return out;
}

function legacyHtmlToCleanText(
  html: string,
  baseUrl?: string
): { title?: string; text: string; author?: string; publishedAt?: Date; links: PageLink[] } {
  try {
    const stripped = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
    const titleMatch = stripped.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : undefined;

    const dateMatch = stripped.match(/<meta[^>]+(?:article:published_time|date|pubdate)[^>]+content=["']([^"']+)["']/i);
    let publishedAt: Date | undefined;
    if (dateMatch && dateMatch[1] && Number.isFinite(Date.parse(dateMatch[1]))) {
      publishedAt = new Date(dateMatch[1]);
    }

    const authorMatch = stripped.match(/<meta[^>]+(?:author|article:author)[^>]+content=["']([^"']+)["']/i);
    const author = authorMatch ? authorMatch[1].trim() : undefined;

    const body = mainRegion(stripChrome(stripped));
    const links = collectLinks(body, baseUrl);
    let clean = body
      .replace(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi, "\n\n## $1\n\n")
      .replace(/<h[4-6][^>]*>(.*?)<\/h[4-6]>/gi, "\n\n### $1\n\n")
      .replace(/<p[^>]*>/gi, "\n\n")
      .replace(/<\/p>/gi, "")
      .replace(/<li[^>]*>(.*?)<\/li>/gi, "\n- $1")
      .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, "\n> $1\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<hr\s*\/?>/gi, "\n---\n")
      .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)")
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
      .replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**")
      .replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*")
      .replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*")
      .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
      .replace(/<[^>]+>/g, " ");
    clean = clean
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
    clean = clean
      .split("\n")
      .map((line) => line.trim())
      .filter((line, i, arr) => line || (i > 0 && arr[i - 1]))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return { title, text: clean, author, publishedAt, links };
  } catch {
    return { text: html.replace(/<[^>]+>/g, " ").trim(), links: [] };
  }
}

function sameText(a: string, b: string): boolean {
  const squash = (s: string) => s.replace(/\n+/g, "\n");
  return squash(a) === squash(b);
}

// ── Pathological input ──────────────────────────────────────────────────────

const MB = 1024 * 1024;
const PATHOLOGICAL: Record<string, string> = {
  "unclosed <nav>": "<nav>menu ",
  "unclosed <article>": "<article>story ",
  "unclosed <a href>": '<a href="/p">link ',
  "unclosed <script>": "<script>var x ",
  "unclosed <noscript>": "<noscript>js ",
  "bare <": "<",
  "unterminated attribute quote": '<a href="x',
};

function sized(unit: string, megabytes: number): string {
  return unit.repeat(Math.ceil((megabytes * MB) / unit.length));
}

function timeOnce(html: string): number {
  const started = performance.now();
  htmlToCleanText(html, "https://example.com/");
  return performance.now() - started;
}

/**
 * The fastest of three runs, which filters scheduler noise and a stray GC
 * pause (seen in the Mac deploy's emulated amd64 build: 41, 85, then 392 ms).
 */
function bestOf(html: string): number {
  return Math.min(timeOnce(html), timeOnce(html), timeOnce(html));
}

/**
 * A timing verdict on a shared or emulated builder is noisy: one slow attempt
 * proves nothing, while a real quadratic regression fails every attempt. So a
 * measurement is retried, and passes if any of three attempts passes.
 */
async function anyAttemptPasses(attempts: number, measure: () => Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string }): Promise<{ ok: boolean; details: string[] }> {
  const details: string[] = [];
  for (let i = 0; i < attempts; i++) {
    const { ok, detail } = await measure();
    details.push(detail);
    if (ok) return { ok: true, details };
  }
  return { ok: false, details };
}

for (const [name, unit] of Object.entries(PATHOLOGICAL)) {
  test(`${name}: extraction time grows linearly across 1, 2 and 4 MB`, async () => {
    const verdict = await anyAttemptPasses(3, () => {
      const [one, two, four] = [1, 2, 4].map((size) => bestOf(sized(unit, size)));
      // Linear is ~4x from 1 to 4 MB; the old quadratic chain was ~16x (and
      // minutes at 4 MB). 10x leaves room for a slow, noisy builder and still
      // catches quadratic growth. A floor of 20 ms keeps a near-instant 1 MB run
      // from inflating the ratio on a fast machine.
      return {
        ok: four / Math.max(one, 20) < 10 && four < 5_000,
        detail: `1 MB ${one.toFixed(0)} ms, 2 MB ${two.toFixed(0)} ms, 4 MB ${four.toFixed(0)} ms`,
      };
    });
    assert.ok(verdict.ok, `${name}: ${verdict.details.join(" | ")}`);
  });
}

test("the async extractor keeps the event loop responsive on 4 MB of hostile HTML", async () => {
  const html = ["<nav>", "<article>", '<a href="/x">', "<script>"].map((unit) => sized(unit, 1)).join("");
  const verdict = await anyAttemptPasses(3, async () => {
    const histogram = monitorEventLoopDelay({ resolution: 5 });
    histogram.enable();
    await htmlToCleanTextAsync(html, "https://example.com/");
    histogram.disable();
    const p99Ms = histogram.percentile(99) / 1e6;
    // The extractor yields every 64 KB and every few thousand tokens; a slice is
    // a few milliseconds here. The ceiling is generous for shared runners, and a
    // blocking extractor misses it on every attempt, not just one.
    return { ok: p99Ms < 200, detail: `event loop p99 delay ${p99Ms.toFixed(1)} ms` };
  });
  assert.ok(verdict.ok, verdict.details.join(" | "));
});

test("the async extractor stops as soon as its signal aborts", async () => {
  const controller = new AbortController();
  const running = htmlToCleanTextAsync(sized("<nav>x ", 4), "https://example.com/", controller.signal);
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
});

// ── Parity on fixtures ──────────────────────────────────────────────────────

const LONG = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(14);

const FIXTURES: Record<string, string> = {
  article: `<!doctype html><html><head><title>My Article</title><meta name="author" content="Jane Doe">
<meta property="article:published_time" content="2026-01-02T00:00:00Z"><script>var x = "<b>";</script>
<style>p { color: red }</style></head><body><header><nav><a href="/home">Home</a></nav></header>
<main><article><h1>The Headline</h1><p>First paragraph with <strong>bold</strong>, <em>italic</em> and
<a href="/rel/link">a link</a>.</p><p>Second paragraph &amp; more. ${LONG}</p><ul><li>One</li><li>Two</li></ul>
<blockquote>A quote</blockquote><h4>Minor</h4><p>Tail <code>x = 1</code></p></article></main>
<footer><a href="https://example.com/footer">Footer link</a></footer></body></html>`,
  simple: `<html><head><title>Simple</title></head><body><p>Hello world, this is a simple page.</p>
<p>Another line with a <a href="https://other.example/page">link</a>.</p><br><hr><div>Div text</div></body></html>`,
  "no main region": `<html><body><nav>menu</nav><div><h2>Title Here</h2><p>Body text is short.</p></div>
<aside>side</aside><form><input name="q"></form><p>After the form.</p></body></html>`,
  "short article falls back to the page": `<html><body><article><p>Too short.</p></article><p>The rest of the page.</p></body></html>`,
  "links and entities": `<html><head><title>Links &amp; Things</title></head><body><p>Read <a href="/a">A</a>, <a href='https://b.example/b'>B</a>,
<a href="/a">A again</a>, <a href="http://127.0.0.1/admin">internal</a> and <a href="mailto:x@example.com">mail</a>.</p>
<p>Caf&#233; &mdash; 5 &lt; 6 &gt; 4 &quot;quoted&quot;</p></body></html>`,
};

for (const [name, html] of Object.entries(FIXTURES)) {
  test(`parity with the old extractor: ${name}`, () => {
    const old = legacyHtmlToCleanText(html, "https://example.com/base/");
    const now = htmlToCleanText(html, "https://example.com/base/");
    assert.ok(sameText(now.text, old.text), `text differs:\n--- old\n${old.text}\n--- new\n${now.text}`);
    assert.equal(now.author, old.author);
    assert.equal(now.publishedAt?.toISOString(), old.publishedAt?.toISOString());
    assert.deepEqual(now.links, old.links);
    // Titles now decode their entities once ("Links & Things", not "Links &amp; Things").
    assert.equal(now.title, old.title?.replace(/&amp;/g, "&"));
  });
}

// ── What the linear rewrite fixes ───────────────────────────────────────────

test("a nested <nav> is removed whole, not up to its first inner close", () => {
  const html = "<body><nav>outer <nav>inner</nav> outer tail</nav><p>Content stays.</p></body>";
  const { text } = htmlToCleanText(html);
  assert.equal(text, "Content stays.");
  assert.ok(!legacyHtmlToCleanText(html).text.startsWith("Content"), "the old extractor left the outer tail behind");
});

test("an unclosed opening tag strips nothing", () => {
  assert.match(htmlToCleanText("<body><nav>Menu that never closes<p>Real content.</p></body>").text, /Real content\./);
  assert.match(htmlToCleanText("<p>Before</p><script>not closed <p>After</p>").text, /Before[\s\S]*After/);
});

test("raw-text elements are dropped whole, and `<script …/>` still opens a script", () => {
  const html = '<p>Visible</p><script src="a.js"/>var hidden = 1;</script><style>.x{}</style><template><p>no</p></template><p>Also visible</p>';
  assert.equal(htmlToCleanText(html).text, "Visible\n\nAlso visible");
});

test("a new <a> ends an unclosed one, so no link swallows the next", () => {
  const html = '<p><a href="/one">first <a href="/two">second</a> <a href="/three">third</a></p>';
  const { links, text } = htmlToCleanText(html, "https://example.com/");
  assert.deepEqual(links.map((link: PageLink) => link.href), ["https://example.com/two", "https://example.com/three"]);
  assert.match(text, /\[second\]\(\/two\)/);
});

test("links are resolved, filtered, de-duplicated and capped", () => {
  const anchors = Array.from({ length: 200 }, (_, i) => `<a href="/p${i % 150}">p${i}</a>`).join(" ");
  const { links } = htmlToCleanText(`<p>${anchors} <a href="http://169.254.169.254/">meta</a></p>`, "https://example.com/");
  assert.equal(links.length, MAX_PAGE_LINKS);
  assert.equal(new Set(links.map((link) => link.href)).size, links.length);
  assert.ok(links.every((link) => !isDisallowedHost(link.href)));
  assert.deepEqual(htmlToCleanText(`<a href="/x">x</a>`).links, [], "no base URL, no links");
});

test("entities are decoded once", () => {
  assert.equal(htmlToCleanText("<p>&amp;lt;b&amp;gt; and &#x1F600; and &unknown;</p>").text, "&lt;b&gt; and 😀 and &unknown;");
});

test("shell markup is read linearly: framework root, JavaScript plea, noscript", () => {
  assert.equal(htmlToCleanText('<div id="root"></div>').shellMarkup, true);
  assert.equal(htmlToCleanText('<div id="__next">\n</div>').shellMarkup, true);
  assert.equal(htmlToCleanText("<p>Please enable JavaScript to continue.</p>").shellMarkup, true);
  assert.equal(htmlToCleanText("<noscript>This site needs JavaScript</noscript><p>x</p>").shellMarkup, true);
  assert.equal(htmlToCleanText('<div id="root"><p>Rendered on the server.</p></div>').shellMarkup, false);
  assert.equal(looksLikeShell(120, false), true, "too little text is a shell whatever the markup");
  assert.equal(looksLikeShell(2_000, false), false);
  const started = performance.now();
  htmlToCleanText(sized("<noscript>x", 2));
  assert.ok(performance.now() - started < 5_000, "the old noscript regex was quadratic on this");
});

// ── The document fetch around it (fake transport; no network) ──────────────

function respond(body: string | Uint8Array<ArrayBuffer>, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" }, ...init });
}

test("extractUrlDocument reports the hops, the final URL and the full length", async () => {
  const outcome = await extractUrlDocument("https://start.example/", undefined, {
    transport: async (url) =>
      url === "https://start.example/"
        ? new Response(null, { status: 301, headers: { location: "https://final.example/page" } })
        : respond(`<html><head><title>Final</title></head><body><p>${LONG}</p></body></html>`),
    maxChars: 100,
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.page.finalUrl, "https://final.example/page");
  assert.deepEqual(outcome.page.hops, ["https://start.example/", "https://final.example/page"]);
  assert.equal(outcome.page.text.length, 100);
  assert.ok((outcome.page.totalChars ?? 0) > 700);
  assert.equal(outcome.page.contentType, "html");
});

test("extractUrlDocument: chat's byte cap, type refusal and shell verdict are typed outcomes", async () => {
  const big = await extractUrlDocument("https://big.example/", undefined, {
    transport: async () => respond("x".repeat(2 * MB + 1)),
    maxHtmlBytes: 2 * MB,
  });
  assert.deepEqual(big, { ok: false, failure: { reason: "response_too_large", limitBytes: 2 * MB } });

  const image = await extractUrlDocument("https://img.example/cat", undefined, {
    transport: async () => respond(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  });
  assert.deepEqual(image, { ok: false, failure: { reason: "unsupported_content_type", contentType: "image/png" } });

  const shell = await extractUrlDocument("https://spa.example/", undefined, {
    transport: async () => respond('<html><body><div id="root"></div><script>app()</script></body></html>'),
  });
  assert.deepEqual(shell, { ok: false, failure: { reason: "empty_document", shell: true } });
});

test("extractUrlDocument: its own deadline is `timeout`, distinct from the caller's abort", async () => {
  const hang = (_url: string, _init: RequestInit, signal?: AbortSignal) =>
    new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  const timedOut = await extractUrlDocument("https://slow.example/", undefined, { transport: hang, timeoutMs: 50 });
  assert.deepEqual(timedOut, { ok: false, failure: { reason: "timeout" } });

  const controller = new AbortController();
  const cancelled = extractUrlDocument("https://slow.example/", controller.signal, { transport: hang, timeoutMs: 10_000 });
  controller.abort();
  const outcome = await cancelled;
  assert.equal(outcome.ok, false);
  assert.notEqual(!outcome.ok && outcome.failure.reason, "timeout");
});

test("the extractor modules keep server-only out of a test's import graph (harness rule 1)", () => {
  for (const file of ["src/lib/web/html-text.ts", "src/lib/web/extract.ts"]) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /^import "server-only";/m, file);
    assert.doesNotMatch(source, /^import [^;]*from "@\/lib\/(search\/search-engine|web-search|prisma|db)";/m, file);
  }
});
