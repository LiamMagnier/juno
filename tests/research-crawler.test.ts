import test from "node:test";
import assert from "node:assert/strict";
import {
  isPotentialSpa,
  renderHeadlessPage,
  crawlResearchPage,
} from "@/lib/research/crawler";

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

