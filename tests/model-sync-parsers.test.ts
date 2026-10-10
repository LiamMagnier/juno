import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { pageFileName } from "../scripts/model-sync/fetch";
import { anthropic, ANTHROPIC_PAGES, anthropicModelPage } from "../scripts/model-sync/labs/anthropic";
import { MINIMAX_PAGES, minimax, MOONSHOT_PAGES, moonshot, QWEN_PAGES, qwen, ZHIPU_PAGES, zhipu } from "../scripts/model-sync/labs/compat-labs";
import { DEEPSEEK_PAGES, deepseek } from "../scripts/model-sync/labs/deepseek";
import { GOOGLE_PAGES, google, priceCell } from "../scripts/model-sync/labs/google";
import { lastFullDayBefore, MIMO_PAGES, mimo } from "../scripts/model-sync/labs/mimo";
import { MISTRAL_PAGES, mistral, mistralModelPage, mistralSlugs } from "../scripts/model-sync/labs/mistral";
import { OPENAI_PAGES, openai, openaiModelPage } from "../scripts/model-sync/labs/openai";
import { XAI_PAGES, xai } from "../scripts/model-sync/labs/xai";
import { discover, type OrModel } from "../scripts/model-sync/openrouter";
import { cellText, isoDate, parseHtmlTables, parseMarkdownTables, usd } from "../scripts/model-sync/tables";
import type { ModelFact } from "../scripts/model-sync/types";

/*
 * The parsers behind `npm run models:sync`, against pages saved from each
 * lab's own site on 2026-10-10 (tests/fixtures/model-sync, named the way
 * `--save-pages` names them). The owner's complaint that started this was a
 * catalogue showing false prices, so every assertion here is a figure read off
 * the saved page by hand: if a parser starts reading a different column, a
 * test names the model and the number.
 */
const DIR = path.join(process.cwd(), "tests/fixtures/model-sync");
const page = (url: string) => readFileSync(path.join(DIR, pageFileName(url)), "utf8");
const DAY = "2026-10-10";
const byId = (facts: ModelFact[]) => new Map(facts.map((f) => [f.id, f]));

test("table helpers read prices, dates and both table shapes without guessing", () => {
  assert.equal(usd("$0.10 / MTok"), 0.1);
  assert.equal(usd("\\$1.4"), 1.4);
  assert.equal(usd("From $0.10 / MTok"), null, "a 'from' price is not a rate");
  assert.equal(usd("Free"), null);
  assert.equal(usd("$0.75 through December 31, 2026. $1.50 starting January 1, 2027."), null);
  assert.equal(isoDate("October 7, 2026"), "2026-10-07");
  assert.equal(isoDate("Oct 23, 2026"), "2026-10-23");
  assert.equal(isoDate("10:00, October 21,2026 (UTC+8)"), "2026-10-21");
  assert.equal(isoDate("2026.6.30 00:00 (UTC+8)"), "2026-06-30");
  assert.equal(isoDate("10/31/2026"), "2026-10-31");
  assert.equal(cellText("$2.00, prompts \\<= 200k tokens $4.00, prompts \\> 200k"), "$2.00, prompts <= 200k tokens $4.00, prompts > 200k");
  const md = parseMarkdownTables("## T\n\n| a | b |\n|---|---|\n| `x` \\| `y` | **2** |\n");
  assert.deepEqual(md[0], { heading: "T", headers: ["a", "b"], rows: [["x | y", "2"]] });
  const html = parseHtmlTables('<table><tr><th>m</th><th>p</th></tr><tr><td rowspan="2">a</td><td>1</td></tr><tr><td>2</td></tr><tr><td rowSpan={2}>b</td><td>3</td></tr></table>');
  assert.deepEqual(html[0].rows, [["a", "1"], ["a", "2"], ["b", "3"]]);
});

test("Anthropic: Haiku 5.5's banded price, Sonnet 5.5's 5% cache, Opus 5's fast mode, the legacy list", () => {
  const facts = byId(
    anthropic.parse(
      {
        overview: page(ANTHROPIC_PAGES.overview),
        pricing: page(ANTHROPIC_PAGES.pricing),
        deprecations: page(ANTHROPIC_PAGES.deprecations),
        [anthropicModelPage("claude-haiku-5-5").key]: page(anthropicModelPage("claude-haiku-5-5").url),
      },
      DAY
    )
  );
  const haiku = facts.get("claude-haiku-5-5")!;
  assert.deepEqual(haiku.rates, { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 });
  assert.deepEqual(haiku.longContext, { threshold: 100_000, inclusive: false, inputMultiplier: 5, outputMultiplier: 5 });
  assert.equal(haiku.contextWindow, 1_000_000);
  assert.equal(haiku.maxOutput, 128_000);
  assert.equal(haiku.released, "2026-10-07");
  assert.equal(haiku.vision, true);
  assert.equal(haiku.lifecycle, "active");
  assert.equal(haiku.fast, null, "fast mode is an Opus-only table");
  assert.equal(haiku.sources.rates?.url, "https://platform.claude.com/docs/en/about-claude/pricing");

  assert.equal(facts.get("claude-sonnet-5-5")!.rates!.cacheRead, 0.1);
  assert.deepEqual(facts.get("claude-opus-5")!.fast, { input: 10, output: 50 });
  assert.deepEqual(facts.get("claude-opus-5-5")!.fast, { input: 8, output: 40 });
  assert.equal(facts.get("claude-haiku-4-5")!.lifecycle, "legacy");
  const sonnet45 = facts.get("claude-sonnet-4-5")!;
  assert.equal(sonnet45.retiresOn, "2026-11-30");
  assert.equal(sonnet45.replacement, "claude-sonnet-5-5");
  // "Not sooner than ..." is never a retirement date.
  assert.equal(facts.get("claude-opus-5-5")!.retiresOn, undefined);
  assert.ok(facts.get("claude-mythos-5-1")!.notes?.includes("limited availability"));
});

test("OpenAI: GPT-6.1 Sol's Ultrafast tier at 6x, the 272K surcharge, snapshot deprecations land only on their alias", () => {
  const pages: Record<string, string> = {
    pricing: page(OPENAI_PAGES.pricing),
    deprecations: page(OPENAI_PAGES.deprecations),
    models: page(OPENAI_PAGES.models),
  };
  for (const id of ["gpt-6.1-sol", "gpt-4o", "gpt-5", "o1"]) pages[openaiModelPage(id).key] = page(openaiModelPage(id).url);
  const facts = byId(openai.parse(pages, DAY));
  const sol = facts.get("gpt-6.1-sol")!;
  assert.deepEqual(sol.rates, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  assert.deepEqual(sol.fast, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(sol.ultrafast, { input: 12, output: 60, cacheRead: 0.6, cacheWrite: 15 });
  assert.deepEqual(sol.longContext, { threshold: 272_000, inclusive: false, inputMultiplier: 2, outputMultiplier: 1.5 });
  assert.equal(sol.contextWindow, 1_050_000);
  assert.equal(sol.vision, true);
  assert.deepEqual(facts.get("gpt-6-astra")!.ultrafast, { input: 60, output: 300, cacheRead: 6, cacheWrite: 75 });
  assert.equal(facts.get("gpt-6-luna")!.ultrafast, null, "Ultrafast is Astra and 6.1 Sol only");
  assert.equal(facts.get("gpt-5.4-nano")!.fast, null, "nano is not in the Fast table");
  // gpt-4o-2024-05-13 is deprecated; the gpt-4o alias points at 2024-08-06 and is not.
  assert.equal(facts.get("gpt-4o")!.lifecycle, undefined);
  assert.equal(facts.get("gpt-4o-2024-05-13")!.retiresOn, "2026-10-23");
  // gpt-5-2025-08-07 IS gpt-5's default snapshot, so the alias retires with it.
  assert.equal(facts.get("gpt-5")!.retiresOn, "2026-12-11");
  assert.equal(facts.get("o1")!.retiresOn, "2026-10-23");
  assert.equal(facts.get("gpt-3.5-turbo")!.rates!.input, 0.5);
});

test("Google: banded Pro pricing, scheduled Flash promos kept out, auto-routed models flagged", () => {
  const facts = byId(google.parse({ pricing: page(GOOGLE_PAGES.pricing), deprecations: page(GOOGLE_PAGES.deprecations) }, DAY));
  const pro = facts.get("gemini-3.1-pro-preview")!;
  assert.deepEqual(pro.rates, { input: 2, output: 12, cacheRead: 0.2 });
  assert.deepEqual(pro.longContext, { threshold: 200_000, inclusive: false, inputMultiplier: 2, outputMultiplier: 1.5 });
  const flash = facts.get("gemini-3.8-flash")!;
  assert.equal(flash.rates, undefined, "a promo with an end date is never a flat rate");
  assert.match(flash.scheduledPrice!, /\$0\.75 through December 31, 2026/);
  assert.deepEqual(facts.get("gemini-3.5-flash-lite")!.rates, { input: 0.3, output: 2.5, cacheRead: 0.03 });
  assert.equal(facts.get("gemini-3.7-flash")!.autoRouted, true);
  assert.equal(facts.get("gemini-3.7-flash")!.replacement, "gemini-3.8-flash");
  assert.equal(facts.get("gemini-3.1-flash-lite")!.retiresOn, "2027-05-07");
  assert.deepEqual(priceCell("$0.25 (text / image / video) $0.50 (audio)"), { price: 0.25 });
});

test("xAI: the 200K band is inclusive and doubles every rate", () => {
  const facts = byId(xai.parse({ models: page(XAI_PAGES.models) }, DAY));
  assert.deepEqual(facts.get("grok-4.7")!.rates, { input: 2, output: 6, cacheRead: 0.5 });
  assert.deepEqual(facts.get("grok-4.7")!.longContext, { threshold: 200_000, inclusive: true, inputMultiplier: 2, outputMultiplier: 2 });
  assert.equal(facts.get("grok-4.3")!.contextWindow, 1_000_000);
});

test("DeepSeek: the transposed table, off-peak rates, and the retired legacy names", () => {
  const facts = byId(deepseek.parse({ pricing: page(DEEPSEEK_PAGES.pricing) }, DAY));
  assert.deepEqual(facts.get("deepseek-flash")!.rates, { input: 0.15, output: 0.6, cacheRead: 0.003 });
  assert.deepEqual(facts.get("deepseek-v4-pro")!.rates, { input: 0.66, output: 1.98, cacheRead: 0.022 });
  assert.equal(facts.get("deepseek-v4-pro")!.vision, false);
  assert.equal(facts.get("deepseek-v4-flash")!.lifecycle, "retired");
  assert.equal(facts.get("deepseek-v4-flash")!.replacement, "deepseek-flash");
});

test("Xiaomi: MiMo V2.5 Pro is answered by V2.6 Pro from Oct 14, so its last day as itself is Oct 13", () => {
  assert.equal(lastFullDayBefore("10:00, October 14,2026 (UTC+8)"), "2026-10-13");
  assert.equal(lastFullDayBefore("10:00, October 21,2026 (UTC+8)"), "2026-10-20");
  const facts = byId(mimo.parse({ pricing: page(MIMO_PAGES.pricing), deprecations: page(MIMO_PAGES.deprecations) }, DAY));
  const pro = facts.get("mimo-v2.5-pro")!;
  assert.equal(pro.retiresOn, "2026-10-13");
  assert.equal(pro.autoRoutedFrom, "2026-10-14");
  assert.equal(pro.replacement, "mimo-v2.6-pro");
  assert.equal(pro.vision, false, "Xiaomi: 'mimo-v2.5-pro only supports text input'");
  assert.equal(facts.get("mimo-v2.5")!.replacement, "mimo-v2.6-flash");
  assert.deepEqual(facts.get("mimo-v2.6-pro-ultraspeed")!.rates, { input: 4.35, output: 8.7, cacheRead: 0.036 });
  assert.deepEqual(facts.get("mimo-v2.6-pro")!.rates, { input: 0.435, output: 0.87, cacheRead: 0.0036 });
});

test("Z.ai, Kimi, MiniMax, Qwen: one table each, free and promo prices never written as rates", () => {
  const z = byId(zhipu.parse({ pricing: page(ZHIPU_PAGES.pricing) }, DAY));
  assert.deepEqual(z.get("glm-5.3")!.rates, { input: 1.4, output: 4.4, cacheRead: 0.26 });
  assert.equal(z.get("glm-4.7-flash")!.free, true);
  assert.equal(z.get("glm-4.7-flash")!.rates, undefined);

  const k = byId(moonshot.parse({ pricing: page(MOONSHOT_PAGES.pricing) }, DAY));
  assert.deepEqual(k.get("kimi-k3")!.rates, { input: 3, output: 15, cacheRead: 0.3 });
  assert.equal(k.get("kimi-k3")!.contextWindow, 1_048_576);

  const mm = byId(minimax.parse({ pricing: page(MINIMAX_PAGES.pricing) }, DAY));
  assert.deepEqual(mm.get("MiniMax-M3")!.rates, { input: 0.3, output: 1.2, cacheRead: 0.06 }, "the discounted price, not the struck-through one");
  assert.deepEqual(mm.get("MiniMax-M3")!.longContext, { threshold: 512_000, inclusive: false, inputMultiplier: 2, outputMultiplier: 2 });

  const q = byId(qwen.parse({ pricing: page(QWEN_PAGES.pricing) }, DAY));
  assert.deepEqual(q.get("qwen3.8-max")!.rates, { input: 2, output: 6 });
  // Qwen-Omni's Singapore price is a Markdown table with "USD" cells.
  assert.deepEqual(q.get("qwen3.8-omni-flash")!.rates, { input: 0.15, output: 0.47, cacheRead: 0.016 });
  const plus = q.get("qwen3.7-plus")!;
  assert.deepEqual(plus.rates, { input: 0.4, output: 1.6 }, "the list price, with the limited-time discount reported");
  assert.ok(plus.notes?.some((n) => /limited-time 20% off/.test(n)));
});

test("OpenRouter is discovery only: recent ids from Juno's labs that nothing already knows", () => {
  const models = (JSON.parse(page("https://openrouter.ai/api/v1/models")) as { data: OrModel[] }).data;
  const found = discover(models, new Set(["anthropic:claudehaiku55", "openai:gpt61sol", "xai:grok47"]), DAY);
  const slugs = found.map((d) => d.slug);
  assert.ok(slugs.includes("mistralai/mistral-large-4-0"));
  assert.ok(!slugs.includes("anthropic/claude-haiku-5.5"), "known ids are not news");
  assert.ok(!slugs.some((s) => s.startsWith("stepfun/")), "only labs Juno integrates");
});

test("Mistral: the card's API names settle the alias; list price, not a sale price, is the rate", () => {
  const overview = page(MISTRAL_PAGES.models);
  const slugs = mistralSlugs(overview);
  assert.ok(slugs.includes("mistral-large-4-0") && slugs.includes("mistral-large-3-25-12"));
  assert.ok(!slugs.some((s) => /embed|moderation/.test(s)));
  const pages: Record<string, string> = { models: overview };
  for (const slug of ["mistral-large-4-0", "mistral-large-3-25-12"]) pages[mistralModelPage(slug).key] = page(mistralModelPage(slug).url);
  const facts = byId(mistral.parse(pages, DAY));
  const large4 = facts.get("mistral-large-4")!;
  assert.equal(large4.name, "Mistral Large 4");
  assert.deepEqual(large4.rates, { input: 1.36, output: 4.18, cacheRead: 0.14 });
  assert.ok(large4.notes?.some((n) => /on sale at \$0.68 \/ \$2.09/.test(n)));
  assert.ok(large4.notes?.includes("public preview"));
  assert.equal(large4.contextWindow, 1_000_000);
  assert.ok(facts.has("mistral-large-4-0"), "both names on the card");
  // `mistral-large-latest` is on Large 3's card, not Large 4's.
  assert.equal(facts.get("mistral-large-latest")!.name, "Mistral Large 3");
  assert.deepEqual(facts.get("mistral-large-latest")!.rates, { input: 0.5, output: 1.5 });
  assert.equal(facts.get("mistral-large-latest")!.contextWindow, 256_000);
});
