# Deep Research: protocol upgrade (Oct 2026)

The owner gave Deep Research a five-stage protocol to follow. In short: MECE decomposition, breadth-first mapping of primary sources, recursive multi-hop extraction, a gap audit before writing, and an institutional report. This document records three things: how the pipeline actually behaved before against that protocol, what changed, and what is still open. Code paths are in `src/lib/research/`.

## How the pipeline runs (unchanged shape)

`engine.ts` is a durable state machine:
`accepted → clarifying → planning → (awaiting_plan_confirmation) → investigating ⇄ reviewing → synthesizing → validating_citations`.

- **planning** (`stages/planning.ts`, `planner.ts`, `planner.prompt.ts`): one structured lead-model call returns questions, queries, clarifications and scope. `envelope.ts` turns the scope into workers, rounds, pages and money.
- **investigating** (`stages/corpus.ts`, `stages/workers.ts`): the seed sweep searches the plan's queries, reads the top-ranked pages (25% of the page budget) and makes one link hop. Then come worker rounds. Each worker is a cheap model driving `search / open_page / find_in_page / note_finding / done` (`agents/worker.ts`). The lead reviews each round (`agents/lead.ts`).
- **reviewing** (`stages/coverage-stage.ts`, `stages/coverage.ts`): computes a coverage matrix and may schedule one follow-up sweep, then returns to investigating.
- **synthesizing**: on the web, the lead model writes from a packed corpus (`tools.ts`, `corpus.ts`, `corpus.prompt.ts`). The native in-chat path (`deep-research.ts` + `gatheringOnlyEngine`) stops here, and the user's own chat model writes the report against the same corpus with the chat contract.
- **validating_citations**: the claim-level citation audit (`claims.ts`). It was not changed.

## What was wrong, stage by stage

### Stage 1: decomposition
- The planner asked for "3 to 6 sub-questions … as a full question a person would ask". Nothing asked for metrics, primary-source targets or claims to verify, and nothing checked whether a question just restated the request. Paraphrase plans (RULE 0.1) passed validation untouched.
- `plannedResearch` added "the question's own words" as a search for every question the planner had not covered. That built paraphrases into the plan by construction.
- The queries were "one or two per question" with no instruction to target records. The prompt even told workers to "start with short, broad queries (2-5 words)".

### Stage 2: primary-source targeting
- `authorityOf` only knew governments, universities, journals and newspapers. A vendor's docs, pricing page or changelog scored **0.45**, exactly the same as a "Top 10 AI coding tools (we tested them)" affiliate page or a G2 comparison. The seed read and the writer's corpus packing rank by this score, so SEO-ranked roundups were read and packed alongside the record, and often ahead of it.
- `sourceTypeOf` called vendor docs "general". So a requirement for a "primary source" could not be satisfied by the vendor's own documentation.
- Workers saw raw search-engine order with no quality signal.

### Stage 3: multi-hop extraction
- Workers did open pages and quote them. That part was already sound: `note_finding` refuses quotes that are not on the opened page.
- **No near-duplicate guard.** Queries were deduplicated only by exact lower-case string. Workers were *told* the team's recent searches, but nothing stopped a repeat, and each repeat cost a search fee.
- **No lead chaining.** A round's findings reached the next round only through the lead model's free-text gap briefs, and only for questions it scored below 0.8 coverage. A worker that found a deprecation or a new tier on a "covered" question ended the investigation.
- **Single-round runs.** `envelope.wantedRounds` gave focused scopes one round. The lead could also say "synthesize" after round 1 on any scope.
- **Follow-up sweeps bought nothing.** `doReading` always opened the *top `seedPages` by score*. On a follow-up pass those are pages the run had already read, so the new sources found by follow-up searches were never opened. Follow-up passes also ignored the run's page ceiling.

### Stage 4: gap audit
- The coverage pass checked source counts, source class and token overlap. It never checked whether the **figures** a question needed were found. It never compared numbers across findings and never looked at dates. Follow-ups were templated as `"<question> primary source evidence"` (a paraphrase), or written by the expander when one was wired.

### Stage 5: report
- The web contract was: Bottom line → Key findings → one section per question → Where sources disagree → What could not be established → Method. It had no decision matrix, no comparative matrix, no gotchas section and no source traceability. The writer was not told which sources were primary or how old they were.

## What changed

| Stage | Change | Where |
|---|---|---|
| 1 | The planner now asks for **4–6 MECE vectors**, each with `metrics` (exact figures), `primarySources` (where the record lives) and `verify` (claims or controversies to check). Queries are **mapping searches** that name an entity and a record. Both prompt and schema were updated, and the retry note now asks for vectors. | `planner.prompt.ts` |
| 1 | Vectors are stored on `ResearchObjective.vector` and read back by a tolerant parser. They stay the run's **questions**, so the existing UIs show them. The figures and claims to verify are folded into the existing `rationale` view field, so there is **no wire change**. | `domain.ts`, `planner.ts`, `view.ts` |
| 1 | `planShallowness` deterministically flags plans that break the protocol: fewer than 4 vectors, vectors or queries that restate the goal, no concrete metric, or many near-duplicate queries. A shallow plan gets **the same single retry** an invalid plan gets, and the run keeps whichever plan is less shallow. The planner still makes at most 2 calls. | `planner.ts` |
| 1 | `plannedResearch` drops queries that restate the goal, collapses near-duplicates, and builds a missing vector's query from its **subject + primary record + metric**. It no longer uses the vector's question. Plans without vectors keep the old rule. | `planner.ts` |
| 2 | New **source policy** that is deterministic and gives reasons. First-party docs, pricing, changelog, terms and limits pages, plus repos, papers, filings, standards and leaderboards → `primary` (authority ≥ 0.85, composite ×1.2–1.25). Review marketplaces, listicle titles and affiliate or sponsor disclosures → `aggregator` (authority ≤ 0.25, composite ×0.4–0.55). | `source-policy.ts`, `claim-analysis.ts` (`scoreSource`, `sourceTypeOf`) |
| 2 | Worker search results are **re-ranked by tier and labelled** (`[primary record]`, `[aggregator/affiliate — avoid citing]`). The seed read **skips aggregators** while the run holds at least 3 better sources, and the link hop never follows an aggregator link and prefers record links. | `stages/workers.ts`, `stages/corpus.ts` |
| 3 | **Near-duplicate query guard**: token Jaccard ≥ 0.8, or the same query plus only a year or number. A teammate's duplicate in the same round is served from the round's cache with no fee. A repeat of an earlier round's or the sweep's search is **refused without billing**. The sweep and follow-ups are deduplicated too, except the F5 widening, which exists precisely to reword a search that returned nothing. | `query-dedupe.ts`, `stages/workers.ts`, `stages/corpus.ts`, `stages/coverage-stage.ts` |
| 3 | **Leads**: after each round, deterministic signals in that round's findings (deprecation, pricing change, new tier, rate limit, incident, legal, backlash, preview status, architecture or terms change) become micro-queries such as `Cursor Ultra plan tier limits pricing 2025`. Each names the entity and is deduplicated against every search already made, capped at 6 per round and 2 per vector. Workers' own `follow_ups` go through the same filter. Leads are shown to the lead model, written into the next briefs ("run these first: …"), recorded on `ResearchRound.leads` and included in the `round_reviewed` payload. | `leads.ts`, `stages/workers.ts` |
| 3 | **Minimum two rounds when there is something to chase.** The envelope now asks for 2 rounds unless the scope is `quick`, and `fit()` still drops the second round first when money is short. If the lead says "synthesize" after round 1, a second round runs anyway **only if** there are leads or audit gaps, pages are left and the user has not pressed "finish now". It is recorded as `continue` so a resumed run keeps it. | `envelope.ts`, `stages/workers.ts` (`MIN_RESEARCH_ROUNDS`) |
| 3 | Follow-up read passes now spend their fetch slots on **sources that need a fetch**, ranked best first. They stay under what is left of the run's page ceiling. Pages the sweep already fetched (`plan.sweepFetched`) are never fetched again, even short ones. | `stages/corpus.ts` |
| 3 | The worker prompt is rewritten to the protocol: search for the record, never rely on snippets, follow the multi-hop rule, reconcile disagreements against changelogs. The vector's figures, records and claims to verify are in each brief. | `agents/worker.ts`, `stages/workers.ts` |
| 4 | **Gap audit**, deterministic and free. For each vector it finds: metrics no finding states with a figure; `verify` items no finding addresses; same-topic findings on different hosts whose same-kind numbers disagree; and figures that rest only on undated or >18-month-old pages where recency matters (prices, limits, versions, policies). Each gap becomes one targeted search, deduplicated and capped at 8. It runs after every round (shown to the lead and written into briefs) and again in `reviewing`, where its searches and any unchased leads go **first** in the follow-up sweep. The sweep stays within the existing follow-up bound and the writer's reserve. The result is stored on `plan.gapAudit`. | `gap-audit.ts`, `stages/workers.ts`, `stages/coverage-stage.ts` |
| 4 | The lead review prompt is rewritten as a per-vector audit covering missing metrics, conflicts and recency. Gap briefs must name the records, the figures and 1–3 micro-queries. | `agents/lead.ts` |
| 5 | The web writer contract now follows the protocol: **Executive verdict** with a decision matrix (`bottom-line`), **Comparative matrix** (new `matrix` marker; one row per option, or per vector when nothing is compared), one **deep dive** per vector, **Nuances and gotchas** (new `gotchas` marker), Where sources disagree, What could not be established, and **Methodology and source traceability** (a table of domain, record kind, date, what it established and citations). Every table figure must also appear, cited, in prose. The chat contract (native in-chat path) follows the same order. | `corpus.prompt.ts` |
| 5 | Every corpus source now carries our own metadata line, `(primary record · cursor.com · published 2026-07-15)`, outside the untrusted envelope. The writer also sees the vectors and the gap audit. The citation rules add the source hierarchy and exact-figure rules. | `corpus.ts`, `corpus.prompt.ts` |
| 5 | Both report parsers know `matrix` and `gotchas`. The `[n]` citations, markers, sources list, summary and bottom-line extraction are unchanged. Native readers split on headings generically and need no change. | `report-structure.ts`, `components/research/report-structure.ts` |

Budgets, cancellation, pause/resume and steering are untouched. Every new step runs inside the existing round, wave and lease boundaries and their `affordable` / `windowSpent` / `finishRequestedAt` checks. The gap audit, leads, dedupe and source policy are all model-free.

## Simulated end-to-end run (offline)

The run uses `tests/fixtures/research-protocol-scenario.ts` with the in-memory store. It has a scripted planner, a fake web whose results put a G2 comparison and an affiliate "Top 10" page **first**, scripted workers that follow the engine's labels and briefs, and a lead that says "synthesize" after every round. The goal is *"Should our 50-person engineering team standardise on GitHub Copilot or Cursor?"*, at standard effort. The trace below is condensed.

```
VECTORS (the run's questions)
- objective-1: What does each cost per seat on business plans?
    figures: business plan price per seat per month; annual discount   records: official pricing page
- objective-2: What usage limits and rate limits apply to premium requests?
    figures: premium requests per month; rate limit tier               verify: unlimited completions claim
- objective-3..5: models/context windows; privacy/IP/retention terms; measured productivity + issue trackers

PLANNED MAPPING QUERIES  (planner's paraphrase "GitHub Copilot or Cursor for our engineering team" dropped)
- GitHub Copilot pricing business plan per seat
- Cursor pricing business plan per seat
- Cursor rate limits premium requests documentation
- GitHub Copilot premium requests limits documentation
- GitHub Copilot Cursor models documentation context window tokens        <- built from the vector
- GitHub Copilot Cursor trust center data retention days                  <- built from the vector
- GitHub Copilot Cursor GitHub issues measured task completion speedup    <- built from the vector

ROUND 0 (seed sweep): 7 searches; read cursor.com/changelog, cursor.com/pricing,
  docs.github.com/.../plans-for-github-copilot, github.com/.../issues/112
  (g2.com and the affiliate "Top 10" page were found but never fetched)
ROUND 1: 4 workers; every worker's first search hit was a [primary record]
  REFUSED duplicate search [w1-1]: GitHub Copilot pricing business plan per seat   (no fee)
  findings: "GitHub Copilot Business costs $19 per user per month." (docs.github.com)
            "Copilot Business includes 300 premium requests per user per month." (docs.github.com)
            "Cursor 1.4 adds a 200,000 token context window for Max mode." (cursor.com/changelog)
            "Cursor introduced a new Ultra plan with higher rate limits ... in 2025." (cursor.com/pricing)
  lead model: synthesize  ->  engine: continue (1 lead + 5 audit gaps; RULE 0.3)
  leads: "Cursor Ultra plan tier limits pricing 2025" (signal: new tier)
  audit: annual discount missing; rate limit tier missing; "unlimited completions" unverified; ...
ROUND 2: w2-1 briefed "run these first: Cursor Ultra plan tier limits pricing 2025" -> ran it
         w2-2..4 briefed on the audit's missing figures; their repeats of round-1 searches refused
  lead: synthesize (no new leads)
REVIEWING (gap audit pass 2): follow-up sweep of 6 targeted searches, e.g.
  "GitHub Copilot Cursor annual discount official pricing page"
  "GitHub Copilot Cursor rate limit tier usage limits documentation"
  "GitHub Copilot Cursor 55% faster claim"
  -> no new unread sources in the fake web; aggregators still not fetched
SYNTHESIZING -> VALIDATING -> completed. Pages fetched: 4 (all primary). Writer saw the gap audit.
```

To reproduce: run the end-to-end tests in `tests/research-protocol.test.ts`. They assert every line of behaviour above.

## Tests

- New `tests/research-protocol.test.ts` (15 tests) covers: vector parse and round trip; the shallowness check; the single corrective retry staying at two calls; paraphrase removal and vector-built queries; vectors reaching the UI with no new wire field; source tiers and score ordering; hit re-ranking; near-duplicate detection; lead extraction (entity, tier name, year, dedupe, cap); the gap audit (missing, unverified, conflicting, stale, no-gap case); the writer contract's section order and markers; both parsers' new kinds; the chat contract order; corpus metadata, vectors and the audit reaching the writer; and the two end-to-end runs (a forced second round with leads, and no forced round when there is nothing to chase).
- Updated tests:
  - `research-envelope`: a focused scope now gets 2 rounds; a `quick` scope still gets 1.
  - `research-agents` (seed share): a follow-up pass now *does* fetch new pages, so the ledger equals all sweep fetches and stays under the page ceiling.
- Results:
  - All `tests/research-*.test.ts` plus `deep-research-adapter`: 415 tests, 412 pass, 3 skipped. The skips are the DB suites, which need `RESEARCH_TEST_DATABASE_URL`; no throwaway Postgres was started.
  - Contract checks pass: capability, native Swift, work, parity ledger and chat-wire.

## Cost impact

- **Planner:** still at most 2 calls. A shallow first plan now uses the retry slot that used to be reserved for invalid JSON. Output is ~1–1.5k tokens larger for the vector fields, well inside `PLANNER_OUTPUT_TOKENS` (6,144). `SYSTEM_PROMPT_CHARS` goes from 4,000 to 6,000 so the reservation covers the longer planner prompt.
- **Rounds:** focused, non-quick scopes are priced at 2 rounds (was 1). `fit()` still removes the second round first when the window or month cannot pay. The engine *uses* round 2 only for vectors with a lead or an audit gap, and never above the worker count. Most runs on "broad" scopes already priced 2 rounds.
- **Savings:**
  - Duplicate worker searches are refused, or served from the round cache, at no fee.
  - Aggregator pages are not fetched while better sources exist.
  - Short pages are not re-fetched on every pass.
  - Follow-up passes are now capped by the page ceiling they used to ignore.
- **New spend:**
  - Follow-up passes now actually fetch the new pages they searched for, bounded by the seed share and the page ceiling.
  - The writer's prompt grows by ~2.5k characters, plus ~80 per source. `CORPUS_PREAMBLE_CHARS` goes from 4,000 to 6,500 so the writer estimate covers it.
  - Matrix tables lengthen the report, within `SYNTHESIS_OUTPUT_TOKENS`.
- **Cheap models stay where they were:** workers on the worker model, the gap audit, leads, dedupe and source policy with no model at all.

## Remaining gaps and risks

1. **Table cells are not citation-audited.** `extractClaims` skips table rows, so figures in the verdict and comparative matrices are only checked because the contract requires them to be repeated in deep-dive prose. Making the audit read table cells is the next step.
2. **The gap audit is lexical.** Metric matching is token overlap (≥ 0.4), so synonyms can be flagged missing ("per user" vs "per seat"). It does not check coverage per entity in a comparison: Copilot's price can satisfy the "price" metric while Cursor's is missing. Conflict detection needs similar claims with numbers of the same kind.
3. **Lead signals are English regexes.** Runs in other content languages get worker follow-ups and lead-model briefs but few deterministic leads.
4. **The source policy is heuristic.** Host and path rules can misfire. For example, `docs.google.com` counts as a "documentation portal", and a vendor's `/blog/` posts are "general". It re-weights and labels; it never deletes a source.
5. **The first sweep is not deduplicated** against itself beyond the planner clean-up. A plan a person edited at the gate runs as approved.
6. **Worker `open_page` re-fetch threshold** (existing behaviour): a page under 2,000 characters is fetched again when a worker opens it. `sweepFetched` only covers the sweep.
7. **The native client-side loop** (`JunoChatKit/DeepResearchCoordinator`) is only constructed in tests. Native clients use the server run, so it was not changed.
8. **Needs a real-provider check before shipping.**
   - Do the planner models (Anthropic, OpenAI strict schema, Gemini) fill `metrics`, `primarySources` and `verify`? They are `required` in the schema.
   - How often does the shallowness retry fire?
   - Do real workers respect the result labels and refusals?
   - Does the lead model produce a usable decision matrix and comparative matrix in the report's language?
   - What is the actual cost delta of the second round on PRO and PLUS windows? Check the `research.estimate.actual` logs.

## Depth pass (Oct 8): reading depth, table audit, semantic gaps, multilingual leads, scale

This pass closes remaining gaps 1–3 above and the "reading depth" and "scale" questions.

### Reading depth (measured on `tests/fixtures/reading`, no network)

Run `npx tsx tests/fixtures/reading/measure.ts [--full]` to see what the extractor yields; `tests/reading-depth.test.ts` asserts it.

| Fixture | Before | After |
|---|---|---|
| `next-data.html` (empty `#__next`, page in `__NEXT_DATA__`) | `empty_document` (shell) | plans as a Markdown table, FAQ, `shell=false` |
| `app-state.html` (`window.__INITIAL_STATE__`, JSON island) | `empty_document` | incidents and rate-limit tiers as tables |
| `jsonld-product.html` (client-rendered, JSON-LD only) | `empty_document` | offers table with prices, rating, FAQ |
| `jsonld-article.html` (empty root, JSON-LD article) | `empty_document` | article body, date and author |
| `empty-spa.html` (config only) | `empty_document` (shell) | unchanged: still a shell, so the headless path decides |
| `pricing-table.html` | cells flattened to space-separated rows; `colspan` value under one plan | Markdown table, header row, `colspan` repeated across the plans it covers |
| `spec-sheet.html` (headerless key/value table, `rowspan`, `<dl>`) | space-separated pairs | `- key: value` list, `rowspan` carried down |
| `pricing-table.pdf` | cells joined by single spaces | Markdown table with header |
| `two-column.pdf` (stream written across the gutter) | alternating half-lines of both columns | left column, then right |
| `report.pdf` | one block | paragraphs (blank lines) the passage splitter can use |

- **PDF**: `unpdf` (pdf.js, already a dependency) is unchanged; `src/lib/search/pdf-layout.ts` lays its positioned items out (baselines, gaps, gutter, aligned columns). Rotated/RTL pages and pages with >20k items keep the stream-order join. No new dependency.
- **JS-rendered pages**: `src/lib/web/embedded-data.ts` reads JSON-LD on every page and a framework's hydration state only when the markup is a shell. Bounded (1.5 MB a blob, 3 MB a page, 24 blobs, 30k nodes, depth 14, 40k chars out); never throws; plumbing keys and id/hash/URL values are dropped.
- **Headless fallback**: the repo already has one (`src/lib/research/crawler.ts`, Playwright, opt-in with `RESEARCH_HEADLESS=1`, SSRF guard on every request). It now feeds the rendered DOM through the same extractor (tables, JSON-LD) instead of `innerText`. No reader API is configured anywhere in the repo, so none was added; a shell whose JSON held the page no longer needs the browser at all.
- Fetch safety is unchanged: the same pinned transport, redirect guard, byte caps and deadlines; the new parsers only see bytes that already passed them.

### Citation audit reads tables

`extractClaims` turns Markdown table rows into `row — header: value` claims (`tableClaims`): a cell's own `[n]`, else the row label's, else the column header's. Methodology tables are skipped. At most 40% of the audit's claims are table claims. A repair annotates the cell in place. The writer contract no longer asks for every table figure to be repeated in prose; it asks for in-cell citations.

### Gap audit, semantically

`src/lib/research/metric-match.ts`: units and synonyms folded (seat/user/member, month/mo/monthly, year/annual, USD/$, EUR/€, GBP/£, price/cost/fee, limit/cap/quota, RPM/rate limit, context window/length, percent/%), a numeric-kind check, figures compared with currency, period (yearly at the monthly rate) and seat basis within 3%, and the options of a comparison read from the goal so each option needs its own figure (`metric — Option`, searched per option).

### Multilingual leads

`leads.ts` signals in EN, FR, DE, ES, IT, PT, JA and ZH; the micro-query is written in the source's language; known entities (the compared options, the subject) win over capitalised nouns. `contentTokens` adds CJK bigrams.

### Optional cheap-model assist (one call per round)

`ResearchDeps.auditAssist` (`audit-assist.ts`, wired in `run.ts` to the workers' cheapest model): called once per round only when a numeric finding sits on a vector with a missing figure or a finding is not in English, and only when the ceiling can pay with the writer's reserve held back. It can only remove a gap (naming a finding with a figure) or add a lead (same dedupe and caps). Prompt ≤ 14k chars, ≤ 900 output tokens.

### Scale: adaptive depth

`src/lib/research/depth.ts`. At the end of what would be the last round, a **hard** question (score ≥ 3 from: ≥5 vectors, conflicting figures, ≥3 missing figures, ≥2 unverified claims, ≥3 open leads) that is **not saturated** gets one more round and more pages, if the run's ceiling (the binding five-hour/weekly window's room, frozen on the envelope) can pay for another round with the writer's and audit's reserve held back, the window is not spent and a quarter of the clock is left. Ceilings: +2 rounds (`MAX_EXTRA_ROUNDS`), never past `MAX_RESEARCH_ROUNDS` (6); pages +50% of the envelope (at least 12 a round), never past 250; worker tokens in proportion; the clock never extends. Recorded on `plan.depth` (so `planBudget` and a resumed run keep it) and on `round_reviewed.extended`. **Early stop**: a round with no findings, almost no new pages cited, or no new figures and few new pages ends the rounds. Page reads were already parallel (`READ_CONCURRENCY` 8 in the sweep and follow-ups; workers run in parallel). The methodology now states sources found vs pages read in full, searches, rounds and any extension (`# Research Footprint` block in the writer's corpus, on the web and native paths).

### Still open

- Multi-line PDF table cells (a cell that wraps onto a second line) end the detected table; the wrapped text follows as a line.
- Option detection needs capitalised names or "x vs y"; a comparison phrased only in lower case without "vs" is audited per vector, not per option.
- The headless renderer stays opt-in; a pure client-rendered page with no JSON in its HTML is still `needs_browser`/`empty_document` without it.
- Real-provider check still needed: does the assist's model return clean JSON on every provider, and how often is a run extended on PRO/PLUS windows (`research.estimate.actual`).
