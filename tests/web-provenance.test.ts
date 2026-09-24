import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { ExtractOptions, ExtractOutcome } from "@/lib/web/extract";
import { fetchPageForChat, type FetchPageDeps } from "@/lib/web/fetch-page";
import {
  FETCH_DISABLED_LINE,
  NOT_IN_PRIOR_CONTEXT_TEXT,
  RATE_LIMITED_TEXT,
  URL_NOT_ALLOWED_TEXT,
} from "@/lib/web/fetch-page.prompt";
import { createTurnWebLimits, UserWebCounters } from "@/lib/web/limits";
import {
  buildUrlLedger,
  createLazyUrlLedger,
  historySourceCounts,
  UrlLedger,
  type LedgerHistoryPort,
  type LedgerTurnInput,
} from "@/lib/web/provenance";
import { TurnTaint } from "@/lib/web/taint";
import { setWebAuditSink, webTurnState, type WebAuditEvent } from "@/lib/web/turn-state";
import type { LazyUrlLedger, TurnWebLimits } from "@/lib/web/types";
import { canonicalize, extractUrlCandidates, matches, trimTrailingPunctuation } from "@/lib/web/url-canon";

/*
 * The provenance rule (SPEC §6.2): `web_fetch` opens a URL only if it appeared
 * verbatim — up to benign normalisation — in something the user typed or the
 * model was shown. The one property everything here protects: a candidate may
 * DROP information from a URL it saw, never ADD or CHANGE any, because an added
 * `?d=<secret>` is how a page turns a fetch into an exfiltration.
 */

const root = process.cwd();

// ── canonicalize / matches ────────────────────────────────────────────────────

function canon(raw: string, bareDomain = false) {
  const c = canonicalize(raw, { bareDomain });
  assert.ok(c, `${raw} should canonicalize`);
  return c;
}

test("canonicalize applies only benign normalisation", () => {
  const c = canon("<HTTPS://WWW.Example.COM./a/%7Euser/b/?y=2&x=1#frag>.");
  assert.equal(c.scheme, "https:");
  assert.equal(c.host, "example.com");
  assert.equal(c.path, "/a/~user/b");
  assert.deepEqual(c.params, ["x=1", "y=2"]);
  assert.equal(canon("https://example.com").path, "/");
  // Encoded reserved characters keep their meaning (upper-cased, never decoded).
  assert.equal(canon("https://example.com/a%2fb").path, "/a%2Fb");
  assert.equal(canon("https://example.com/?q=a&amp;r=b").params.join("&"), "q=a&r=b");
});

test("canonicalize refuses what can never be fetched", () => {
  for (const raw of ["ftp://example.com/x", "javascript:alert(1)", "https://user:pw@example.com/", "not a url", ""]) {
    assert.equal(canonicalize(raw, { bareDomain: true }), null, raw);
  }
  assert.equal(canonicalize(`https://example.com/${"a".repeat(2_100)}`, { bareDomain: false }), null, "over 2,048 characters");
});

test("bare domains count only where the caller allows them", () => {
  assert.equal(canonicalize("example.com/guide", { bareDomain: false }), null);
  assert.equal(canon("example.com/guide", true).raw, "https://example.com/guide");
  // Version numbers and decimals are not hosts.
  assert.equal(canonicalize("v1.2.3", { bareDomain: true }), null);
  assert.equal(canonicalize("3.14", { bareDomain: true }), null);
});

test("trailing punctuation is prose unless it balances the URL", () => {
  assert.equal(trimTrailingPunctuation("https://example.com/a)."), "https://example.com/a");
  assert.equal(
    trimTrailingPunctuation("https://en.wikipedia.org/wiki/Mercury_(planet))"),
    "https://en.wikipedia.org/wiki/Mercury_(planet)",
  );
  assert.equal(trimTrailingPunctuation('https://example.com/x",'), "https://example.com/x");
});

test("matches: drop is allowed, add or change is not", () => {
  const entry = canon("http://example.com/report?id=7&lang=en");
  assert.ok(matches(canon("http://example.com/report?id=7&lang=en"), entry), "identical");
  assert.ok(matches(canon("https://example.com/report?id=7"), entry), "https upgrade, a parameter dropped");
  assert.ok(matches(canon("http://www.example.com/report/?lang=en&id=7#top"), entry), "www, slash, order, fragment");
  assert.ok(!matches(canon("http://example.com/report?id=7&lang=en&d=secret"), entry), "a parameter added");
  assert.ok(!matches(canon("http://example.com/report?id=8"), entry), "a parameter changed");
  assert.ok(!matches(canon("http://example.com/report/extra"), entry), "a path extended");
  assert.ok(!matches(canon("http://example.com:8443/report?id=7"), entry), "another port");
  assert.ok(!matches(canon("http://evil.example.com/report?id=7"), entry), "another host");
  const httpsEntry = canon("https://example.com/report");
  assert.ok(!matches(canon("http://example.com/report"), httpsEntry), "never a downgrade to http");
});

test("the site root of a host on the ledger is allowed (DECISIONS §4c)", () => {
  const entry = canon("https://docs.example.com/guide/install?v=2");
  assert.ok(matches(canon("https://docs.example.com/"), entry));
  assert.ok(!matches(canon("https://docs.example.com/?q=1"), entry), "the root, but with a parameter added");
  assert.ok(!matches(canon("https://docs.example.com/guide"), entry), "an ancestor path other than the root");
  assert.ok(!matches(canon("https://example.com/"), entry), "the parent domain is another host");
});

test("URL extraction from text is linear and finds URLs in prose", () => {
  const text = "See https://example.com/a), (https://b.example/x?y=1) and <https://c.example/>. Also example.org/docs.";
  assert.deepEqual(extractUrlCandidates(text, { bareDomain: false }), [
    "https://example.com/a",
    "https://b.example/x?y=1",
    "https://c.example/",
  ]);
  assert.ok(extractUrlCandidates(text, { bareDomain: true }).includes("example.org/docs"));
  // No email address is a bare domain.
  assert.deepEqual(extractUrlCandidates("mail me at person@example.com", { bareDomain: true }), []);
  const hostile = "a.".repeat(200_000);
  const started = performance.now();
  extractUrlCandidates(hostile, { bareDomain: true });
  assert.ok(performance.now() - started < 2_000, "400k characters of dotted text must not backtrack");
});

// ── The ledger ────────────────────────────────────────────────────────────────

test("ledger kinds: user class wins, and bare domains come only from what the user typed", () => {
  const ledger = new UrlLedger();
  ledger.add("https://example.com/page", "search_result");
  ledger.addText("please read example.com/page", "user_message");
  assert.deepEqual(ledger.match("https://example.com/page"), { kind: "user_message", userClass: true });

  ledger.addText("my site is mysite.org and https://blog.mysite.org/post", "user_memory");
  assert.equal(ledger.match("https://mysite.org/"), null, "memory contributes URLs, not bare domains");
  assert.deepEqual(ledger.match("https://blog.mysite.org/post"), { kind: "user_memory", userClass: true });

  ledger.addText("an attachment names attacker.example and https://files.example/doc", "attachment");
  assert.equal(ledger.match("https://attacker.example/"), null, "outside text never contributes a bare domain");
  assert.deepEqual(ledger.match("https://files.example/doc"), { kind: "attachment", userClass: false });
});

test("the untrusted cap evicts oldest first and never evicts what the user typed", () => {
  const ledger = new UrlLedger(3);
  ledger.addText("https://user.example/typed", "user_message");
  for (let i = 0; i < 5; i += 1) ledger.add(`https://site${i}.example/`, "search_result");
  assert.equal(ledger.match("https://site0.example/"), null);
  assert.equal(ledger.match("https://site1.example/"), null);
  assert.ok(ledger.match("https://site4.example/"));
  assert.ok(ledger.match("https://user.example/typed"));
  assert.deepEqual(ledger.size, { user: 1, untrusted: 3 });
});

test("buildUrlLedger: every §6.2.1 source, grounding URLs skipped", async () => {
  const calls: string[] = [];
  const history: LedgerHistoryPort = {
    async userTexts(conversationId, limit) {
      calls.push(`users:${conversationId}:${limit}`);
      return ["an older message linking https://older.example/a"];
    },
    async assistantSources(conversationId, limit) {
      calls.push(`sources:${conversationId}:${limit}`);
      return [
        { model: "anthropic:claude", sources: [{ url: "https://cited.example/x", origin: "juno_search" }] },
        { model: "google:gemini-3", sources: [{ url: "https://vertexaisearch.example/redirect/1", origin: "provider_grounding" }] },
        { model: "google:gemini-2.5", sources: [{ url: "https://legacy-grounding.example/r" }] },
        { model: "openai:gpt", sources: [{ url: "https://legacy.example/ok" }] },
      ];
    },
  };
  const input: LedgerTurnInput = {
    userId: "u1",
    conversationId: "c1",
    private: false,
    userTexts: ["look at docs.example.com"],
    memoryTexts: ["favourite: https://memory.example/"],
    attachmentTexts: ["see https://attached.example/file"],
    toolNoteUrls: ["https://note.example/page"],
    researchSourceUrls: ["https://research.example/paper"],
    history,
  };
  const ledger = await buildUrlLedger(input);
  assert.deepEqual(calls, ["users:c1:200", "sources:c1:200"]);
  const kinds = (url: string) => ledger.match(url)?.kind ?? null;
  assert.equal(kinds("https://docs.example.com/"), "user_message");
  assert.equal(kinds("https://memory.example/"), "user_memory");
  assert.equal(kinds("https://older.example/a"), "user_message");
  assert.equal(kinds("https://cited.example/x"), "search_result");
  assert.equal(kinds("https://legacy.example/ok"), "search_result");
  assert.equal(kinds("https://vertexaisearch.example/redirect/1"), null, "provider_grounding never counts");
  assert.equal(kinds("https://legacy-grounding.example/r"), null, "a legacy Gemini row's sources never count");
  assert.equal(kinds("https://attached.example/file"), "attachment");
  assert.equal(kinds("https://note.example/page"), "tool_note");
  assert.equal(kinds("https://research.example/paper"), "research_source");
});

test("historySourceCounts is the grounding rule on its own", () => {
  assert.equal(historySourceCounts({ model: "google:x", sources: [] }, { url: "https://a.example", origin: "juno_fetch" }), true);
  assert.equal(historySourceCounts({ model: null, sources: [] }, { url: "https://a.example", origin: "provider_grounding" }), false);
});

test("a private chat builds its ledger with no database read (INV-32)", async () => {
  const history: LedgerHistoryPort = {
    userTexts: async () => assert.fail("a private chat read USER rows"),
    assistantSources: async () => assert.fail("a private chat read assistant rows"),
  };
  const ledger = await buildUrlLedger({
    userId: "u1",
    conversationId: null,
    private: true,
    userTexts: ["https://private.example/"],
    memoryTexts: [],
    attachmentTexts: [],
    toolNoteUrls: [],
    researchSourceUrls: [],
    history,
  });
  assert.ok(ledger.match("https://private.example/"));
});

test("the lazy ledger builds once, on the first match, and keeps in-turn additions", async () => {
  let builds = 0;
  const lazy = createLazyUrlLedger(async () => {
    builds += 1;
    const ledger = new UrlLedger();
    ledger.addText("https://typed.example/", "user_message");
    return ledger;
  });
  lazy.add("https://result.example/a", "search_result");
  assert.equal(lazy.built, false, "a turn that never fetches never builds");
  const [a, b] = await Promise.all([lazy.match("https://typed.example/"), lazy.match("https://result.example/a")]);
  assert.equal(builds, 1);
  assert.equal(a?.kind, "user_message");
  assert.equal(b?.kind, "search_result");
  lazy.add("https://later.example/", "fetched_page");
  assert.equal((await lazy.match("https://later.example/"))?.kind, "fetched_page");
});

test("a failed build narrows what can be opened and never throws", async () => {
  const lazy = createLazyUrlLedger(async () => {
    throw new Error("database down");
  });
  lazy.add("https://in-turn.example/", "search_result");
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await lazy.match("https://anything.example/"), null);
    assert.ok(await lazy.match("https://in-turn.example/"));
  } finally {
    console.warn = warn;
  }
});

// ── Refusal codes and the enumeration guard ───────────────────────────────────

const PAGE_TEXT = "A readable page about the topic, long enough to count as a document. ".repeat(4);

function page(url: string): ExtractOutcome {
  return {
    ok: true,
    page: {
      title: "A page",
      text: PAGE_TEXT,
      links: [{ href: "https://linked.example/next", text: "next" }],
      finalUrl: url,
      hops: [url],
      contentType: "html",
      totalChars: PAGE_TEXT.length,
    },
  };
}

function harness(opts: { typed?: string[]; results?: string[]; roundBudget?: number } = {}) {
  const ledger = new UrlLedger();
  for (const text of opts.typed ?? []) ledger.addText(text, "user_message");
  for (const url of opts.results ?? []) ledger.add(url, "search_result");
  const limits = createTurnWebLimits({
    roundBudget: opts.roundBudget ?? 10,
    userId: "u1",
    userCounters: new UserWebCounters(),
  });
  const taint = new TurnTaint({ staticContent: false });
  const fetched: string[] = [];
  const deps: FetchPageDeps = {
    ownHosts: new Set(["chat.juno.example"]),
    now: () => new Date("2026-09-24T12:00:00Z"),
    extract: async (url: string, _signal: AbortSignal | undefined, _opts: ExtractOptions) => {
      fetched.push(url);
      return page(url);
    },
  };
  const ctx = { ledger: ledger as LazyUrlLedger, taint, limits, signal: new AbortController().signal, private: false };
  return { ledger, limits, taint, fetched, deps, ctx };
}

test("a link nobody showed the model is refused before any network activity", async () => {
  const h = harness({ results: ["https://example.com/report?id=7"] });
  const refused = await fetchPageForChat({ url: "https://example.com/report?id=7&d=secret" }, h.ctx, h.deps);
  assert.equal(refused.status, "failed");
  assert.equal(refused.error?.code, "url_not_in_prior_context");
  assert.equal(refused.text, NOT_IN_PRIOR_CONTEXT_TEXT);
  assert.equal(refused.web, undefined, "a refusal records no URL");
  assert.deepEqual(h.fetched, []);

  const opened = await fetchPageForChat({ url: "https://example.com/report?id=7" }, h.ctx, h.deps);
  assert.equal(opened.status, "succeeded");
  assert.deepEqual(h.fetched, ["https://example.com/report?id=7"]);
});

test("every refusal code of §6.2.5 that needs no network", async () => {
  const typed = [
    "https://chat.juno.example/api/me http://example.com:8080/admin https://10.0.0.1/ https://user:pw@example.com/",
    `https://example.com/${"x".repeat(2_100)}`,
  ];
  const cases: Array<[string, string]> = [
    ["ftp://example.com/file", "url_not_allowed"],
    ["https://chat.juno.example/api/me", "url_not_allowed"],
    ["http://example.com:8080/admin", "url_not_allowed"],
    ["https://10.0.0.1/", "url_not_allowed"],
    ["https://user:pw@example.com/", "url_not_allowed"],
    [`https://example.com/${"x".repeat(2_100)}`, "url_too_long"],
  ];
  for (const [url, code] of cases) {
    const h = harness({ typed });
    const outcome = await fetchPageForChat({ url }, h.ctx, h.deps);
    assert.equal(outcome.error?.code, code, url);
    assert.deepEqual(h.fetched, [], `${url} reached the network`);
  }
  const h = harness({ typed });
  assert.equal((await fetchPageForChat({ url: "https://chat.juno.example/api/me" }, h.ctx, h.deps)).text, URL_NOT_ALLOWED_TEXT);
});

test("per-turn and per-host limits refuse with rate_limited, and refusals count", async () => {
  const h = harness({ results: ["https://one.example/a"], roundBudget: 4 });
  // Budget 4: 4 fetches a turn, 3 per host. Refusals spend the call budget too.
  assert.equal((await fetchPageForChat({ url: "https://nowhere.example/" }, h.ctx, h.deps)).error?.code, "url_not_in_prior_context");
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await fetchPageForChat({ url: "https://one.example/a" }, h.ctx, h.deps)).status, "succeeded");
  }
  const over = await fetchPageForChat({ url: "https://one.example/a" }, h.ctx, h.deps);
  assert.equal(over.error?.code, "rate_limited");
  assert.equal(over.text, RATE_LIMITED_TEXT);

  const perHost = harness({ results: ["https://one.example/a"], roundBudget: 10 });
  for (let i = 0; i < 4; i += 1) await fetchPageForChat({ url: "https://one.example/a" }, perHost.ctx, perHost.deps);
  assert.equal((await fetchPageForChat({ url: "https://one.example/a" }, perHost.ctx, perHost.deps)).error?.code, "rate_limited");
  assert.equal(perHost.fetched.length, 4, "the fifth fetch of one host never left");
});

test("the enumeration guard: the third provenance refusal disables web_fetch for the turn", async () => {
  const h = harness({ results: ["https://ok.example/page"] });
  const audits: WebAuditEvent[] = [];
  setWebAuditSink(h.limits, (event) => audits.push(event));
  const first = await fetchPageForChat({ url: "https://probe.example/1" }, h.ctx, h.deps);
  const second = await fetchPageForChat({ url: "https://probe.example/2" }, h.ctx, h.deps);
  assert.equal(first.text, NOT_IN_PRIOR_CONTEXT_TEXT);
  assert.equal(second.text, NOT_IN_PRIOR_CONTEXT_TEXT);
  assert.equal(audits.length, 0);

  const third = await fetchPageForChat({ url: "https://probe.example/3" }, h.ctx, h.deps);
  assert.equal(third.error?.code, "url_not_in_prior_context");
  assert.ok(third.text.endsWith(FETCH_DISABLED_LINE));
  assert.deepEqual(audits, [
    { kind: "fetch_provenance_refused", severity: "warning", detail: { tool: "web_fetch", host: "probe.example" } },
  ]);
  assert.ok(!JSON.stringify(audits).includes("/3"), "the audit keeps the host, never the URL");

  // Even a link that IS on the ledger is refused now, with no network.
  const after = await fetchPageForChat({ url: "https://ok.example/page" }, h.ctx, h.deps);
  assert.equal(after.error?.code, "rate_limited");
  assert.ok(after.text.includes(FETCH_DISABLED_LINE));
  assert.deepEqual(h.fetched, []);
  assert.equal(webTurnState(h.limits).fetchDisabled, true);
});

test("after a hostile scan, only links the user typed can be opened", async () => {
  const h = harness({ typed: ["https://typed.example/"], results: ["https://result.example/"] });
  h.taint.mark("web_fetch", "hostile");
  assert.equal((await fetchPageForChat({ url: "https://result.example/" }, h.ctx, h.deps)).error?.code, "url_not_in_prior_context");
  assert.equal((await fetchPageForChat({ url: "https://typed.example/" }, h.ctx, h.deps)).status, "succeeded");
});

test("a fetched page's URLs join the ledger, so its links can be followed", async () => {
  const h = harness({ results: ["https://start.example/"] });
  assert.equal((await fetchPageForChat({ url: "https://linked.example/next" }, h.ctx, h.deps)).error?.code, "url_not_in_prior_context");
  await fetchPageForChat({ url: "https://start.example/" }, h.ctx, h.deps);
  assert.equal(h.ledger.match("https://linked.example/next")?.kind, "fetched_page");
  assert.equal((await fetchPageForChat({ url: "https://linked.example/next" }, h.ctx, h.deps)).status, "succeeded");
});

test("the limits table follows the round budget (§6.6)", () => {
  const counters = new UserWebCounters();
  const count = (limits: TurnWebLimits, tool: "web_search" | "web_fetch") => {
    let n = 0;
    while (limits.take(tool) && n < 100) n += 1;
    return n;
  };
  for (const [budget, searches, fetches] of [
    [4, 3, 4],
    [7, 6, 10],
    [10, 6, 10],
    [16, 10, 16],
    [24, 16, 24],
    [40, 16, 24],
  ] as const) {
    assert.equal(count(createTurnWebLimits({ roundBudget: budget, userId: `b${budget}`, userCounters: counters }), "web_search"), searches);
    assert.equal(count(createTurnWebLimits({ roundBudget: budget, userId: `f${budget}`, userCounters: counters }), "web_fetch"), fetches);
  }
  const chars = createTurnWebLimits({ roundBudget: 4, userId: "c", userCounters: counters });
  assert.equal(chars.takeChars(50_000), 50_000);
  assert.equal(chars.takeChars(50_000), 10_000);
  assert.equal(chars.takeChars(1), 0);
});

test("per-user rolling limits hold across turns and forget with time", () => {
  let now = 0;
  const counters = new UserWebCounters(() => now);
  let taken = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    const limits = createTurnWebLimits({ roundBudget: 24, userId: "heavy", userCounters: counters });
    while (limits.take("web_fetch")) taken += 1;
  }
  assert.equal(taken, 60, "60 fetches per 10 minutes");
  now += 10 * 60 * 1000 + 1;
  assert.ok(createTurnWebLimits({ roundBudget: 24, userId: "heavy", userCounters: counters }).take("web_fetch"));
  assert.ok(createTurnWebLimits({ roundBudget: 24, userId: "someone-else", userCounters: counters }).take("web_fetch"));
});

// ── Harness rule 1 ────────────────────────────────────────────────────────────

/** Static runtime imports (type-only ones are erased). */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["'];?/gm)) {
    found.push(match[1]);
  }
  return found;
}

function resolveLocal(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && path.extname(candidate)) return candidate;
  }
  return null;
}

function serverOnlyIn(entry: string): string[] {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeImports(file)) {
      if (specifier === "server-only") offenders.push(path.relative(root, file));
      const next = resolveLocal(file, specifier);
      if (next) visit(next);
    }
  };
  visit(path.join(root, entry));
  return offenders;
}

test("the provenance and fetch modules keep server-only out of a test's graph", () => {
  for (const file of ["src/lib/web/provenance.ts", "src/lib/web/fetch-page.ts", "src/lib/web/limits.ts", "src/lib/web/url-canon.ts"]) {
    assert.deepEqual(serverOnlyIn(file), [], file);
  }
  // The database port is server-only and reached only through a dynamic import.
  assert.match(readFileSync(path.join(root, "src/lib/web/ledger-db.ts"), "utf8"), /^import "server-only";/m);
  assert.match(readFileSync(path.join(root, "src/lib/web/provenance.ts"), "utf8"), /await import\("@\/lib\/web\/ledger-db"\)/);
});
