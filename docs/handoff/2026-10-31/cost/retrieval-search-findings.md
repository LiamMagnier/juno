# Cost dimension: embeddings, search and fetch

Repo: `/home/user/juno` at `e532983ea`. I read the code only and changed nothing. The arithmetic script is at `docs/handoff/2026-10-31/cost/calc/model.mjs`.

Rule for every item below: the user's chosen model, and the answer it gives, stay the same. Savings come only from four places:
- sending fewer duplicate or unused tokens;
- choosing a cheaper engine where the results are equivalent;
- caching;
- metering correctly.

## The short version

**Embeddings cost almost nothing.** Per Pro user per month they are below 0.01% of spend: about 51k query tokens at $0.02/M is about $0.001. The embedding problems are about correctness and latency, not money. The biggest of them is that the knowledge index is half-built: no code ever writes `KnowledgeChunk`. Because of that, project retrieval always returns nothing, and every project turn still sends the reference files whole.

**For chat, the money is the page and search text placed in the model's context, not the search engine's fee.**
- One `web_fetch` puts about 3.9k tokens into the context. About 28% of that is a list of links that duplicates links already written inline in the page text.
- A web turn's tokens cost about $0.032. The search fee on top is $0.002 with Serper or $0.016 with Tavily.

**For Research, the engine fees can be the largest bill.** The fan-out asks every keyed engine for 20 results on every query. With all four engines configured, that is $0.032 per query at real prices, $2.43 per broad run, and about 55% of a run's cost.

**The Exa price table over-bills by 42–54%.** Since Exa's pricing change of March 2026, highlights and text are included for the first 10 results.

**Code's `/api/code/search` uses the legacy path.** It fans out to every engine, at about $0.021 per search, with no query cache. Chat's cheapest-first path would cost $0.001 (Serper).

## Summary table

| ID | Change | Estimated saving | Quality risk |
|---|---|---|---|
| RS-1 | `web_fetch`: stop repeating links that already appear inline in the returned text | −21% of web_fetch tokens; about 1% of total (reference profile) | low |
| RS-2 | Research fan-out: at most 10 results per engine, fused list size unchanged | −27% (workers only) to −34% of research search fees with 4 engines; 9–11% of total in scenario A; about 0 with Tavily only | low–medium |
| RS-3 | `/api/code/search` through Alevr single-backend search and its query cache | −62% (Tavily) to −95% (Serper) per Code search | low |
| RS-4 | Fix the Exa price formula (highlights are included) | User-billed Exa fees −42% (5 results) / −54% (20 results); operator spend unchanged; research envelopes buy more for the same budget | none |
| RS-5 | Knowledge index: skip the useless embed now; build chunks and vectors at ingest; send passages instead of whole files above a size threshold | −86% of reference-file input cost on large-project turns; about 3.9% of total | (a) none, (b)/(c) medium, gated |
| RS-6 | Ops: make sure Serper (or a SearXNG instance that clears the quality floor) is the first chat engine | −87.5% of chat search fees if Tavily is primary today; about 2.8% of total in scenario T | low |
| RS-7 | Private chats: use Alevr Search in read-only mode instead of provider-native search ($10–14/1k plus result tokens) | About −$0.02 per search on those turns; under 1% of total; needs measurement | low–medium, needs privacy review |
| RS-8 | Embedding hygiene: memoise per turn, skip inactive memory rows, bill by usage, replace the shut-down `text-embedding-004` | Under 0.01% in dollars; saves 100–400 ms of first-token latency on project turns | none |
| RS-9 | Duplicate-fetch hygiene: pointer on a deduplicated fetch, in-flight map for parallel research opens, no fee on cache hits | Under 0.5% | none–low |
| RS-10 | Query-focused window for long pages (behind a flag, after an eval) | Up to −15% of web_fetch tokens; about 0.8% of total | medium |
| RS-11 | Per-backend query cache (shared between chat and research, no-store kept separate) and light query normalisation | Low single-digit % of search fees | low |
| RS-12 | Research worker search digest: show the top 10 hits, store all | Under 1% of a run | low |

## 1. What happens today

### 1.1 Embeddings

**Model list.** `src/lib/knowledge/embed.ts:68-75` lists the models in order:
- `openai:text-embedding-3-small` (1536 dimensions)
- `-3-large` (3072)
- `google:text-embedding-004` (768)
- mistral, zhipu and qwen models

`resolveBackgroundCandidates` filters this list by the account's background-provider policy (`embed.ts:195-220`). `preferModelId` pins the account's existing vector space.

**Request limits.** At most 64 inputs per request and 8,000 characters per input, with `maxRetries: 0`, so a retry never duplicates spend (`embed.ts:116-134`).

**Billing.** Billing estimates tokens as `chars/3` (`embed.ts:232-239` → `src/lib/metering/unit-prices.ts:121-133`): 3-small $0.02/M, 3-large $0.13/M, text-embedding-004 $0.20/M, unknown models $0.20/M. It ignores the `usage.prompt_tokens` the API returns.

**`text-embedding-004` was shut down on 2026-01-14.** Google's replacement is `gemini-embedding-001`, at $0.15/M ([Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations), [Gemini Embedding GA post](https://developers.googleblog.com/gemini-embedding-available-gemini-api/)). The model is still in the list. So any account whose policy permits only Google (`same_provider` on a Gemini chat) makes a failing embedding call on every attempt. The cost is nothing in dollars; the effect is that semantic memory is lost for those accounts.

**Memory writes.** `saveCandidates` → `embedMemoryEntries` (`src/lib/memory.ts:846-897`) embeds:
- every newly created row, including rows created as `superseded`, `expired` or `rejected` (`memory.ts:1129`), even though retrieval only reads `status: "active"`;
- refreshed rows that lack a vector (`memory.ts:1084`).

Lazy embedding on reinstatement already exists (`needsEmbedding`, `memory.ts:1348`, `1420`).

**Memory reads.** On each chat turn, `getMemoryProfile` embeds the latest user message (`src/lib/chat/turn/memory.ts:53`, `memory.ts:1966-2031`, 4-second timeout). It is skipped when the account has no stored vectors.

**The same text is embedded up to three times per turn:**
- memory (`chat/turn/memory.ts:53`);
- project knowledge (`chat/turn/project-context.ts:99-136`, the same latest user text);
- voice and context-mention retrieval (`context-resolve.ts:110-119`, `api/voice/context/route.ts:120`).

### 1.2 The knowledge index is half-built

**Blocks are written; chunks are not.** Ingest writes `KnowledgeBlock` rows only (`src/lib/knowledge/ingest.ts:239`, `index.ts:63-91`). Nothing in the source writes `KnowledgeChunk`:
- the only references to it are reads (`retrieve.ts:227`, `lexical-query.ts:110`) and a tombstone update (`library-removal.ts:64`);
- `packDocumentChunks` (`chunk.ts:232`) has no caller outside tests;
- `prisma/schema.prisma:4376-4401` defines `embedding Float[]` and `embeddingModel` on a table that stays empty.

**Retrieval does all its work and finds nothing.** `retrieveKnowledge` embeds the query first (`retrieve.ts:311-318`), then runs a lexical query and a vector query against `KnowledgeChunk` (`retrieve.ts:320-356`). Both return no rows.
- This path runs for every project turn whose project has ready documents (`retrieveProjectKnowledge`, `retrieve.ts:475-513`).
- It also runs for folder lineages and for project files in voice context and research private retrieval (`research/private-retrieval.ts:107-129`).
- Each call pays a query embedding: about $0.000007 and 100–400 ms before the first token. It also writes one `ApiSpend` row.
- Direct chat attachments return null before the embedding (`retrieve.ts:548`), because `scheduleIngest` does not index them (`knowledge/index.ts:296`).

**Consequence: every project turn sends every reference file whole.** Because `projectKnowledge` is only set when there are passages (`project-context.ts:137-143`), `buildProjectReferenceFiles` always includes every file with extracted text, wrapped and placed in the first user turn (`context-assembly.ts:181-195`, `project-context.ts:290`, `311-314`). Each file holds up to 200k characters (`knowledge/index.ts:137`). There is no size budget at this step. The router's context estimate assumes that retrieval replaces the indexed files (`src/lib/router/chat-context.ts:128-135`); with no chunks, it never does.

### 1.3 Chat search (`web_search`, `search_news`)

**Policy.** When a backend clears the quality floor, every tool-capable model gets Alevr's tools. Provider-native search is off by default (`src/lib/search/alevr/policy.ts:55-63`). Private and voice turns fall back to provider-native search (`policy.ts:59`).

**One backend, cheapest first.** Chat asks at most two backends, cheapest first among those above the floor (`backends.ts:218-239`, `service.ts:342-355`). The default is 5 results (max 8, 300-character snippets) (`tools/specs/web-search.ts:53-57`, `web/search.ts:52-56`).

**Caches, cheapest path first:**
- Exact query cache: a sha256 of the normalised query plus vertical, recency, language, region and mode (`service.ts:90-101`). TTL is 6 hours for web, 2 hours for week-bound searches, 30 minutes for news and day-bound searches (`service.ts:104-108`).
- Page index: answers when it holds at least `count` fresh pages from at least 3 hosts (`service.ts:311-336`).
- Discovery (`service.ts:342-355`).

**Privacy.** The caches are shared across users with no user id or query text stored. Private chats read but never write (`service.ts:271`, `409`). Backends listed as no-store are never written (`service.ts:405-419`).

**Engine requests:**
- Tavily: `search_depth: "basic"` with `include_raw_content: true` (`search-engine.ts:255-266`). The raw page goes to the turn's prefetch, so `web_fetch` can serve it without a network request (`web/search.ts:206-208`, `fetch-page.ts:352-354`).
- Exa: `highlights` (`backends.ts:44`, `search-engine.ts:215-218`).

**Repo price table** (`src/lib/tools/metering.ts:70-82`, copied in `research/search-metering.ts:27-39`):

| Engine | Repo price |
|---|---|
| Tavily | $0.008 per call |
| Serper | $0.001 (up to 10 results) / $0.002 (more) |
| Brave | $0.005 |
| Exa | `7,000 + 1,000·max(0, n−10) + 1,000·n` µUSD |

**Tool results do not carry over to later turns.** Later turns get a history note, not the result (`project-context.ts:292-320`). Within a turn, the dispatcher deduplicates identical arguments but re-sends the full cached text plus a note (`src/lib/tools/dispatch.ts:449`).

### 1.4 Chat fetch (`web_fetch`)

**Window.** The default window is 16,000 characters, between 1,000 and 40,000 (`fetch-page.ts:100-102`). The turn's character budget is 60k–200k, by tier (`web/limits.ts:33-36`).

**Duplicated links.** Each result also carries "Links on the page:" with up to 40 entries in the form `[n] text — url` (`fetch-page.ts:104`, `260-262`).
- The extractor already writes every body link inline as `[text](href)` (`src/lib/web/html-text.ts:26`, `694-708`).
- So every link inside the window appears twice.
- The ledger separately records up to 120 links for provenance (`fetch-page.ts:274`), whether or not they are shown.

**Token cost.** 40 × about 110 characters is about 4.4k characters, roughly 1.1k tokens per fetch: **27.8%** of a typical result (11k window + 4.4k links + 0.4k metadata ≈ 3.95k tokens).

**Page cache.** Fetches go through Alevr's page cache, with a 24-hour default TTL, ETag/Last-Modified revalidation and `no-store`/robots respected. Only pages found by a search are admitted. Pages are shared across users, and private chats never write (`search/alevr/retrieve.ts:72-188`).

### 1.5 Research search and fetch

**Every engine, every query.** `searchTheWeb` uses Alevr fan-out mode (`research/tools.ts:739-790`). Each available backend is asked for `count` results (`service.ts:356-358`; `count` is 12, 20 or 30 by breadth, `research/envelope.ts:219`). The results are fused into a list of `max(2·count, 20)` and ranked to `count`.

**How many queries a run makes.** Sweep searches run 4 at a time (`stages/limits.ts:236`, `corpus.ts:130-150`). Worker searches cover about 1 in 3 tool calls. A broad 5-question run therefore makes about 16 sweep queries and about 60 worker queries (envelope arithmetic, `envelope.ts:255-270`, `404`).

**How many are read.** Workers open about 1 page per search (`CALLS_PER_PAGE=3`). Of about 1,500 hits per run, roughly 40 pages are read (envelope `pages`), about 3%.

**Duplicate controls already in place:**
- near-duplicate queries are refused (`stages/workers.ts:281-301`);
- results are shared within a round (`workers.ts:283-289`);
- Tavily raw content becomes the stored snapshot, so the page is not fetched again (`corpus.ts:186-203`);
- the page cache is shared with chat (`tools.ts:795-826`).

**Fees charged regardless.** `fetchResearchPage` records `PAGE_FETCH_FEE_MICRO_USD = 500` for every page, including pages served from the cache (`tools.ts:868`, `domain.ts:2106`). Parallel workers opening the same URL in the same wave both fetch it; the per-host limiter exists, but there is no in-flight map (`stages/context.ts:60-77`, `workers.ts:369-397`).

**Reranking is free.** It runs in process (`search/alevr/rank.ts`, `knowledge/rank.ts:247`). There is no paid reranker, and no embedder is passed to `RankOptions.semantic`.

### 1.6 Code search

`/api/code/search` → `meteredWebSearch` → `searchWithEngineReport` with no engine filter (`src/lib/web-search.ts:65-98`, `src/app/api/code/search/route.ts:70-87`):
- every keyed engine;
- at least 10 results per engine (`search-engine.ts:549-551`);
- no Alevr query cache.

The native Mac Code app calls it too (`native/Packages/JunoCode/Sources/JunoCodeBridge/BackendCodeWebSearchClient.swift:32`).

### 1.7 Provider-native search (fallback paths)

Provider-native search is used for private chats, voice, models without tools, and three labs whose own search rides the request: Z.ai at $0.01 per use, MiMo at $5/1k, Qwen (`src/lib/lab-web-search.ts`).

## 2. Prices used (checked 2026-10-31)

Direct fetches of the vendors' pricing pages failed in this sandbox: the hosts `exa.ai`, `docs.tavily.com`, `developers.openai.com` and `ai.google.dev` do not resolve here. The figures below come from search results restricted to the vendor's own domain where possible. Each row says how well it is confirmed.

| Item | Price | Source |
|---|---|---|
| Exa search with contents | $7/1k requests with **10 results, text and highlights included**; +$1/1k per result beyond 10 (change of March 2026); Lite (cache-only) $4/1k | [Exa changelog](https://exa.ai/docs/changelog), [Exa pricing docs](https://exa.ai/docs/reference/pricing) (Exa's own domain) |
| Tavily search | basic 1 credit, advanced 2; pay-as-you-go $0.008 per credit; no separate charge found for `include_raw_content` | [Tavily credits](https://docs.tavily.com/documentation/api-credits.md), [basic vs advanced](https://help.tavily.com/articles/6938147944-basic-vs-advanced-search-what-s-the-difference) |
| Serper | about $1/1k (up to 10 results), 2 credits for 11–100 results | third-party only: [apiserpent](https://apiserpent.com/blog/serper-pricing-credits-explained), [parallel.ai](https://parallel.ai/articles/serper-vs-parallel) (unverified against serper.dev) |
| Brave Search API | $5/1k (Pro); Base $3/1k per Brave's docs page | [Brave API pricing](https://api-docs.search.brave.software/pricing), [Brave plans](https://api-dashboard.search.brave.com/app/plans) |
| Anthropic native web search | $10/1k searches plus result tokens, which count as input in later requests | [Claude web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| OpenAI native web search | $10/1k calls (down from $25, April 2026); content-token billing varies by model | third-party: [pricingsaas tracker](https://pricingsaas.com/companies/openai.api/diffs/2026W14) |
| Gemini grounding | $14/1k after 5,000 free per month (Gemini 3) | the repo's `docs/rework/program/SEARCH.md` (read 2026-10-04), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing); not checked again here |
| OpenAI `text-embedding-3-small` | $0.02/M; `dimensions` parameter shortens vectors; the 50% batch rate is unconfirmed | [OpenAI model page](https://developers.openai.com/api/docs/models/text-embedding-3-small.md) |
| Google embeddings | `text-embedding-004` shut down 2026-01-14 → `gemini-embedding-001` $0.15/M | [deprecations](https://ai.google.dev/gemini-api/docs/deprecations), [GA post](https://developers.googleblog.com/gemini-embedding-available-gemini-api/) |
| Cache rates used for tool-result tokens | Sonnet-5.5-class: $2/M input, $0.20 cache read, $2.50 5-minute write | the repo's `docs/pricing/COST_ENGINEERING.md` §5; [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) |

## 3. Reference profile and arithmetic

All of these are assumptions; replace them with measurements (§5). I extended the "busy Pro user" profile from `COST_ENGINEERING.md` §5 (300 turns, chat spend of $8.90 after the earlier caching fixes):

- **Web:** 15% of turns use the web (45 per month), each with 2 searches and 2.5 fetches. A tool-result token is written to cache once and read on about 2 later requests in the turn: (2.50 + 2×0.20)/M = **$2.90/M**.
  - Fetch: 3,950 tokens × 2.5 × $2.90/M = **$0.0286 per web turn**. Links alone: 1,100 × 2.5 × 2.9/M = $0.0080.
  - Search results: 2 × 600 tokens × 2.9/M = $0.0035.
  - Fees: $0.002 with Serper, $0.016 with Tavily.
  - Web turn: **$0.034 (Serper) or $0.048 (Tavily)**. Monthly: $1.54 or $2.17.
- **Projects:** 10% of turns (30) are in a project with 30k tokens of reference files, and 40% of those find the cache cold.
  - Per turn: 0.6×30k×0.20/M + 0.4×30k×2.50/M = **$0.0336**. Monthly: $1.01.
- **Research:** 4 broad runs per month, each with 76 queries at 20 results, plus an assumed **$2 per run of model spend**.
  - Real per-query fees at 20 results: Tavily only $0.008; Serper+Tavily $0.010; all four (Serper 0.002 + Brave 0.005 + Tavily 0.008 + Exa 0.017) **$0.032**.
  - Per run: $0.61, $0.76 or **$2.43**. Fees are 23%, 28% or **55%** of a run.
- **Monthly totals:**

| Scenario | Chat search | Research roster | Total per month |
|---|---|---|---|
| S | Serper | Serper + Tavily | $22.48 |
| A | Serper | all four engines | $29.17 |
| T | Tavily | Tavily only | $22.51 |

## 4. Findings

### RS-1. Do not repeat links the page text already contains (`web_fetch`)

**Today.** `fetch-page.ts:260-262` appends up to 40 `[n] text — url` lines inside the untrusted envelope. The window text already has the same body links inline as `[text](href)` (`html-text.ts:694-708`). PDFs and prefetched Tavily text have no inline links: the PDF reader returns links without text (`extract.ts:250`), and the prefetch path carries no list at all (`fromPrefetch`).

**Saving.** Show only links that are **not** already in the returned window, capped at 10, about 1.1k characters instead of 4.4k. That cuts 3.3k of the 15.8k characters: **−21% of web_fetch tokens**.
- Per web turn: 0.75 × $0.0080 = $0.0060. × 45 = $0.27 a month.
- That is **1.2% of the scenario S total (0.9% in A)** and about 15% of chat-web token cost.

**Quality risk: low.**
- Every link in the window is still visible inline and still in the provenance ledger, so `web_fetch` can open it (`fetch-page.ts:274` is unchanged).
- Links outside the window remain reachable through `offset`, and through the 10 links still shown.
- PDFs keep their list (up to 20), because their text has no inline links.

**Implementation** (`src/lib/web/fetch-page.ts`, `present()`):
- collect `inline = new Set([...window.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(m => m[1]))`;
- `links = page.links.filter(l => !inline.has(l.href)).slice(0, page.contentType === "pdf" ? 20 : 10)`;
- add `linksShown` to `ToolWebDetail`;
- update the expectations in `tests/web-*.test.ts` and `tests/alevr-search-retrieve.test.ts`.

**Measure.**
- `llm.request` cache-write and fresh tokens on rounds after a `web_fetch`, before and after (`src/lib/llm/request-meter.ts`).
- Average `web.chars` plus the new `linksShown` field.
- In `scripts/eval-juno.ts` web tasks, citation correctness and the rate at which the model opens a second page through a link, which should not fall.

### RS-2. Research fan-out: ask each engine for at most 10 results and keep the fused list size

**Today.** Each engine is asked for the full `count` (`service.ts:358` → `runBackend` uses `input.count`). Serper charges 2 credits above 10 results and Exa charges $1/1k per result above 10. Tavily (flat, up to 20) and Brave (flat, up to 20) cost the same either way.

**Saving.** With four engines, cost per query goes from **$0.032 to $0.021**.
- Workers only (60 of the 76 queries): $2.43 → $1.77 per run, **−27% of research search fees**, or $2.64 a month = **9.0% of the scenario A total**.
- All queries: −34%, $3.32 a month, 11.4%.
- Scenario S: −8% to −10% of fees (about 1% of total). Tavily only: 0.

**Quality risk: low–medium.**
- Four engines × 10 results still gives 25–35 unique URLs after overlap, so the ranker's top 20 stays full.
- Only each engine's ranks 11–20 are dropped. Their reciprocal-rank weight is the lowest (RRF k=60: rank 1 = 0.0164, rank 15 = 0.0133), and a URL two engines agree on at rank 5 scores 0.031. So the tail rarely reaches the top 20 unless engines agree on it.
- Apply this only when at least 2 engines are in the plan. With one engine, keep `count`.

**Implementation.**
- `src/lib/search/alevr/service.ts`: in fan-out mode call `runBackend(backend, { ...input, count: plan.length >= 2 ? Math.min(input.count, 10) : input.count })`. The fusion size (`Math.max(input.count*2, 20)`) and `rankResults(count)` stay as they are.
- `src/lib/research/run.ts:682` (`ROSTER_RESULTS_PER_QUERY`) and `research/search-metering.ts` `researchRoster`: price the per-engine count, so envelopes are not over-reserved.

**Measure.**
- `WebSearchCall` rows for research: `avg(costMicroUsd)`, and the fused result count.
- `scripts/eval-research-citations.ts` on a fixed set of goals: sources found, citations verified, coverage share. The change ships only if these stay within noise.

**Further option (RS-2b, medium risk, only after an eval).** Tiered fan-out: ask Serper and Brave first ($0.006 at up to 10 results). Add Tavily and Exa only when the union is short of target, or engine agreement is low. If 60% of queries stop at the first tier, cost is 0.4×0.021 + 0.6×0.006 = $0.012 per query, a further −43%. Breadth is what Research sells, so this needs the citation eval first.

### RS-3. Send Code search through Alevr single-backend search

**Today.** Every keyed engine is asked on every Code search, with no query cache (`web-search.ts:65-98`). With four engines that is $0.021 real and $0.031 billed (including the Exa error in RS-4). With Serper+Tavily it is $0.009.

**Saving.** The cheapest backend that clears the floor answers ($0.001 Serper, $0.008 Tavily), plus the shared 6-hour query cache.
- **−95% (Serper) or −62% (Tavily) per call**, before any cache hits.
- Example: a Code-heavy user making 300 searches a month saves about $6.

**Quality risk: low.** This is the same search profile chat already uses for every model, with at most one escalation on failure, and Code asks for 5 results by default.

**Implementation.**
- `src/app/api/code/search/route.ts`: replace `meteredWebSearch` with `alevrSearch({ surface: "code", mode: "single", private: false, vertical: "web", count })`, and bill `found.costMicroUsd` as `juno-tool:web_search` with `kind: "code"`.
- Admission estimate: the cheapest planned backend's price × `ALEVR_SEARCH_MAX_ATTEMPTS`.
- Add `"code"` to `SearchCallRecord["surface"]` (`src/lib/search/alevr/types.ts`).
- The same applies to the other `meteredWebSearch` callers named in its comment (Work `web_search`, topic monitor) if they are still wired.

**Measure.**
- `ApiSpend` rows with `model='juno-tool:web_search' AND kind='code'`: sum and count per day.
- `WebSearchCall` rows with `surface='code'`, grouped by `servedBy`.

### RS-4. Fix the Exa price (meter correctness: the user's budget, the envelope and engine ordering)

**Today.** `metering.ts:79-80` and `search-metering.ts:37` charge a further $1/1k per result for highlights. Exa's March 2026 change includes text and highlights for the first 10 results.

| Results | Billed | Real | Over-billed |
|---|---|---|---|
| 5 (chat) | $0.012 | $0.007 | 42% |
| 12 | $0.021 | $0.009 | 57% |
| 20 | $0.037 | $0.017 | 54% |
| 30 | $0.057 | $0.027 | 53% |

**Effect on users.** With four engines, research search fees billed to the user are $0.052 per query instead of $0.032 (**−38% once fixed**), about $1.52 of budget per run. Operator spend does not change.

**Effect on Research quality.** `researchBudgetFor` prices the roster from this table (`envelope.ts:410`). The inflated estimate makes `fit()` trim results per query, rounds or workers sooner for accounts with tight budgets. Fixing it gives those users more research for the same money.

**Effect on chat engine order.** It also corrects the cheapest-first order in `planDiscovery`: Exa at 5 results is $0.007, which ranks it before Tavily at $0.008.

**Quality risk: none.**

**Implementation.**
- `exa: 7_000 + 1_000 * Math.max(0, n - 10)` in `src/lib/tools/metering.ts`.
- Delete the copied table in `src/lib/research/search-metering.ts` and import the single source.
- Add a test pinning the Exa prices.
- Optional, and free since the change: ask Exa for `text` in research fan-out (`backends.ts:44`). That fills snapshots for Exa hits, so READ skips its own fetch and fee.

**Measure.** Compare one day's Exa invoice with `sum(costMicroUsd)` from `WebSearchCall` rows whose `backends` include exa.

### RS-5. Knowledge index: stop the useless embed now, then build it so large projects send passages

**(a) Today, for nothing.** Each project turn with ready documents makes 1 embedding call, 2 database queries and 1 ledger write, and gets zero passages back.
- Fix: before `embed()` in `retrieveKnowledge` (`retrieve.ts:311`), run one `EXISTS` query on `KnowledgeChunk` for this scope. If there are none, return lexical-empty.
- Saving: $0.000007 per turn (negligible), **100–400 ms of first-token latency** and one `ApiSpend` row per project turn.
- Quality risk: none.

**(b) and (c) The real money: reference files sent whole.**
- 30k reference tokens cost $0.0336 per turn on average (§3).
- Retrieval sends 2,400 tokens of passages (`DEFAULT_PACK.tokenBudget`, `knowledge/rank.ts:345`) in the uncached tail: 2.4k × $2/M + about $0.00001 for the embedding = $0.0048.
- That is **−86% on those turns**: about $0.87 a month in the profile, or **3.9% of the scenario S total**.
- Building the index is cheap. A 200k-character document is about 50k tokens: **$0.001 to embed** with 3-small (half that through the Batch API, if the batch rate holds).
- Chunking is deterministic (`chunk.ts`: "reindexing an unchanged document produces byte-identical chunks"), so a parser bump can reuse vectors by chunk-text hash.

**Quality risk: medium if applied to every project; low–medium if gated.**
- Keep whole files when the project's total reference text is at or below a threshold, for example 20k tokens or 15% of the model's context window. Use passages only above it, as Claude Projects switches to retrieval only near the limit.
- `read_document` remains for reading a whole file.

**Implementation.**
- `src/lib/knowledge/ingest.ts`, after `replaceBlocks`: `packDocumentChunks(blocks)` → write chunks → `embedTexts` in 64-input batches → set `embedding` and `embeddingModel`; leave the vector empty when policy denies.
- Add a backfill job for documents that are already ready.
- `src/lib/chat/turn/project-context.ts`: apply the threshold.
- `src/lib/router/chat-context.ts:128-135` already assumes the replacement.
- While `KnowledgeChunk` is still empty, choose `dimensions: 512` for 3-small. The API price is the same, but stored vectors and in-process cosine memory are 3× smaller.

**Measure.**
- Input, `cacheWriteTokens` and `cacheReadTokens` per project turn (`Message` usage columns).
- `retrieval.mode` and passage counts.
- A project question-and-answer eval set (pattern: `src/lib/memory-eval.ts`).
- Regenerate and thumbs-down rate in project chats.

### RS-6. Ops: make sure chat's first search engine is the cheap one

`planDiscovery` already orders by cost (`backends.ts:234-238`). If the deployment has only `TAVILY_API_KEY` (the one named in `deploy/ecosystem.config.js:32`), every chat search costs $0.008.

**Saving.** Add `SERPER_API_KEY`, which the repo's own priors rate higher (0.90 web against Tavily's 0.86, `backends.ts:120-127`). Chat search fees fall from $0.016 to $0.002 per web turn: **−87.5%**, $0.63 a month, **2.8% of the scenario T total**.
- A self-hosted SearXNG that clears the floor (`deploy/searxng/`) cuts fees further, per the repo's simulated bench in `SEARCH.md`. It still has infrastructure cost.
- One thing is lost: Tavily's raw-content prefetch, which saves page fetches. Those fetches cost latency, not money.

**Quality risk: low.** The cache and ranker are the same.

**Measure.** `WebSearchCall` with `surface='chat'`, grouped by backend: `count(*)`, `avg("costMicroUsd")`. Check this before deciding anything.

### RS-7. Private chats use provider-native search

**Today.** `policy.ts:59` turns off Alevr tools for private chats, so they use the provider's own search: Anthropic and OpenAI $10/1k, Gemini $14/1k after the free tier, plus result content counted as input tokens.

**Saving.** Alevr search with read-only caches. `service.ts` already supports `private: true`: it reads the caches, writes nothing and records no call.
- Assume an Anthropic native search adds about 5k input tokens against 0.6k for Alevr. The difference, (5k − 0.6k) × $2.90/M, is $0.0128, plus the fee difference of $0.009: **about $0.02 per search**.
- If 10% of web turns are private, that is $0.20 a month, under 1%. The token figure is an assumption to measure.

**Quality risk: low–medium.** Normal chats already use Alevr search. The real blocker is privacy: the broker's audit rows and the provenance ledger's writes in private mode. That needs review (`src/lib/search/alevr/turn.ts:83` already skips the audit sink when private). Voice keeps native search, because its transports cannot carry tools.

**Measure.** Share of turns with native search by provider and private flag. `llm.request` input tokens on native-search rounds.

### RS-8. Embedding hygiene (correctness and latency; dollars negligible)

1. **Memoise per request.** Key by model and sha256 of the text (React `cache()` around `embedQuery`, or AsyncLocalStorage), so memory, project and context retrieval of the same message embed it once. That saves up to 2 calls per turn.
2. **Embed only active rows.** `memory.ts:1129`: push to `toEmbed` only when `plan.status === "active"`. Reinstatement already embeds lazily.
3. **Bill by usage.** Use `response.usage.prompt_tokens` (`embed.ts:136-150`) instead of `chars/3`. That over-states by about 25–33%, which is negligible.
4. **Replace the shut-down model.** Swap `google:text-embedding-004` (`embed.ts:71`) for `google:gemini-embedding-001` at $0.15/M, with `dimensions` set to 768, and add the price to `unit-prices.ts`. Rows stored under 004 stay in a dead space; re-embed them through a batch job (about $0.0002 per user).
5. **Keep 3-small.** It is the cheapest model listed. `-large` costs 6.5× more for no measured gain here.

**Quality risk: none.** Items 1 and 3 change nothing a user sees. Item 4 restores semantic memory for Gemini-only policies.

**Measure.** `ApiSpend` rows matching `embedding:%` per chat turn (should be at most 1). First-token latency on project turns.

### RS-9. Duplicate-fetch hygiene

**Chat.** A deduplicated `web_fetch` re-sends the full cached text (`dispatch.ts:449`). For read tools whose earlier result is over 2k characters and still in the transcript, return a pointer instead: "identical to the result of call N above".

**Research.** Add an in-flight `Map<canonicalUrl, Promise>` in the round's shared state (`stages/workers.ts:369-397`). Return `costMicroUsd: 0` when `openPage` served from cache or revalidated (`tools.ts:795-826`, `868`); this affects users' budgets only.

**Saving.** Under 0.5% overall. Measure first: count `ResearchEvent` `source_read` events with the same URL in a run, and dispatcher cache hits for `web_fetch`.

**Quality risk: none–low.** A pointer is only safe while the earlier result has not been removed from the transcript to save context.

### RS-10. Query-focused windows for long pages (behind a flag, after an eval)

When the page is longer than the window and `offset == 0`, return:
- the first 3k characters;
- the BM25 passages for the turn's last search query and user message, from `src/lib/search/alevr/find.ts`, with their offsets labelled, up to about half the window.

Assume half of fetched pages exceed 16k characters: about −25% of window tokens on those pages, about −15% of web_fetch tokens, about 0.8% of total.

**Quality risk: medium.** The model reads less of the page in order. Ship only if the `scripts/eval-juno.ts` web set shows equal accuracy.

### RS-11. Query cache: per-backend entries and light normalisation

**Today.** `queryCacheKey` includes `mode` (`service.ts:92`), so chat and Research never share an entry. In fan-out, one no-store backend blocks caching of the whole fused result (`service.ts:407-408`).

**Fix.** Cache each backend's list under (backend, query, vertical, recency, language, region, count bucket). Fan-out then re-asks only the backends that are missing or no-store, and chat can reuse a Research run's Serper list. Normalisation: strip surrounding quotes and trailing punctuation.

**Saving.** Low single-digit % of search fees. Measure the share of `WebSearchCall` rows served from the query cache.

**Quality risk: low.** The same TTLs and privacy rules apply: no user id, no query text, private chats never write.

### RS-12. Research worker search digest: top 10

`renderSearchDigest` shows all 20–30 hits with 300-character snippets (`agents/protocol.ts:510-518`), about 2.3k tokens per search. Show the policy-ranked top 10 and keep storing every hit as a source. That saves about 69k worker transcript tokens per run, about $0.05 on a cheap worker model and under 1% of a run.

**Quality risk: low.** Workers open about 1 page per search, and the ranker puts primary records first (`workers.ts:363`).

## 5. Checked and not worth changing

- Embedding batching (64 inputs per request) and no SDK retries: no duplicate spend.
- Cross-user query cache (6 hours) and page cache (24 hours, ETag/Last-Modified revalidation) exist, with the right privacy rules (§1.3, §1.4).
- Provider-native search is off by default ($10–14/1k against $1/1k for Serper).
- No paid reranker; all ranking runs in process.
- Tool results are not carried into later turns.
- Research already refuses near-duplicate queries, shares results within a round, stores Tavily raw content and shares the page cache.
- No `prune()` job is scheduled (`store.ts:289-294`). This is database growth, not API spend.

## 6. How to measure (run before and after each change)

```sql
-- Search spend and cache share by surface/path/backend (7 days)
SELECT surface, "servedBy", backend, count(*), round(avg("latencyMs")) AS ms,
       sum("costMicroUsd")/1e6 AS usd, round(avg(results),1) AS avg_results
FROM "WebSearchCall" WHERE at > now() - interval '7 days' GROUP BY 1,2,3 ORDER BY usd DESC;

-- Billed tool fees and embeddings per kind
SELECT kind, model, count(*), sum("costMicroUsd")/1e6 AS usd
FROM "ApiSpend" WHERE "createdAt" > now() - interval '7 days'
  AND (model LIKE 'juno-tool:%' OR model LIKE 'embedding:%') GROUP BY 1,2 ORDER BY usd DESC;

-- Research: search vs fetch vs model spend per run (bill() labels), and duplicate opens
SELECT "runId", count(*) FILTER (WHERE kind='query_issued') AS queries,
       count(*) FILTER (WHERE kind='source_read') AS reads,
       count(DISTINCT payload->>'url') FILTER (WHERE kind='source_read') AS distinct_reads
FROM "ResearchEvent" WHERE "createdAt" > now() - interval '7 days' GROUP BY 1;

-- Project knowledge reality check: should be 0 today (RS-5)
SELECT count(*) FROM "KnowledgeChunk";
```

Token side:
- Read the `llm.request` structured log lines (`src/lib/llm/request-meter.ts`): fresh, cache-read and cache-write tokens per round, on turns with `web_fetch` and on project turns.
- `scripts/cost-per-accepted.ts` checks that cost per accepted answer falls while the accept rate holds.

Quality gates:
- `scripts/eval-research-citations.ts` for RS-2;
- the `scripts/eval-juno.ts` web set for RS-1 and RS-10;
- a project question-and-answer set for RS-5;
- `scripts/alevr-search-bench.ts` for RS-3, RS-6 and RS-11.
