import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
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
import { WorkAgentSession } from "../runner/agent-core/src/work/session.js";
import { WorkPlan } from "../runner/agent-core/src/work/plan.js";
import type { WorkApprovalRequest } from "../runner/agent-core/src/work/types.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderStreamEvent,
} from "../runner/agent-core/src/providers/types.js";
import {
  ALWAYS_CONFIRM_ACTIONS,
  approvalAsksUnder,
  requiresExplicitApproval,
  toolTier,
  WORK_PERMISSION_POLICIES,
} from "../runner/agent-core/src/work/types.js";
import {
  actionLabel,
  toolPastLabel,
  toolPresentLabel,
} from "@/components/work/work-vocabulary";
import {
  BROWSER_LAUNCH_ARGS,
  browserLaunchEnvironment,
  createWorkBrowser,
  sealedResponseHeaders,
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

function servedSite(extra: Record<string, string> = {}): ServedSite {
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
        // Through the same seal the executor puts every response through, so
        // what these pages are allowed to do to each other is what a real run's
        // pages are allowed to do to each other.
        headers: sealedResponseHeaders({ "content-type": "text/html; charset=utf-8" }),
        body: Buffer.from(body, "utf8"),
      });
      const served = extra[url.pathname];
      if (served !== undefined) return Promise.resolve(html(served));
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
  const searchBox = browserTool(inertDeps({ submitMethod: () => "get" }));
  const asks = (
    tool: ReturnType<typeof browserTool>,
    action: string,
    policy: (typeof WORK_PERMISSION_POLICIES)[number]
  ) => approvalAsksUnder(tool.actionFor({ action }), tool.riskFor({ action }), policy);

  // Reading is a GET, and `web_fetch` already does that under `safe`.
  assert.equal(asks(searchBox, "open", "conservative"), false);
  assert.equal(asks(searchBox, "read", "conservative"), false);
  // Pressing and typing change a page Juno does not own: Manual asks, Auto
  // does not.
  assert.equal(asks(searchBox, "click", "conservative"), true);
  assert.equal(asks(searchBox, "click", "balanced"), false);
  assert.equal(asks(searchBox, "type", "conservative"), true);
  assert.equal(asks(searchBox, "type", "balanced"), false);
  // A GET form is a query. Everything but Skip stops for it.
  assert.equal(searchBox.riskFor({ action: "submit" }), "command");
  assert.equal(asks(searchBox, "submit", "conservative"), true);
  assert.equal(asks(searchBox, "submit", "balanced"), true);
  assert.equal(asks(searchBox, "submit", "permissive"), false);
});

test("a form that is not a query asks under every mode, Skip included", () => {
  // The defect this closes: `command` is waved through by Skip, and the only
  // send this product ships is `work.browser.submit`. A run in Skip could buy
  // something on a website while the permissions page promised that buying
  // always asks.
  for (const method of ["post", null] as const) {
    const tool = browserTool(inertDeps({ submitMethod: () => method }));
    assert.equal(tool.riskFor({ action: "submit" }), "irreversible", String(method));
    for (const policy of WORK_PERMISSION_POLICIES) {
      assert.equal(
        approvalAsksUnder(tool.actionFor({ action: "submit" }), tool.riskFor({ action: "submit" }), policy),
        true,
        `${String(method)} under ${policy}`
      );
    }
    // `allowed_always` is keyed on the action name, and the floor is what stops
    // a grant taken on a search box covering a checkout later in the same run.
    assert.equal(
      requiresExplicitApproval(tool.actionFor({ action: "submit" }), tool.riskFor({ action: "submit" })),
      true
    );
  }
});

test("a submit on a page asking for a card is the purchase the floor names", () => {
  const tool = browserTool(inertDeps({ submitMethod: () => "get", pageTakesPayment: () => true }));
  // Even a GET form is a purchase here, and `work.browser.purchase` is on the
  // always-confirm list the permissions page renders — a floor entry nothing
  // could emit would be a promise the product makes and the runtime cannot keep.
  assert.equal(tool.actionFor({ action: "submit" }), "work.browser.purchase");
  assert.equal(tool.provenanceFor({ action: "submit" }).action, "work.browser.purchase");
  assert.ok(ALWAYS_CONFIRM_ACTIONS.includes(tool.actionFor({ action: "submit" })));
  for (const policy of WORK_PERMISSION_POLICIES) {
    assert.equal(
      approvalAsksUnder(tool.actionFor({ action: "submit" }), tool.riskFor({ action: "submit" }), policy),
      true
    );
  }
  assert.match(tool.summarize({ action: "submit" }), /^Buy something at/);
  // And a page with no card field on it is still an ordinary send.
  const plain = browserTool(inertDeps({ submitMethod: () => "get" }));
  assert.equal(plain.actionFor({ action: "submit" }), "work.browser.submit");
});

test("the browser is launched with an allowlisted environment, not the runner's", () => {
  // Playwright's default is `process.env`, and the runner process holds the
  // database URL, every provider key and the column-encryption key. Chromium
  // runs a page's scripts with `--no-sandbox`, so those would be one
  // /proc/<pid>/environ read away from a renderer compromise.
  const environment = browserLaunchEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/worker",
    DATABASE_URL: "postgres://user:password@db/juno",
    ANTHROPIC_API_KEY: "sk-secret",
    OPENAI_API_KEY: "sk-secret",
    TOKEN_ENCRYPTION_KEYS: "secret",
    CLOUD_CODE_SECRET: "secret",
  });

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, "/home/worker");
  for (const name of [
    "DATABASE_URL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "TOKEN_ENCRYPTION_KEYS",
    "CLOUD_CODE_SECRET",
  ]) {
    assert.equal(name in environment, false, `${name} reached the browser process`);
  }
  // An allowlist rather than a denylist, so the secret added to the runner next
  // month does not join it silently.
  assert.deepEqual(Object.keys(environment).sort(), ["HOME", "LANG", "PATH"]);
  for (const value of Object.values(environment)) {
    assert.doesNotMatch(value, /secret|password/);
  }
});

test("WebRTC is off at the launch line, because no route can refuse a peer connection", () => {
  const args = BROWSER_LAUNCH_ARGS.join(" ");
  assert.match(args, /--force-webrtc-ip-handling-policy=disable_non_proxied_udp/);
  assert.match(args, /RTCPeerConnection/);
});

test("a fulfilled response keeps the browser's own same-origin rule", () => {
  // Playwright's `Route.fulfill` invents `access-control-allow-origin: <the
  // requesting origin>` plus `access-control-allow-credentials: true` whenever
  // the origin server sent no allow-origin of its own. That makes every origin
  // readable from every other one inside this browser — with the run's cookies
  // attached — so a response with no CORS header of its own is given one that
  // matches nothing.
  const sealed = sealedResponseHeaders({
    "content-type": "text/html",
    "content-encoding": "gzip",
    "content-length": "812",
    "set-cookie": "session=1",
  });
  assert.equal(sealed["access-control-allow-origin"], "null");
  assert.equal("content-encoding" in sealed, false);
  assert.equal("content-length" in sealed, false);
  assert.equal(sealed["set-cookie"], "session=1");

  // A genuine CORS API said its own word on this and is left alone, whatever
  // case it spelled the header in.
  const api = sealedResponseHeaders({
    "content-type": "application/json",
    "Access-Control-Allow-Origin": "https://app.example.test",
  });
  assert.equal(api["Access-Control-Allow-Origin"], "https://app.example.test");
  assert.equal("access-control-allow-origin" in api, false);
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

test("the timeline has words for it, and the Mac has the same ones", () => {
  /*
   * `humanize` is the floor for a token no build knows, and work-vocabulary's
   * own rule is that a NAMED tool should never reach it — a run that opened a
   * web page would otherwise read "Browser" in the feed, which is an API name
   * printed at a person. The Swift mirror is checked in the same test because
   * the whole point of a shared vocabulary is that one action does not get two
   * names on two surfaces.
   */
  const name = browserTool(inertDeps()).spec.name;
  assert.equal(name, "browser");
  assert.equal(toolPresentLabel(name), "Using a web page");
  assert.equal(toolPastLabel(name), "Used a web page");
  assert.equal(actionLabel(name), "Use a web page");

  const swift = readFileSync(
    "native/Packages/JunoNativeKit/Sources/JunoWorkKit/JunoWorkVocabulary.swift",
    "utf8"
  );
  for (const phrase of ["Using a web page", "Used a web page", "Use a web page"]) {
    assert.ok(swift.includes(`case "${name}": return "${phrase}"`), `the Mac is missing "${phrase}"`);
  }
});

// ---------------------------------------------------------------------------
// What a standing "and stop asking" is allowed to cover
// ---------------------------------------------------------------------------

/** A provider that makes the calls in `script` and then stops. */
function scriptedProvider(script: Array<Record<string, unknown>>): ProviderAdapter {
  let callId = 0;
  return {
    id: "test",
    name: "Test Lab",
    defaultModel: "test-model",
    models: () => ["test-model"],
    capabilities: () => ({
      tools: true,
      vision: false,
      computerUse: false,
      reasoningLevels: [],
      maxContext: 100_000,
      streaming: true,
      mcp: false,
    }),
    async *stream(_request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      const input = script.shift();
      if (input === undefined) {
        yield { type: "text_delta", text: "Done." };
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      callId += 1;
      yield { type: "tool_call", id: `c${callId}`, name: "browser", input };
      yield { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

test("stopping asking about a search box does not authorise a checkout", async () => {
  /*
   * A standing allowance is keyed on the ACTION NAME, and every send this
   * browser makes is `work.browser.submit`. So the first "and stop asking" —
   * given on something as harmless as a search box, which is exactly where a
   * person would give it — used to cover every form submission on every site
   * for the rest of the run, including the one that buys something.
   *
   * What stops it is the floor being re-checked at the gate rather than only
   * when the grant is recorded: the same action name is `command` for a GET
   * form and `irreversible` for anything else, and the second is above the
   * floor whatever was granted for the first.
   */
  let method: "get" | "post" = "get";
  const tool = browserTool(
    inertDeps({
      submitMethod: () => method,
      submit: () => {
        // The second call is the checkout; the page under it has changed.
        method = "post";
        return Promise.resolve({
          ok: true as const,
          page: { url: "https://shop.test/", title: "Shop", html: "<p>ok</p>", elements: [] },
        });
      },
    })
  );

  const approvals: WorkApprovalRequest[] = [];
  const session = new WorkAgentSession({
    runId: "run-1",
    goal: "Find it and buy it.",
    provider: scriptedProvider([
      { action: "submit", ref: 1 },
      { action: "submit", ref: 2 },
    ]),
    model: "test-model",
    cwd: "/tmp",
    tools: [tool],
    plan: new WorkPlan([{ id: "s1", title: "Do it" }]),
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
    pricing: { inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 },
    approvalMode: "balanced",
    callbacks: {
      onEvent: () => {},
      askQuestion: () => Promise.resolve("no"),
      requestApproval: (request) => {
        approvals.push(request);
        return Promise.resolve("allowed_always");
      },
    },
  });

  const result = await session.run();
  assert.equal(result.state, "finished");
  assert.equal(approvals.length, 2, "the second send rode the first send's standing grant");
  assert.equal(approvals[0].risk, "command");
  assert.equal(approvals[1].risk, "irreversible");
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
      submitMethod: (target) => browser.submitMethod(target),
      pageTakesPayment: () => browser.pageTakesPayment(),
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

test("a page cannot open a socket of its own", { skip: NO_BROWSER }, async () => {
  /*
   * The claim this file's docblock makes, tested against the one channel that
   * does not go through `context.route` at all. A WebSocket handshake is not an
   * HTTP request as far as request routing is concerned, so before
   * `routeWebSocket` a page's own script could connect straight out of Chromium
   * — to a loopback port here, which is exactly the class of address the
   * executor's fetcher exists to refuse, and with no line of it in the
   * transcript.
   *
   * The page is served over http rather than https because a secure page may
   * not open a `ws://` socket at all, and a test that passed on mixed-content
   * policy would prove nothing about this leash.
   */
  const connections: string[] = [];
  const listener = net.createServer((socket) => {
    connections.push("a page reached this listener");
    socket.destroy();
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;

  const site = servedSite({
    "/socket": `<!doctype html><html><head><title>Socket</title></head><body>
<h1>Socket</h1>
<script>
  var ws = new WebSocket("ws://127.0.0.1:${port}/x");
  ws.onclose = function () { document.title = "closed"; };
  ws.onerror = function () { document.title = "closed"; };
</script>
</body></html>`,
  });
  const browser = createWorkBrowser({ fetchResource: site.fetchResource, executablePath: EXECUTABLE });
  try {
    const opened = await browser.open("http://example.test/socket");
    assert.equal(opened.ok, true, opened.ok ? "" : opened.message);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.deepEqual(connections, [], "Chromium opened a socket the executor never saw");
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("one origin cannot read another's answer", { skip: NO_BROWSER }, async () => {
  /*
   * The sentence the cookie argument rests on. The run's browser holds whatever
   * sessions the run signed into, and the tool's own description invites the
   * setup — "a login you already have a session for" — so a hostile page in a
   * browsing sequence that could read another origin's authenticated response
   * would be able to read every site the run is signed into and post the lot to
   * itself as an ordinary allowed fetch.
   *
   * Playwright waives that rule by default: `Route.fulfill` adds a permissive
   * `access-control-allow-origin` to any response whose origin server sent
   * none. The site here serves through `sealedResponseHeaders`, exactly as the
   * executor does, which is what puts it back.
   */
  const site = servedSite({
    "/hostile": `<!doctype html><html><head><title>Hostile</title></head><body>
<h1>Hostile</h1>
<script>
  fetch("http://bank.test/statement", { credentials: "include" })
    .then(function (response) { return response.text(); })
    .then(function (body) { document.title = "READ " + body; })
    .catch(function () { document.title = "REFUSED"; });
</script>
</body></html>`,
    "/statement": `<!doctype html><html><head><title>Statement</title></head><body>PRIVATE BALANCE</body></html>`,
  });
  const browser = createWorkBrowser({ fetchResource: site.fetchResource, executablePath: EXECUTABLE });
  try {
    const opened = await browser.open("http://hostile.test/hostile");
    assert.equal(opened.ok, true, opened.ok ? "" : opened.message);

    const deadline = Date.now() + 5_000;
    let title = "";
    while (Date.now() < deadline) {
      const state = await browser.read();
      title = state.ok ? state.page.title : "";
      if (title === "REFUSED" || title.startsWith("READ")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(title, "REFUSED", "the hostile page read another origin's body");
    // The request itself still went out — the browser's rule is about who may
    // READ the answer — so this also proves the refusal came from the policy
    // and not from the fetch never happening.
    assert.ok(site.requests.some((request) => request.url.includes("/statement")));
  } finally {
    await browser.close();
  }
});

test("the snapshot says how each form is sent, and whether the page wants a card", { skip: NO_BROWSER }, async () => {
  // What the risk ladder is graded on. A GET form is a query and stays cheap; a
  // page with a card field on it turns a submit into the purchase the floor
  // names, and both answers come from the DOM rather than from the model.
  const site = servedSite({
    "/checkout": `<!doctype html><html><head><title>Checkout</title></head><body>
<form action="/find" method="get"><input name="q"><button type="submit">Find</button></form>
<form action="/pay" method="post">
  <input name="cardNumber" autocomplete="cc-number">
  <button type="submit">Pay now</button>
</form>
</body></html>`,
  });
  const browser = createWorkBrowser({ fetchResource: site.fetchResource, executablePath: EXECUTABLE });
  try {
    const opened = await browser.open("https://shop.test/checkout");
    assert.ok(opened.ok, opened.ok ? "" : opened.message);
    const buttons = opened.ok ? opened.page.elements.filter((element) => element.submits) : [];
    assert.equal(buttons.length, 2);
    assert.equal(browser.submitMethod({ ref: buttons[0].ref }), "get");
    assert.equal(browser.submitMethod({ ref: buttons[1].ref }), "post");
    assert.equal(browser.pageTakesPayment(), true);
    // A target the snapshot never named answers null, which the runtime grades
    // as the worse case rather than the cheaper one.
    assert.equal(browser.submitMethod({ selector: "form" }), null);
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
