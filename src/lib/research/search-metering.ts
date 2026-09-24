/**
 * What a research search really costs (SPEC §9.3, DECISIONS §4c: "every
 * search is metered at the engine's real per-query cost, from now on").
 *
 * The fan-out used to bill a flat 1,000 µUSD per query whatever answered —
 * a quarter of one Tavily call when four keyed engines had each been paid.
 * It is now the sum of each keyed engine's price over the engines that
 * answered `ok` or `empty` (an engine that errored was not paid). The free
 * engines (SearXNG, DuckDuckGo, Wikipedia) cost nothing.
 *
 * The prices are the chat tool's (§3.9, `enginePriceMicroUsd`, WS1). Until
 * that lands its stub throws, and the same list prices stand in here so the
 * ledger is right today and moves with the tool's table the day it merges.
 */

import { enginePriceMicroUsd } from "@/lib/tools/metering";
import type { SearchRoster } from "@/lib/research/envelope";

export const KEYED_RESEARCH_ENGINES = ["tavily", "serper", "brave", "exa"] as const;
export type KeyedResearchEngine = (typeof KEYED_RESEARCH_ENGINES)[number];

export function isKeyedEngine(name: string): name is KeyedResearchEngine {
  return (KEYED_RESEARCH_ENGINES as readonly string[]).includes(name);
}

/** §3.9 list prices, 2026-09-23 — the stand-in for WS1's table. */
function listPriceMicroUsd(engine: KeyedResearchEngine, results: number): number {
  const n = Math.max(0, Math.floor(results));
  switch (engine) {
    case "tavily":
      return 8_000;
    case "serper":
      return n <= 10 ? 1_000 : 2_000;
    case "brave":
      return 5_000;
    case "exa":
      return 7_000 + 1_000 * Math.max(0, n - 10) + 1_000 * n;
  }
}

/** One call to `engine` for `results` results, in micro-USD. */
export function researchEnginePriceMicroUsd(engine: KeyedResearchEngine, results: number): number {
  try {
    const priced = enginePriceMicroUsd(engine, results);
    if (Number.isFinite(priced) && priced >= 0) return priced;
  } catch {
    // WS1's table is not wired yet; the list price below is the same number.
  }
  return listPriceMicroUsd(engine, results);
}

/** What one fan-out cost: every keyed engine that answered `ok` or `empty`. */
export function researchSearchFeeMicroUsd(
  engines: ReadonlyArray<{ name: string; results: number; status: string }>,
  requested: number
): number {
  let total = 0;
  for (const engine of engines) {
    if (!isKeyedEngine(engine.name)) continue;
    if (engine.status !== "ok" && engine.status !== "empty") continue;
    total += researchEnginePriceMicroUsd(engine.name, Math.max(engine.results, requested));
  }
  return total;
}

/** The keyed engines configured here and what one query costs on each, for sizing (§9.2). */
export function researchRoster(configured: readonly string[], resultsPerQuery: number): SearchRoster {
  return {
    engines: configured
      .filter(isKeyedEngine)
      .map((name) => ({ name, microUsdPerQuery: researchEnginePriceMicroUsd(name, resultsPerQuery) })),
  };
}
