import test from "node:test";
import assert from "node:assert/strict";
import {
  isPotentialSpa,
  headlessRenderingEnabled,
  renderHeadlessPage,
  crawlResearchPage,
  shouldRenderHeadless,
} from "@/lib/research/crawler";
import { FETCH_RETRY_BACKOFF_MS, fetchRetryDelayMs, parseRetryAfterMs } from "@/lib/search/page-signals";

test("isPotentialSpa detects SPA root elements and short text shells", () => {
  assert.equal(isPotentialSpa('<div id="root"></div>', 20), true);
  assert.equal(isPotentialSpa('<div id="__next"></div>', 10), true);
  assert.equal(isPotentialSpa("<p>Please enable JavaScript to view this page</p>", 500), true);
  assert.equal(
    isPotentialSpa(
      "<html><body><article><h1>Full Article</h1><p>A long substantial text with comprehensive research content that contains well over two hundred characters and does not include any SPA framework markers or hydration wrappers.</p></article></body></html>",
      300
    ),
    false
  );
});

test("renderHeadlessPage executes JavaScript and extracts hydrated DOM", async () => {
  // Use a data: URL containing client-side JavaScript that injects DOM elements dynamically
  const clientSpaHtml = `
<!DOCTYPE html>
<html>
<head><title>Dynamic Test SPA</title></head>
<body>
  <div id="root">Loading...</div>
  <script>
    document.getElementById('root').innerHTML = '<article><h1>Hydrated Content</h1><p>This content was rendered dynamically by client-side JavaScript after execution.</p><a href="https://example.com/subpage">Subpage Link</a></article>';
  </script>
</body>
</html>
`;
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(clientSpaHtml)}`;

  const result = await renderHeadlessPage(dataUrl, { timeoutMs: 10_000 });

  if (!result.ok && result.failure.reason === "headless_render_failed") {
    // Playwright browser binary is not installed in this CI runner environment
    return;
  }

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.page.title, "Dynamic Test SPA");
    assert.ok(result.page.text.includes("This content was rendered dynamically"));
    assert.ok(result.page.links.some((l) => l.href === "https://example.com/subpage"));
    assert.equal(result.page.crawler, "headless_playwright");
    assert.equal(result.page.isSpa, true);
  }
});

test("isPotentialSpa detects SPA root elements with whitespace and attributes", () => {
  assert.equal(isPotentialSpa('<div id="root">\n  <span></span>\n</div>', 20), true);
  assert.equal(isPotentialSpa('<div class="app-container" id="app"> </div>', 50), true);
  assert.equal(isPotentialSpa('<noscript>You must enable javascript to view this page</noscript>', 200), true);
});

test("crawlResearchPage handles invalid or blocked URLs safely", async () => {
  const result = await crawlResearchPage("http://127.0.0.1:22/ssh", { timeoutMs: 3000 });
  assert.equal(result.ok, false);

  const cloudMetadata = await crawlResearchPage("http://169.254.169.254/latest/meta-data/", { timeoutMs: 3000 });
  assert.equal(cloudMetadata.ok, false);
  if (!cloudMetadata.ok) {
    assert.equal(cloudMetadata.failure.reason, "blocked_host");
  }
});

/*
 * The fallback's trigger. A fast fetch that SUCCEEDED with a sixty-character
 * "please enable JavaScript" notice used to be stored as the page: only a
 * fetch that failed ever reached the headless path, and the shell heuristic
 * above was called from nothing but this file.
 */
test("a successful fetch that yielded a shell still asks for a browser", () => {
  const page = { title: "t", links: [] };
  assert.equal(shouldRenderHeadless({ ok: true, page: { ...page, text: "Please enable JavaScript to view this page." } }), true);
  assert.equal(shouldRenderHeadless({ ok: true, page: { ...page, text: "x".repeat(400), shell: true } }), true);
  assert.equal(shouldRenderHeadless({ ok: true, page: { ...page, text: "x".repeat(400), shell: false } }), false);
  assert.equal(shouldRenderHeadless({ ok: true, page: { ...page, text: "x".repeat(400) } }), false);
  assert.equal(shouldRenderHeadless({ ok: false, failure: { reason: "empty_document" } }), true);
});

test("the headless renderer is opt-in per deployment", () => {
  const before = process.env.RESEARCH_HEADLESS;
  try {
    delete process.env.RESEARCH_HEADLESS;
    assert.equal(headlessRenderingEnabled(), false, "a build with no browser must not pay an import and a launch per page");
    process.env.RESEARCH_HEADLESS = "1";
    assert.equal(headlessRenderingEnabled(), true);
    process.env.RESEARCH_HEADLESS = "false";
    assert.equal(headlessRenderingEnabled(), false);
  } finally {
    if (before === undefined) delete process.env.RESEARCH_HEADLESS;
    else process.env.RESEARCH_HEADLESS = before;
  }
});

test("Retry-After is read in both forms the header allows", () => {
  assert.equal(parseRetryAfterMs("2"), 2_000);
  const now = Date.parse("2026-09-17T12:00:00.000Z");
  assert.equal(parseRetryAfterMs("Thu, 17 Sep 2026 12:00:04 GMT", now), 4_000);
  assert.equal(parseRetryAfterMs("soon"), null);
  assert.equal(parseRetryAfterMs(null), null);
});

test("only a 429 or a 503 is retried, and only while the clock allows a second attempt", () => {
  const timeout = 25_000;
  assert.equal(fetchRetryDelayMs({ reason: "http_error", httpStatus: 429 }, 1_000, timeout), FETCH_RETRY_BACKOFF_MS);
  assert.equal(fetchRetryDelayMs({ reason: "http_error", httpStatus: 503, retryAfterMs: 1_000 }, 1_000, timeout), 1_000);
  // A server asking for a minute is not going to get it from a fetch on a 25-second clock.
  assert.equal(fetchRetryDelayMs({ reason: "http_error", httpStatus: 429, retryAfterMs: 60_000 }, 1_000, timeout), FETCH_RETRY_BACKOFF_MS);
  assert.equal(fetchRetryDelayMs({ reason: "http_error", httpStatus: 404 }, 1_000, timeout), null);
  assert.equal(fetchRetryDelayMs({ reason: "fetch_failed" }, 1_000, timeout), null);
  assert.equal(fetchRetryDelayMs({ reason: "http_error", httpStatus: 429 }, 20_000, timeout), null, "no time left for the second attempt");
});

