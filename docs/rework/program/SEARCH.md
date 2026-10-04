# Alevr product program: Alevr Search vertical

Scope: BRIEF §15 (Alevr Search), §16 (cost objective), §17 (search security), §55 item 4, plus the search-dependent Deep Research items of §§11–13. Branch `rework/search`. The canonical status is `alevr_search` in `src/lib/capabilities.ts`.

## Decision (written before implementing)

- **Keep the existing tool ids.** `web_search` and `web_fetch` already exist and are persisted in run records, in the wire contract (`contracts/chat/juno-chat-wire-v1.schema.json`), in the native presentation and in standing approvals. The brief's `search_web` and `open_page` are now aliases (`src/lib/tools/aliases.ts`), so a skill or assistant that names either still gets the tool. Two tools are new: `search_news` and `find_in_page`. There is no `search_images` or `search_documents`: no image backend is wired, and "documents" belongs to Library/knowledge search, which already exists. Adding either would be a button without a capability behind it.
- **Alevr Search comes first; provider search is the fallback.** When Alevr Search can answer on a deployment, every model that takes function tools gets the same four tools, whether or not its provider has its own search. Provider-native search is used when Alevr Search cannot run, for voice turns, and for private chats. `ALEVR_SEARCH_PROVIDER_NATIVE=also|prefer` changes this.
  - Provider search is not a discovery backend. It runs inside the model's own request and returns no result list that Alevr could rank, cache or bill per call, so putting it behind the discovery interface would be dishonest.
- **The chat route was not wiring the tools.** On this branch the live route ran `web_search`/`web_fetch` nowhere: they were in the registry, but the route only turned on provider search, and only for models that had one. This vertical wires them into the live route through `toolSpecs`, bound to the turn (`src/lib/search/alevr/turn.ts`). It does not switch the route to the unfinished turn-stream rework.
- **One stack for chat and Research.** Research's search and page fetching now go through the same backends and the same caches. The existing evidence store, claims and citation verifier are integrated with this, not duplicated.

## Implemented

**Tool family.** Every tool-capable model gets `web_search`, `search_news`, `web_fetch` and `find_in_page`. Each has its own registry spec and broker rule (`juno_runtime:*`, all `read_only`).
- `search_news` (`src/lib/tools/specs/search-news.ts`) asks each backend's news surface: Serper `/news`, Brave's news endpoint, Tavily `topic: news`, Exa `category: news` and SearXNG's `news` category. It defaults to the past week.
- `find_in_page` (`src/lib/tools/specs/find-in-page.ts`, `src/lib/search/alevr/find.ts`) returns the passages of a page that match: exact phrase first, then BM25 passages. Each passage comes with the offset `web_fetch` takes.
  - A page opened this turn is searched in memory.
  - Any other page is opened through `fetchPageForChat` itself, so it inherits provenance, the SSRF guard, limits and the cache.

**Discovery interface** (`src/lib/search/alevr/backends.ts`). Each `DiscoveryBackend` declares its kind (paid, self-hosted, open data), the verticals it serves, a quality prior for each vertical, whether it is available, its cost per call, and a `run` method.
- Backends:
  - Serper, Brave, Tavily and Exa use the existing engine module, which stays one copy.
  - The operator's SearXNG is used only through `SEARXNG_URL`.
  - Wikipedia's API is used under its User-Agent policy.
- Chat selection (`planDiscovery`): take the available backends that serve the vertical and clear the quality floor (`ALEVR_SEARCH_WEB_FLOOR`, default 0.55; news 0.45), then try the cheapest first. A free backend that answers empty escalates to the next one. A paid backend that answers empty does not. At most two backends are tried (`ALEVR_SEARCH_MAX_ATTEMPTS`). `ALEVR_SEARCH_ORDER` overrides the order.
- Research uses a fan-out (`planFanout`): every available backend is asked, results are fused by reciprocal rank, and each backend that answered is billed at its own price.

**Service** (`src/lib/search/alevr/service.ts`). Each search takes the cheapest path that is good enough:
1. **Exact query cache.** The key is the sha256 of the normalised query, vertical, recency, language, region and mode. TTL is 6 h for web, 2 h for week-bound searches and 30 min for news or day-bound searches.
2. **Page index.** It answers only when it has at least `count` fresh pages from at least 3 hosts that match every term. It is web only and never used for a time-bound query (`ALEVR_SEARCH_INDEX_ANSWERS=off` disables it).
3. **One discovery backend.** Index pages that match always join the candidates. Results from backends listed in `ALEVR_SEARCH_NO_STORE_BACKENDS` are never written to the query cache.

Every call is recorded in `WebSearchCall` with the path that served it, the backend, latency, cost and how many pages were already cached. No query text and no user are stored. A private chat writes nothing.

**Retrieval and page cache** (`src/lib/search/alevr/retrieve.ts`, `store.ts`, migration `20261004120000_alevr_search_cache`):
- Key: `canonicalUrl` with the port kept. `canonicalUrl` drops the port, which would let one port's page answer for another's.
- Content hash: sha256 of the normalised text. The index keeps one row per hash.
- Revalidation: ETag and Last-Modified are stored and sent as `If-None-Match` / `If-Modified-Since`. A 304 refreshes the copy without a body.
- Freshness comes from `max-age`/`s-maxage`, clamped to 5 min–7 d. The default is 24 h (`ALEVR_PAGE_TTL_SECONDS`).
- Postgres index: a stored generated `tsvector` (title weighted A, the first 100k characters of text weighted B) with a GIN index. Ranking uses `ts_rank_cd(…, 32)` with `DISTINCT ON (contentHash)`, plus freshness and language filters.
- The memory store (tests and the bench) uses BM25.
- Outbound links are kept, so a cached page still feeds Research's hop stage.
- `prune()` drops expired query entries and pages nobody has revalidated for 30 days.

**Ranking** (`src/lib/search/alevr/rank.ts`). Signals, each recorded on the result:
- engine agreement (reciprocal rank)
- BM25
- semantic similarity, only from an injected embedder; there is no fake score, and without an embedder its weight goes to lexical
- authority and source type, using Research's host heuristics so chat and Research weigh a source the same way
- freshness, with a half-life by intent
- language and region

Duplicates are removed by URL, by content hash, and by syndication (same title and near-identical snippet). A greedy host-diversity discount stops one host filling the list.

**Policy** (`src/lib/search/alevr/policy.ts`) is the single place that decides the route plan, Auto eligibility and the composer toggle. The model catalogues (`/api/models`, `/api/v1/models`, `/api/v1/bootstrap`) and `/api/app` (`features.alevrSearch`) follow the same decision.

**Research** (`src/lib/research/tools.ts`):
- `searchTheWeb` runs Alevr Search in fan-out mode, with the query cache in front and the index joining the candidates. It reports per-backend status to the timeline.
- `fetchResearchPage` goes through the page cache with the crawler as its extractor. The full text is cached and the run keeps its 16k-character slice.
- The evidence store, claims, coverage and citation verifier are unchanged and read from the same sources.

**SearXNG (optional, self-hosted)**:
- `deploy/searxng/docker-compose.yml` binds to loopback, requires a secret and drops capabilities.
- `deploy/searxng/settings.yml` enables JSON output, turns the limiter off (private network), keeps only official-API engines, and turns metrics off.

## Changed

- `src/app/api/chat/route.ts`: computes `planTurnSearch`. Alevr Search tools are bound into `toolSpecs`, and their sources are streamed and persisted through the accumulator. An Alevr turn sets `untrustedContentInTurn`, which means:
  - the untrusted-content rule is in the prompt
  - no memory is written
  - task, handoff, agent and room tools ask first

  Auto receives `alevrSearch`. Private chats are unchanged: they persist nothing, and the broker's audit row is persistence.
- `src/lib/auto-model.ts`: `isEligibleChatModel` no longer drops models without native search when Alevr Search can serve them. This was REALITY_AUDIT P1 row 4.
- `src/lib/web/search.ts` (`chatWebSearch`) and `src/lib/web/fetch-page.ts` now run through Alevr Search and the page cache. The query check, limits, provenance, injection scan, envelope and prefetch behave as before.
- `src/lib/web/extract.ts`:
  - returns validators and cache headers
  - reads the robots meta tag and the declared language, with bounded scans
  - sends conditional GETs
  - refuses any non-identity `Content-Encoding` by name
- `src/lib/research/crawler.ts`: the headless renderer now checks every request it makes (`headlessRequestAllowed`): http(s) only, no literal non-public address, and every DNS answer must be public. The fast path passes validators through.
- `src/lib/tools/entitlements.ts` (the rework planner): attaches the whole tool family under the same policy.
- System prompt: `ALEVR_SEARCH_NUDGE` names the tools and states that pages may contain hostile instructions. The untrusted-content rule now says that nothing inside the markers can:
  - change permissions or approvals
  - install anything
  - start tasks, agents or routines
  - reveal memory, the conversation or the system prompt
- Wire contract `CanonicalToolId` now includes `search_news` and `find_in_page`. Web and native presentation map them to search and read rows.

## Removed

- The public SearXNG instances (`searx.be`, `search.sapti.me`, `priv.au`) and the scraped DuckDuckGo HTML engine (BRIEF §16).
- `isSearchEngineAvailable()` used to return `true` always. It is now truthful: a keyed engine or the operator's SearXNG. A deployment without one no longer offers Research that cannot find pages.

## Tests

| Command | Result |
|---|---|
| `npx tsx --test tests/alevr-search-*.test.ts` | 45 pass, 1 skipped (DB-gated) |
| `ALEVR_SEARCH_TEST_DATABASE_URL=<throwaway migrated db> npx tsx --test tests/alevr-search-store-db.test.ts` | 6 pass (real Postgres 17: tsvector/GIN, DISTINCT ON, filters, upsert, 304 touch, query-cache expiry, call log, prune) |
| Existing suites touched by the change (web-search-profile, chat-toolset, web-provenance, search-ssrf, web-extract, web-transport, web-exfil, research-crawler, compat/anthropic tool loops, untrusted-content, tool-aliases, tool-registry, run-presentation, tool-entitlements, chat-tool-runtime, auto-model, native-model-catalog, action-approval, research*) | all pass |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | clean, except pre-existing errors from generated files this worktree lacks (`i18n-catalog.generated`, `runner/agent-core/dist`) |
| `npx eslint <changed files>`, `npm run capabilities:check`, `npm run native:wire:check` | clean |

What each new test file covers:
- `alevr-search-core`: backend selection; the cheapest-path service; query cache and index answers; private writes nothing; escalation and billing; news; fan-out; ranking signals, dedup and diversity; the in-page finder.
- `alevr-search-retrieve`: against a loopback server through the pinned transport:
  - ETag/Last-Modified/304
  - Cache-Control, robots and admission rules
  - the gzip-bomb refusal
  - `web_fetch` served from the cache, still enveloped, scanned and tainting
- `alevr-search-tools`: policy, Auto, the planner, `search_news`, `find_in_page` and the turn binding.
- `alevr-search-adversarial`: §17, below.
- `alevr-search-cross-provider`: the "same tools across providers" proof, below.
- `alevr-search-store-db`: the Postgres store.

**Same tools across providers** (`tests/alevr-search-cross-provider.test.ts`). The real Anthropic loop (Claude: its native search exists but is off) and the real OpenAI-compatible loop (DeepSeek: no native search) are driven by scripted transports. Both are handed the same Alevr Search toolset and the real dispatcher with a broker port. Each model searches, opens the top result, and finds a passage in it. The test asserts:
- both providers receive identical tool names and schemas, and neither receives a provider search tool
- every call passes the broker as a `juno_runtime` read
- both get the same results
- the second provider's identical search is served from the query cache at $0, and its page from the page cache with no request

## Benchmarks

`npx tsx scripts/alevr-search-bench.ts --json docs/rework/program/evidence/search-bench.json`

**These backends are SIMULATED.** The code under test is real: the service, ranker, selection, query cache, page cache and BM25 index. The backends are not:
- they return slices of a synthetic web of topic pages
- latency comes from fixed distributions on a virtual clock
- prices are the list prices in `src/lib/tools/metering.ts`

The workload is 240 searches over 22 topics with Zipf popularity, paraphrase variants, 4 news topics, one search every 3 minutes, and the model opening the top 2 results each time.

The numbers measure the caching and selection policy. They do not measure any provider's real quality or latency.

| Scenario | Cache hit | Served by (query cache/index/discovery/none) | Mean / p95 latency | $ per 1k queries | Page fetches (cache serves) |
|---|---|---|---|---|---|
| A. Serper only, no Alevr cache | 0% | 0/0/239/1 | 673 / 883 ms | 1.00 | 470 (0) |
| B. Serper + Alevr caches | 75.0% | 180/0/60/0 | 162 / 794 ms | 0.25 | 54 (426) |
| C. operator SearXNG first, Serper escalation, + caches | 75.4% | 180/1/59/0 | 320 / 1566 ms | 0.05 (+ SearXNG infra) | 52 (428) |
| D. Tavily only, no cache | 0% | 0/0/239/1 | 1346 / 1766 ms | 7.97 | 470 (0) |
| E. Tavily + Alevr caches | 75.0% | 180/0/60/0 | 325 / 1587 ms | 2.00 | 48 (432) |

Reading the table:
- On a repeated-query workload the query cache does most of the work: discovery spend falls by 4× at the same backend.
- The page cache removes about 90% of page fetches.
- Putting the operator's SearXNG first cuts the remaining spend by another 5×, at the price of a worse tail latency and an empty-answer rate that triggers escalation.
- The page index answered only once: with two pages opened per search it rarely holds five matching pages from three hosts. That threshold is deliberately conservative.
- **"Free" is not zero.** SearXNG needs a host, upkeep and upstream engines willing to serve it, and Postgres storage grows with the cache. Set `ALEVR_SEARXNG_COST_MICRO_USD` to put the amortised cost on the ledger.

**Measuring on your deployment.** With real keys, run real chat turns and query `WebSearchCall`:
```sql
SELECT "servedBy", "backend", count(*), avg("latencyMs"), sum("costMicroUsd")
FROM "WebSearchCall"
WHERE "at" > now() - interval '7 days'
GROUP BY 1, 2;
```
Then set `ALEVR_SEARXNG_QUALITY` from a side-by-side judgement of SearXNG and paid results on your own query set. The bench script's runner is the seam for a recorded replay.

## Security considerations (§17)

| Threat | Control | Test |
|---|---|---|
| SSRF, private IPs, metadata endpoints | `isDisallowedHost` on every hop. Pinned DNS answers are validated before connecting. Non-public result URLs never become candidates. | `alevr-search-adversarial` (metadata redirect, rebinding name, internal results), `search-ssrf`, `web-transport` |
| DNS rebinding | The pinned transport connects to the address it checked. The headless renderer re-resolves and checks every request. Residual: Chromium's own later lookup can differ, so headless rendering stays opt-in (`RESEARCH_HEADLESS`). | `headlessRequestAllowed` cases |
| Dangerous and infinite redirects | Manual redirect walk, guard on every hop, at most 5. | `web-transport`, adversarial |
| Oversized responses, decompression bombs | Streamed byte caps. `Accept-Encoding: identity`, and any other encoding is refused unread; nothing is ever inflated. | adversarial (2.5 MB stream cut at 256 KB), retrieve (8 MB gzip bomb) |
| Malicious MIME | Only html/text/json/xml/pdf parsers; anything else is refused by type. | `web-extract` |
| Prompt injection, hidden instructions | Text sits inside the untrusted envelope, and markers inside the page are defanged. Injection scan with audit. Turn taint: after a hostile page only the person's own URLs open. The system prompt says pages may be hostile and what they can never do. | adversarial (envelope cannot close; links of a hostile page unreachable) |
| Exfiltration by URL or query | Provenance ledger: no URL built or edited by the model, and parameters may only be dropped, never added. Credential-shaped URLs refused. Query check: credentials, ≥32-character private spans and the account email never leave, and never become a cache key or call row. | adversarial |
| Cache poisoning / cross-user leakage | Only search-discovered or research pages are admitted; a URL a person typed, memory, attachments and private chats never are. `no-store`/`private`/`noindex`/`noarchive` are respected. The key includes the port. A cached page is still scanned, enveloped and tainting when served. No user or query text is stored. | retrieve, adversarial (poisoned entry) |
| Pages altering permissions, starting agents or routines, exfiltrating memory | Every tool in the family is a `read_only` broker rule. An Alevr turn sets `untrustedContentInTurn`, so it writes no memory, and task, handoff, agent-config and room tools ask or refuse. The model never grants itself anything. | adversarial (route source assertions, broker classification) |

## Competitor comparison (current primary docs, read 2026-10-04)

| Product | What it does (documented) | Weakness for Alevr's purpose | Alevr's answer |
|---|---|---|---|
| Perplexity: [Search API](https://docs.perplexity.ai/docs/search/quickstart), [filters](https://docs.perplexity.ai/docs/search/filters/domain-filter), [pricing](https://docs.perplexity.ai/docs/getting-started/pricing), [Pro Search](https://www.perplexity.ai/help-center/en/articles/10352903-what-is-pro-search) | Ranked raw results with domain, language, country and recency filters. Search API $5/1k requests; Sonar request fees plus tokens. Pro Search reads many sources and cites them. | Opaque index. Its own product is search, not a neutral layer. | Could be added as one more paid backend behind the interface. Alevr keeps its own cache, ranking and costs. |
| OpenAI: [web search tool](https://developers.openai.com/api/docs/guides/tools-web-search), [pricing](https://developers.openai.com/api/docs/pricing) | Responses `web_search`: domain allow/block lists, user location, `external_web_access:false` for cache-only. `url_citation` annotations and a source list. $10/1k calls plus content tokens. | Only for OpenAI models. Costs per call on top of tokens. | The same tools on every model. Repeats served from Alevr's caches. |
| Gemini: [grounding](https://ai.google.dev/gemini-api/docs/google-search), [pricing](https://ai.google.dev/gemini-api/docs/pricing), [terms](https://ai.google.dev/gemini-api/terms) | `google_search` tool with inline citations. Gemini 3 is billed per query ($14/1k after 5,000 free a month). Search Suggestions must be displayed. Building indexes from results is prohibited. | Only for Gemini. The terms forbid indexing. | Grounding stays a provider fallback and is never cached or indexed by Alevr. |
| Anthropic: [web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool) | `max_uses`, domain filters, user location, always-on citations; $10/1k searches. Web fetch only opens URLs already in the conversation, refuses credential URLs and blocks private addresses. | Only for Claude. No owned cache. | Alevr's `web_fetch` has the same provenance discipline (the ledger predates this vertical) and adds turn taint, the page cache and `find_in_page`. |
| Hermes Agent: [web tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search) | `web_search` + `web_extract` over pluggable backends (Firecrawl default, SearXNG, Tavily, Exa, Brave, DDGS…). Truncation by character limit. 20-min caches. Private URLs blocked unless configured otherwise. | The page read does not document SSRF hardening or prompt-injection defences. Its "keyless fallback" rotates free tiers. | Same pluggability with a quality floor and cost order. Durable cache with revalidation. Documented §17 controls. No scraping or free-tier rotation. |

Not verified: which index Perplexity's API uses, and OpenAI's per-call price for the search-preview models.

## Remaining blockers

- **No live backend keys here.** Quality, latency and real cost on real traffic are unmeasured, and the bench is simulated and labelled as such. The SearXNG quality prior (0.6) is a judgement until an operator measures it.
- **Not exercised signed in.** No real-provider chat turn with Alevr Search has been run; the route is covered by typecheck, source assertions and the loop harness. Private and voice chats keep provider search.
- **Legal.** The storage terms of each paid API (Brave, Serper, Tavily, Exa) need review before their results are kept in the query cache. Until then, list them in `ALEVR_SEARCH_NO_STORE_BACKENDS`. Gemini's terms forbid indexing grounding results, which Alevr never stores.
- **Infrastructure.** The migration is not applied to any deployed database. SearXNG is not deployed. No scheduled `prune()` job exists.
- **Native.** The Swift presentation for the two new tool ids is edited and `swift build --target JunoChatKit` passes. There is no native UI acceptance for search rows.
- **Images and documents.** `search_images` and `search_documents` are not built: there is no backend for them.

## Next milestone

1. Turn on one keyed backend in staging, apply the migration, run 50 signed-in turns across Claude, GPT, Gemini, DeepSeek and Kimi with Alevr Search, and record `WebSearchCall` aggregates and citation quality per model.
2. Deploy the SearXNG example beside staging, measure its quality on the same query set, and set `ALEVR_SEARXNG_QUALITY` from that.
3. Add an embedder through `RankOptions.semantic` behind a flag and compare ranking on the recorded set.
4. Schedule `PostgresSearchStore.prune`, and add a `WebSearchCall` view to the operator dashboard.
