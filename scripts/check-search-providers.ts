/**
 * Which search backends this deployment can actually reach, and what they return.
 *
 * Deep research is only ever as good as the index behind it, and the failure
 * mode is silent: with no key configured the fan-out still "works" — it falls
 * through to scraped DuckDuckGo, public SearXNG instances and Wikipedia's
 * five-result index, and a run comes back thin with nothing anywhere saying
 * why. This is the one command that answers "is my key live and is it any
 * good", which is the question you have the moment you paste one in.
 *
 *   npm run search:check
 *   npm run search:check -- "your own query"
 *
 * It makes REAL network calls on purpose — a check that mocked the providers
 * would pass on a typo'd key. It costs one query per configured provider.
 */

import { config } from "dotenv";

config({ path: ".env" });
config({ path: ".env.local", override: true });

const QUERY = process.argv.slice(2).join(" ").trim() || "perovskite solar cell stability 2026";

/** Name → the env vars that turn it on. Keyless engines list none. */
const PROVIDERS: Array<{ name: string; keys: string[]; note: string }> = [
  { name: "tavily", keys: ["TAVILY_API_KEY"], note: "AI-native; returns page bodies with results" },
  { name: "serper", keys: ["SERPER_API_KEY"], note: "Google's ranking" },
  { name: "brave", keys: ["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"], note: "independent index; free tier" },
  { name: "exa", keys: ["EXA_API_KEY"], note: "neural/semantic; returns full text" },
  { name: "searxng", keys: ["SEARXNG_URL"], note: "self-hosted metasearch; no key" },
];

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main() {
  // Imported lazily and through the react-server condition, because the module
  // is `server-only` and throws the moment a plain Node process loads it.
  const { searchWithEngineReport, searchProviderStatus } = await import("../src/lib/search/search-engine");

  const status = searchProviderStatus();

  console.log(`\nQuery: "${QUERY}"\n`);
  console.log(pad("PROVIDER", 12) + pad("STATE", 14) + "NOTE");
  console.log("─".repeat(72));
  for (const provider of PROVIDERS) {
    const on = provider.keys.some((key) => !!process.env[key]?.trim());
    console.log(
      pad(provider.name, 12) +
        pad(on ? "configured" : "not set", 14) +
        provider.note +
        (on ? "" : `  (set ${provider.keys[0]})`)
    );
  }
  console.log(pad("duckduckgo", 12) + pad("always on", 14) + "scraped HTML; rate-limited");
  console.log(pad("wikipedia", 12) + pad("always on", 14) + "encyclopedia only; caps at 5 results");

  console.log(
    `\nIndexed provider: ${status.hasGoodIndex ? "YES" : "NO"}` +
      (status.hasGoodIndex
        ? ""
        : "  ← research will be thin. Add one commercial key, or run your own SearXNG (SEARXNG_URL).")
  );

  console.log("\nRunning the real fan-out…\n");
  const started = Date.now();
  const { results, engines } = await searchWithEngineReport({ query: QUERY, count: 20 });
  const elapsed = Date.now() - started;

  /*
   * The per-engine verdict, which is the whole reason to run this.
   *
   * "configured" above only means an env var is set. `bad_key` is a key that is
   * present and wrong — the single most common thing this command is run to
   * find out, and previously indistinguishable from an engine that simply had
   * nothing to say, because every provider swallowed its non-2xx into an empty
   * array.
   */
  const EXPLAIN: Record<string, string> = {
    ok: "",
    empty: "answered, but returned nothing for this query",
    bad_key: "KEY REJECTED — missing, wrong, or revoked",
    rate_limited: "QUOTA/RATE LIMIT exhausted, even after one retry",
    provider_error: "the provider errored",
    timeout: "did not answer within the per-engine deadline",
    failed: "the request failed before a response",
  };
  console.log(pad("ENGINE", 12) + pad("RESULT", 16) + "DETAIL");
  console.log("─".repeat(72));
  for (const engine of engines) {
    console.log(
      pad(engine.name, 12) +
        pad(engine.status === "ok" ? `${engine.results} hits` : engine.status, 16) +
        (EXPLAIN[engine.status] ?? "") +
        (engine.httpStatus ? `  (HTTP ${engine.httpStatus})` : "")
    );
  }
  console.log();

  if (results.length === 0) {
    console.log("No results at all. Every backend either failed, timed out, or is blocked.");
    process.exitCode = 1;
    return;
  }

  // `engine` carries every backend that returned a given URL, joined by "+", so
  // this counts AGREEMENT — the thing rank fusion actually rewards.
  const byEngine = new Map<string, number>();
  for (const hit of results) {
    for (const name of hit.engine.split("+")) byEngine.set(name, (byEngine.get(name) ?? 0) + 1);
  }

  console.log(`${results.length} merged results in ${elapsed}ms, ${new Set(results.map((r) => r.url)).size} distinct URLs`);
  console.log(
    "Contributions: " +
      [...byEngine.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} ${count}`)
        .join(" · ")
  );
  const withBody = results.filter((r) => r.rawContent?.trim()).length;
  console.log(`${withBody} of ${results.length} arrived with page text (the rest are fetched during the run)\n`);

  for (const hit of results.slice(0, 8)) {
    console.log(`  ${pad(hit.engine, 22)} ${hit.title.slice(0, 68)}`);
    console.log(`  ${" ".repeat(22)} ${hit.url.slice(0, 96)}`);
  }
  console.log();
}

main().catch((error) => {
  console.error("\nsearch:check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
