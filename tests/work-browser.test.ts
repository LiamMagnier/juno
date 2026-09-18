import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  MAX_BROWSER_TEXT_CHARS,
  blockedFetchTarget,
  browserAction,
  browserTool,
  formatBrowserPage,
  htmlToText,
  type BrowserToolDeps,
} from "../runner/agent-core/src/work/tools.js";
import {
  candidatesForIntent,
  evaluateTier,
} from "../runner/agent-core/src/work/tier.js";
import {
  approvalAsksUnder,
  toolTier,
  WORK_PERMISSION_POLICIES,
} from "../runner/agent-core/src/work/types.js";
import {
  createWorkBrowser,
  type BrowserResourceRequest,
  type BrowserResourceResult,
} from "@/lib/work/browser";

/*
 * The browser a cloud Work run drives.
 *
 * Two halves, and they fail in different ways. The declarations decide what the
 * session will let a call do before it happens — which rung, which risk, which
 * mode has to stop for it — and a wrong one produces a run that quietly submits
 * a form nobody was asked about. The driver decides what the page can reach,
 * and its failure is the one that matters most: Chromium is the only client in
 * this system that a hostile page can aim, so a request that leaves it without
 * passing the executor's own fetcher is an SSRF the transcript would not even
 * record.
 *
 * The live half needs a Chromium and skips without one, which is honest about
 * what it proves on a machine that has none rather than passing there.
 */

// ---------------------------------------------------------------------------
// An in-memory site, served exactly as the executor serves the real web
// ---------------------------------------------------------------------------

const INDEX = `<!doctype html><html><head><title>Example</title></head><body>
<h1>Quarterly filings</h1>
<p>The archive is public.</p>
<a href="/docs">Read the docs</a>
<form action="/search" method="post">
  <input name="q" placeholder="Search filings">
  <button type="submit">Search</button>
</form>
<script>
  // A page that goes looking for the worker's own metadata endpoint. Every
  // request Chromium makes has to come back through the executor, or this is
  // the request that reads an instance credential and posts it home.
  fetch("http://169.254.169.254/latest/meta-data/").catch(function () {});
</script>
</body></html>`;

const DOCS = `<!doctype html><html><head><title>Docs</title></head><body><h1>The docs</h1></body></html>`;

interface ServedSite {
  fetchResource(request: BrowserResourceRequest): Promise<BrowserResourceResult>;
  requests: BrowserResourceRequest[];
}

function servedSite(): ServedSite {
  const requests: BrowserResourceRequest[] = [];
  return {
    requests,
    fetchResource(request) {
      requests.push(request);
      // The real executor's first move, and the one that matters here: the
      // address check runs against every request the page makes, not only
      // against the URL the model asked for.
      const blocked = blockedFetchTarget(request.url);
      if (blocked) return Promise.resolve({ ok: false, message: `Juno will not open that: ${blocked}` });

      const url = new URL(request.url);
      const html = (body: string): BrowserResourceResult => ({
        ok: true,
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(body, "utf8"),
      });
      if (url.pathname === "/") return Promise.resolve(html(INDEX));
      if (url.pathname === "/docs") return Promise.resolve(html(DOCS));
      if (url.pathname === "/search") {
        const query = new URLSearchParams(request.body?.toString("utf8") ?? "").get("q") ?? "";
        return Promise.resolve(
          html(
            `<!doctype html><html><head><title>Results</title></head><body><h1>Results for ${query}</h1></body></html>`,
          ),
        );
      }
      return Promise.resolve({ ok: false, message: `${request.url} is not on this site.` });
    },
  };
}

/**
 * A Chromium this machine actually has.
 *
 * Deliberately not `playwright install`: the container these tests run in ships
 * its browsers under PLAYWRIGHT_BROWSERS_PATH and a test that downloads a
 * browser is a test that fails on a machine with no network.
 */
function chromiumExecutable(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium-")) continue;
    const candidate = path.join(root, entry, "chrome-linux", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const EXECUTABLE = chromiumExecutable();
const NO_BROWSER = EXECUTABLE ? false : "no Chromium is installed on this machine";

// ---------------------------------------------------------------------------
// What the session reads before it lets a call happen
// ---------------------------------------------------------------------------

/** A tool over a browser that is not there, for the declaration tests. */
function inertDeps(overrides: Partial<BrowserToolDeps> = {}): BrowserToolDeps {
  const nothing = () => Promise.resolve({ ok: false as const, message: "not called" });
  return {
    available: () => true,
    open: nothing,
    read: nothing,
    click: nothing,
    typeText: nothing,
    submit: nothing,
    currentUrl: () => "https://example.test/",
    ...overrides,
  };
}

test("every action it declares is an intent it declared it can serve", () => {
  const tool = browserTool(inertDeps());
  for (const action of ["open", "read", "click", "type", "submit"] as const) {
    const intent = tool.intentFor({ action });
    assert.ok(
      tool.intents.includes(intent),
      `${action} serves ${intent}, which the tool never declared`
    );
    // A tool on no rung is refused outright, which would make it a tool that
    // exists and can never be used.
    assert.notEqual(toolTier(tool.tier), Number.MAX_SAFE_INTEGER);
  }
  assert.equal(browserAction({}), "read", "the default is the action that changes nothing");
  assert.equal(browserAction({ action: "nonsense" }), "read");
});

test("sending a form is the rung that stops for the user", () => {
  const tool = browserTool(inertDeps());
  const asks = (action: string, policy: (typeof WORK_PERMISSION_POLICIES)[number]) =>
    approvalAsksUnder(tool.actionFor({ action }), tool.riskFor({ action }), policy);

  // Reading is a GET, and `web_fetch` already does that under `safe`.
  assert.equal(asks("open", "conservative"), false);
  assert.equal(asks("read", "conservative"), false);
  // Pressing and typing change a page Juno does not own: Manual asks, Auto
  // does not.
  assert.equal(asks("click", "conservative"), true);
  assert.equal(asks("click", "balanced"), false);
  assert.equal(asks("type", "conservative"), true);
  assert.equal(asks("type", "balanced"), false);
  // Submitting sends something. Everything but Skip stops for it.
  assert.equal(asks("submit", "conservative"), true);
  assert.equal(asks("submit", "balanced"), true);
  assert.equal(asks("submit", "permissive"), false);
});

test("what it returns is never trusted, whatever the action", () => {
  const tool = browserTool(inertDeps());
  for (const action of ["open", "read", "click", "type", "submit"] as const) {
    const provenance = tool.provenanceFor({ action, url: "https://example.test/" });
    assert.equal(provenance.trust, "untrusted");
    assert.equal(provenance.sourceKind, "web");
    // The source is a URL a reader can go and check, never a bare word.
    assert.match(provenance.source, /^https:\/\/example\.test\//);
  }
});

test("it loses to a connector for the same intent, and beats nothing it does not", () => {
  const tool = browserTool(inertDeps());
  // Nothing else declares browser.read today, so the browser is allowed.
  const alone = evaluateTier({
    intent: "browser.read",
    chosen: "browser",
    candidates: candidatesForIntent([tool], "browser.read"),
  });
  assert.equal(alone.allowed, true);

  // And a browser whose process failed to start is refused with a reason
  // rather than left to fail on every call.
  const dead = browserTool(inertDeps({ available: () => false }));
  const refused = evaluateTier({
    intent: "browser.read",
    chosen: "browser",
    candidates: candidatesForIntent([dead], "browser.read"),
  });
  assert.equal(refused.allowed, false);
});

test("it refuses an address that is not on the web before it starts a browser", async () => {
  let opened = 0;
  const tool = browserTool(inertDeps({ open: () => { opened += 1; return Promise.resolve({ ok: false, message: "x" }); } }));

  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "http://localhost:3000/",
    "https://user:pass@example.test/",
  ]) {
    const result = await tool.execute({ action: "open", url }, { cwd: "/tmp" });
    assert.equal(result.isError, true, url);
    assert.match(result.output, /Juno will not open that/);
  }
  assert.equal(opened, 0, "none of them reached the browser");
});

test("a skill's egress grant narrows what it may open", async () => {
  const tool = browserTool(
    inertDeps({
      allowedDomains: () => ["docs.example.test"],
      open: () => Promise.resolve({ ok: false, message: "should not be reached" }),
    })
  );

  const refused = await tool.execute({ action: "open", url: "https://elsewhere.test/" }, { cwd: "/tmp" });
  assert.equal(refused.isError, true);
  assert.match(refused.output, /for this skill/);
});

test("a deployment with no browser says so instead of failing per call", async () => {
  const tool = browserTool(inertDeps({ available: () => false }));
  const result = await tool.execute({ action: "open", url: "https://example.test/" }, { cwd: "/tmp" });
  assert.equal(result.isError, true);
  assert.match(result.output, /No browser is available/);
  assert.match(result.output, /web_fetch/, "it names what to do instead");
});

test("a page is text plus the things that can be done to it", () => {
  const formatted = formatBrowserPage(
    {
      url: "https://example.test/",
      title: "Example",
      html: INDEX,
      elements: [
        { ref: 1, role: "link", label: "Read the docs", href: "/docs" },
        { ref: 2, role: "textbox", label: "Search filings" },
        { ref: 3, role: "button", label: "Search", submits: true },
      ],
    },
    htmlToText(INDEX)
  );

  assert.match(formatted, /URL: https:\/\/example\.test\//);
  assert.match(formatted, /\[1\] link "Read the docs" → \/docs/);
  assert.match(formatted, /\[3\] button "Search" \(sends the form/);
  // The script's contents are not the article, and `htmlToText` is what keeps
  // them out of the model's context.
  assert.doesNotMatch(formatted, /169\.254\.169\.254/);
});

test("a page longer than the cap says where it was cut", () => {
  const long = "word ".repeat(MAX_BROWSER_TEXT_CHARS);
  const formatted = formatBrowserPage(
    { url: "https://example.test/", title: "Long", html: "", elements: [] },
    long
  );
  assert.match(formatted, /Cut off here/);
  assert.ok(formatted.length < long.length);
});

// ---------------------------------------------------------------------------
// The driver, against a real browser
// ---------------------------------------------------------------------------

test("the driver satisfies the deps the runtime declares", { skip: NO_BROWSER }, async () => {
  const site = servedSite();
  const browser = createWorkBrowser({ fetchResource: site.fetchResource, executablePath: EXECUTABLE });
  try {
    // This is the drift check. `browserTool` takes `BrowserToolDeps`, and the
    // driver's own shapes are declared separately because src/ cannot import
    // the vendored runner — so the compiler comparing them HERE is what keeps
    // the two copies honest.
    const tool = browserTool({
      available: () => browser.available(),
      open: (url) => browser.open(url),
      read: () => browser.read(),
      click: (target) => browser.click(target),
      typeText: (target, text) => browser.typeText(target, text),
      submit: (target) => browser.submit(target),
      currentUrl: () => browser.currentUrl(),
    });

    const result = await tool.execute({ action: "open", url: "https://example.test/" }, { cwd: "/tmp" });
    assert.equal(result.isError, undefined, result.output);
    assert.match(result.output, /Quarterly filings/);
    assert.match(result.output, /\[\d+\] link "Read the docs"/);
    assert.match(result.output, /sends the form/, "the submit button is named as one");
  } finally {
    await browser.close();
  }
});

test("nothing the page asks for reaches the network by itself", { skip: NO_BROWSER }, async () => {
  const site = servedSite();
  const browser = createWorkBrowser({ fetchResource: site.fetchResource, executablePath: EXECUTABLE });
  try {
    const opened = await browser.open("https://example.test/");
    assert.equal(opened.ok, true);

    // The page's own script went looking for the metadata endpoint. It has to
    // have arrived here — at the executor's fetcher, which refused it — rather
    // than at a socket Chromium opened.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (site.requests.some((request) => request.url.includes("169.254.169.254"))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const metadata = site.requests.filter((request) => request.url.includes("169.254.169.254"));
    assert.equal(metadata.length, 1, "the page's fetch came through the executor");
    assert.equal(metadata[0].isNavigation, false);
  } finally {
    await browser.close();
  }
});

test("a link is followed; a submit button is not a click", { skip: NO_BROWSER }, async () => {
  const site = servedSite();
  const browser = createWorkBrowser({ fetchResource: site.fetchResource, executablePath: EXECUTABLE });
  try {
    const opened = await browser.open("https://example.test/");
    assert.ok(opened.ok);
    const link = opened.ok
      ? opened.page.elements.find((element) => element.role === "link")
      : undefined;
    const button = opened.ok
      ? opened.page.elements.find((element) => element.submits)
      : undefined;
    assert.ok(link && button, "the snapshot named both");

    // The structural half of the approval ladder: the browser refuses to press
    // a form's own button through the action whose risk is not `command`.
    const refused = await browser.click({ ref: button.ref });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.message, /action "submit"/);

    const followed = await browser.click({ ref: link.ref });
    assert.ok(followed.ok);
    assert.equal(followed.ok ? followed.page.url : "", "https://example.test/docs");
    assert.match(followed.ok ? followed.page.html : "", /The docs/);
  } finally {
    await browser.close();
  }
});

test("typing then submitting sends the form the page declared", { skip: NO_BROWSER }, async () => {
  const site = servedSite();
  const browser = createWorkBrowser({ fetchResource: site.fetchResource, executablePath: EXECUTABLE });
  try {
    const opened = await browser.open("https://example.test/");
    assert.ok(opened.ok);
    const field = opened.ok
      ? opened.page.elements.find((element) => element.role === "textbox")
      : undefined;
    const button = opened.ok
      ? opened.page.elements.find((element) => element.submits)
      : undefined;
    assert.ok(field && button);

    const typed = await browser.typeText({ ref: field.ref }, "dividends");
    assert.ok(typed.ok);

    const submitted = await browser.submit({ ref: button.ref });
    assert.ok(submitted.ok, submitted.ok ? "" : submitted.message);
    assert.match(submitted.ok ? submitted.page.html : "", /Results for dividends/);

    const post = site.requests.find((request) => request.method === "POST");
    assert.ok(post, "the form was sent as the page said to send it");
    assert.match(post.body?.toString("utf8") ?? "", /q=dividends/);
  } finally {
    await browser.close();
  }
});

test("a ref from a page that has moved on is refused, not guessed at", { skip: NO_BROWSER }, async () => {
  const site = servedSite();
  const browser = createWorkBrowser({ fetchResource: site.fetchResource, executablePath: EXECUTABLE });
  try {
    await browser.open("https://example.test/");
    const result = await browser.click({ ref: 99 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /nothing numbered 99/);
  } finally {
    await browser.close();
  }
});

test("a browser that cannot start reports itself unavailable once", async () => {
  const site = servedSite();
  const browser = createWorkBrowser({
    fetchResource: site.fetchResource,
    executablePath: "/nonexistent/chrome",
  });
  try {
    assert.equal(browser.available(), true, "optimistic until it has tried");
    const result = await browser.open("https://example.test/");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /could not start a browser/);
    // From here the tier layer refuses the tool and names the alternative,
    // rather than every call failing separately.
    assert.equal(browser.available(), false);
  } finally {
    await browser.close();
  }
});
