import assert from "node:assert/strict";
import test from "node:test";

import { pickAutoModel } from "@/lib/auto-model";
import { parseClientFeatures } from "@/lib/chat/client-features";
import { MODELS, MODEL_LIST } from "@/lib/models";
import { planTurnSearch, webSearchPossible, nativeSearchPolicy } from "@/lib/search/alevr/policy";
import { createAlevrSearchTurn, ALEVR_SEARCH_TOOL_IDS } from "@/lib/search/alevr/turn";
import { chatToolEntitlements, type EntitlementInput } from "@/lib/tools/entitlements";
import { createFindInPageSpec } from "@/lib/tools/specs/find-in-page";
import { createSearchNewsSpec } from "@/lib/tools/specs/search-news";
import type { WebSearchBackend } from "@/lib/tools/specs/web-search";
import type { ToolContext, ToolOutcome } from "@/lib/tools/types";
import { createTurnWebLimits, UserWebCounters } from "@/lib/web/limits";
import { UrlLedger } from "@/lib/web/provenance";
import { TurnTaint } from "@/lib/web/taint";
import { webTurnState } from "@/lib/web/turn-state";
import { SourceRegistry } from "@/lib/chat/source-registry";

/*
 * Alevr Search's tool family and the policy that hands it to every
 * tool-capable model (BRIEF §15): which search a turn gets, Auto no longer
 * excluding models without native search, the planner's tool list, the
 * `search_news` and `find_in_page` specs, and the turn binding the live route
 * uses.
 */

const CLAUDE = MODELS["anthropic:claude-opus-5-5"];
const DEEPSEEK = MODEL_LIST.find((m) => m.id === "deepseek:deepseek-flash")!;

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  const limits = createTurnWebLimits({ roundBudget: 10, userId: "u", userCounters: new UserWebCounters() });
  return {
    userId: "u",
    conversationId: "c",
    projectId: null,
    signal: new AbortController().signal,
    ledger: new UrlLedger(),
    taint: new TurnTaint({ staticContent: false }),
    limits,
    sources: new SourceRegistry(),
    ...over,
  };
}

// ── Policy ──────────────────────────────────────────────────────────────────

test("the model fixtures: Claude searches natively, DeepSeek does not", () => {
  assert.equal(CLAUDE.webSearch, true);
  assert.equal(DEEPSEEK.webSearch, false);
});

test("with Alevr Search available every tool-capable model gets the same tools; native search is the fallback", () => {
  const base = { webRequested: true, alevrAvailable: true, voice: false, private: false };
  assert.deepEqual(planTurnSearch({ ...base, model: CLAUDE }), { alevr: true, native: false });
  assert.deepEqual(planTurnSearch({ ...base, model: DEEPSEEK }), { alevr: true, native: false });
  assert.deepEqual(planTurnSearch({ ...base, model: CLAUDE, policy: "also" }), { alevr: true, native: true });
  assert.deepEqual(planTurnSearch({ ...base, model: DEEPSEEK, policy: "also" }), { alevr: true, native: false });
  assert.deepEqual(planTurnSearch({ ...base, model: CLAUDE, policy: "prefer" }), { alevr: false, native: true });
  assert.deepEqual(planTurnSearch({ ...base, model: DEEPSEEK, policy: "prefer" }), { alevr: true, native: false });
  // No backend: the provider's own search, or nothing.
  assert.deepEqual(planTurnSearch({ ...base, alevrAvailable: false, model: CLAUDE }), { alevr: false, native: true });
  assert.deepEqual(planTurnSearch({ ...base, alevrAvailable: false, model: DEEPSEEK }), { alevr: false, native: false });
  // Voice and private chats keep the provider's own search.
  assert.deepEqual(planTurnSearch({ ...base, voice: true, model: DEEPSEEK }), { alevr: false, native: false });
  assert.deepEqual(planTurnSearch({ ...base, private: true, model: CLAUDE }), { alevr: false, native: true });
  assert.deepEqual(planTurnSearch({ ...base, webRequested: false, model: CLAUDE }), { alevr: false, native: false });
  assert.equal(nativeSearchPolicy({}), "fallback");
  assert.equal(nativeSearchPolicy({ ALEVR_SEARCH_PROVIDER_NATIVE: "ALSO" }), "also");
  assert.equal(nativeSearchPolicy({ ALEVR_SEARCH_PROVIDER_NATIVE: "bogus" }), "fallback");
});

test("Auto no longer excludes models without native search when Alevr Search can serve them", () => {
  assert.equal(webSearchPossible(DEEPSEEK, false), false);
  assert.equal(webSearchPossible(DEEPSEEK, true), true);
  const message = "What changed in the EU heat pump subsidy rules this week?";
  // Every provider configured: Auto Router 2.0 has no plan-blind last resort.
  const context = { isConfigured: () => true };
  const without = pickAutoModel({ message, plan: "MAX", wantsWebSearch: true, alevrSearch: false, context });
  const withAlevr = pickAutoModel({ message, plan: "MAX", wantsWebSearch: true, alevrSearch: true, context });
  assert.equal(without.model.webSearch, true, "without Alevr Search only native searchers qualify");
  assert.ok(withAlevr.candidatesConsidered >= without.candidatesConsidered);
  assert.ok(
    MODEL_LIST.some((m) => !m.webSearch && webSearchPossible(m, true)),
    "the catalogue has models that only Alevr Search makes searchable",
  );
});

test("the tool planner attaches the whole family on every function model and keeps native search off", () => {
  const input: EntitlementInput = {
    plan: "PRO",
    private: false,
    lockdown: false,
    approvalPolicy: "ask_risky" as EntitlementInput["approvalPolicy"],
    voice: false,
    regenerate: false,
    artifactEdit: false,
    researchActive: false,
    researchArmed: false,
    webToggle: true,
    features: parseClientFeatures([]),
    workspace: {},
    skill: null,
    model: CLAUDE,
    hasFileAttachment: false,
    hasInspectable: false,
    sandboxConfigured: false,
    keyedSearchEngine: true,
    saved: { userMessageId: "m", conversationKind: "chat" },
    taskTool: false,
  };
  for (const model of [CLAUDE, DEEPSEEK]) {
    const plan = chatToolEntitlements({ ...input, model });
    for (const id of ALEVR_SEARCH_TOOL_IDS) assert.ok(plan.juno.includes(id), `${model.id} gets ${id}`);
    assert.equal(plan.nativeSearch, false, model.id);
  }
  const fallback = chatToolEntitlements({ ...input, keyedSearchEngine: false });
  assert.equal(fallback.nativeSearch, true);
  assert.ok(!fallback.juno.includes("web_search"));
  assert.ok(!chatToolEntitlements({ ...input, keyedSearchEngine: false, model: DEEPSEEK }).juno.includes("web_search"));
  assert.equal(chatToolEntitlements({ ...input, nativeSearchPolicy: "also" }).nativeSearch, true);
});

// ── search_news ─────────────────────────────────────────────────────────────

test("search_news asks the news vertical and defaults to the past week", async () => {
  const seen: Array<Parameters<WebSearchBackend>[0]> = [];
  const search: WebSearchBackend = async (input) => {
    seen.push(input);
    return { results: [{ title: "Story", url: "https://news.example/a", snippet: "s", engine: "serper", publishedAt: "2026-10-03T00:00:00Z" }], engine: "serper", engines: [], feeMicroUsd: 1_000, degraded: false };
  };
  const spec = createSearchNewsSpec({ search });
  assert.equal(spec.id, "search_news");
  const outcome = await spec.execute({ query: "heat pump grants" }, ctx());
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(seen[0], { query: "heat pump grants", count: 5, recency: "week", vertical: "news" });
  await spec.execute({ query: "older", recency: "any" }, ctx());
  assert.equal(seen[1].recency, undefined, "any widens past the week");
  assert.equal(outcome.feeMicroUsd, 1_000);
});

// ── find_in_page ────────────────────────────────────────────────────────────

const LONG_PAGE = `${"Preamble. ".repeat(300)}\nThe battery warranty lasts eight years.\n${"Middle. ".repeat(300)}\nWarranty claims need the battery serial.`;

test("find_in_page searches a page opened this turn in memory, with offsets, inside the envelope", async () => {
  const context = ctx();
  webTurnState(context.limits!).opened.set("https://ev.example:/manual?", { url: "https://ev.example/manual", title: "Manual", text: LONG_PAGE });
  const spec = createFindInPageSpec({ fetchPage: async () => assert.fail("an opened page needs no fetch") });
  const outcome = await spec.execute({ url: "https://ev.example/manual", query: "battery warranty" }, context);
  assert.equal(outcome.status, "succeeded");
  assert.match(outcome.text, /^Searched https:\/\/ev\.example\/manual for "battery warranty": \d passages?/);
  assert.match(outcome.text, /<<<JUNO_UNTRUSTED_BEGIN>>> source=passages of web page/);
  assert.match(outcome.text, /\[offset \d+, exact match\] .*eight years/);
  assert.match(outcome.text, /call web_fetch with this URL and its offset/);
  assert.equal(context.taint!.observed, true);
});

test("find_in_page opens an unseen page through web_fetch's own pipeline, and returns its refusal unchanged", async () => {
  const refused: ToolOutcome = { status: "failed", text: "not in prior context", body: "not in prior context", error: { code: "url_not_in_prior_context" } };
  const spec = createFindInPageSpec({ fetchPage: async () => refused });
  assert.deepEqual(await spec.execute({ url: "https://never.example/x", query: "anything" }, ctx()), refused);

  const context = ctx();
  const opening = createFindInPageSpec({
    fetchPage: async (input, c) => {
      assert.equal(input.maxChars, 1_000, "the smallest window");
      webTurnState(c.limits).opened.set("https://ev.example:/manual?", { url: "https://ev.example/manual", title: "Manual", text: LONG_PAGE });
      return { status: "succeeded", text: "ok", body: "ok", web: { finalUrl: "https://ev.example/manual" } };
    },
  });
  const outcome = await opening.execute({ url: "https://ev.example/manual", query: "serial" }, context);
  assert.equal(outcome.status, "succeeded");
  assert.match(outcome.text, /battery serial/);
});

test("find_in_page refuses without a query or without the turn's web state", async () => {
  const spec = createFindInPageSpec({ fetchPage: async () => assert.fail() });
  assert.equal((await spec.execute({ url: "https://a.example/", query: " " }, ctx())).error?.code, "invalid_args");
  assert.equal((await spec.execute({ url: "", query: "x" }, ctx())).error?.code, "invalid_args");
  assert.equal((await spec.execute({ url: "https://a.example/", query: "x" }, ctx({ ledger: null }))).error?.code, "unavailable");
});

// ── The turn binding ────────────────────────────────────────────────────────

test("the turn binds ledger, taint, limits and sources into the specs, and queues their sources for the route", async () => {
  const seen: ToolContext[] = [];
  const fakeSpec = (id: string) => ({
    id,
    title: id,
    description: "d",
    input: { type: "object" as const, properties: {} },
    risk: "read" as const,
    parallelSafe: true,
    timeoutMs: 1_000,
    icon: "search" as const,
    broker: "juno_runtime" as const,
    async execute(_args: Record<string, unknown>, c: ToolContext): Promise<ToolOutcome> {
      seen.push(c);
      return { status: "succeeded", text: "t", body: "t", sources: [{ title: "A", url: `https://${id}.example/`, snippet: "" }] };
    },
  });
  const turn = createAlevrSearchTurn({
    userId: "u",
    conversationId: "c",
    private: false,
    effort: "high",
    voice: false,
    userTexts: ["look at https://typed.example/page please"],
    specs: [fakeSpec("web_search"), fakeSpec("web_fetch")],
    history: { userTexts: async () => [], assistantSources: async () => [] },
  });
  const bare = { userId: "u", conversationId: "c", projectId: null, signal: new AbortController().signal } as ToolContext;
  await turn.specs[0].execute({}, bare);
  await turn.specs[1].execute({}, bare);
  assert.equal(seen[0].ledger, turn.ledger);
  assert.equal(seen[0].taint, turn.taint);
  assert.equal(seen[0].limits, turn.limits);
  assert.equal(seen[0].citationsNumbered, false);
  assert.ok(seen[0].sources);
  assert.deepEqual(turn.drainSources().map((b) => [b.origin, b.sources[0].url]), [
    ["juno_search", "https://web_search.example/"],
    ["juno_fetch", "https://web_fetch.example/"],
  ]);
  assert.deepEqual(turn.drainSources(), [], "drained once");
  assert.ok(await turn.ledger.match("https://typed.example/page"), "the person's own URL may be opened");
  assert.equal(await turn.ledger.match("https://elsewhere.example/"), null, "nothing else may");
});
