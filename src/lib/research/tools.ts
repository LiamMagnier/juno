import "server-only";
import { streamChat } from "@/lib/llm";
import { utilityModelCandidates } from "@/lib/memory";
import { recordSpend } from "@/lib/spend";
import { estimateGenerationCostUsd } from "@/lib/pricing";
import { truncate } from "@/lib/utils";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { ModelInfo } from "@/lib/models";
import { citableSources, type ResearchDeps, type ResearchHit } from "@/lib/research/engine";
import { buildResearchCorpus, corpusFindings } from "@/lib/research/corpus";
import { fetchRetryDelayMs } from "@/lib/search/page-signals";
import {
  BRIEF_OUTPUT_TOKENS,
  BRIEF_PROMPT_CHARS,
  CLARIFY_OUTPUT_TOKENS,
  CLARIFY_PROMPT_CHARS,
  parseClarifications,
  EXPANSION_OUTPUT_TOKENS,
  EXPANSION_PROMPT_CHARS,
  MAX_PLAN_STEPS,
  PAGE_FETCH_FEE_MICRO_USD,
  PLANNER_OUTPUT_TOKENS,
  PLANNER_PROMPT_CHARS,
  REVISION_REPORT_CHARS,
  SEARCH_FEE_MICRO_USD,
  SYNTHESIS_OUTPUT_TOKENS,
  type ResearchEffort,
} from "@/lib/research/domain";
import { extractJsonObject, parseStructuredPlan, plannerSystemPrompt } from "@/lib/research/plan-format";
import { researchLeadModel } from "@/lib/research/agents/worker";

/**
 * What the durable research job farms out: planning, searching, fetching and
 * writing.
 *
 * Lifted out of `src/lib/deep-research.ts` rather than rewritten — the planner
 * prompt, the Tavily parameters and the untrusted-content envelope had all been
 * tuned against real failures and none of that changed when the pipeline became
 * a job. What did change is the return shape: every function now reports what
 * it cost in micro-USD, because `ResearchRun.budgetMicroUsd` is a ceiling the
 * engine has to check BEFORE the next call rather than a total it discovers
 * afterwards.
 */

const BRIEF_TIMEOUT_MS = 30_000;
/** Short: a person is waiting on a form, and a slow question is worse than none. */
const CLARIFY_TIMEOUT_MS = 20_000;
/**
 * The planner writes six steps and fourteen queries after a brief; 25 seconds
 * was short enough that a busy provider timed it out, and a timed-out planner
 * is exactly the run that used to collapse to one literal search.
 */
const PLAN_TIMEOUT_MS = 60_000;
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 25_000;
/**
 * How many merged results one query contributes.
 *
 * This was 8, and 8 was the number a user actually felt: with the old cascading
 * search returning a single engine's list, one query meant at most 8 sites and
 * a whole run bottomed out around there. `executeMultiEngineSearch` now merges
 * every available engine by rank fusion, so the union behind one query is much
 * larger than any single engine's page — taking 18 of it is what makes a run
 * read like research rather than a search-results page.
 */
const RESULTS_PER_QUERY = 24;
/** Queries the planner may draft up front. The engine's own ceiling is MAX_PLAN_QUERIES. */
const PLANNED_QUERIES = 16;
/**
 * The deep and max tiers are asked for five to eight sub-questions with two
 * or three searches each — up to 24 — and a cap of 16 was silently dropping
 * every search the last objectives had. 24 still leaves the follow-up rounds
 * sixteen of `MAX_PLAN_QUERIES`.
 */
const PLANNED_QUERIES_DEEP = 24;

function plannedQueriesFor(effort: ResearchEffort | undefined): number {
  return effort === "deep" || effort === "max" ? PLANNED_QUERIES_DEEP : PLANNED_QUERIES;
}
/**
 * How many human-readable steps the plan gate asks for. Matches
 * `MAX_PLAN_STEPS`, which is the storage bound — a planner asked for more than
 * the plan can hold would have its tail silently dropped at the gate.
 */
const PLANNED_STEPS = MAX_PLAN_STEPS;
/** Queries one coverage-gap expansion may return. Slots are the engine's to allocate. */
const EXPANDED_QUERIES = 8;
/**
 * How much of a page the fetcher hands back.
 *
 * Larger than SNAPSHOT_CHARS on purpose: the extractor now strips page chrome
 * and prefers an `<article>`/`<main>` region, and that work needs headroom to
 * be worth anything. What the run STORES, and therefore what synthesis reads,
 * is the engine's SNAPSHOT_CHARS, which corpus.ts slices at — one number, not
 * a copy of it, because a storage cap and a prompt cap that quietly disagree
 * is how half of every document ended up being thrown away with the corpus
 * builder still slicing at a number nothing ever reached.
 */
const PAGE_CONTENT_CHARS = 16_000;

/** A signal that aborts with its parent OR after `ms`, whichever comes first. */
function timeboxSignal(
  parent: AbortSignal | undefined,
  ms: number
): { signal: AbortSignal; release: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, ms));
  const onAbort = () => ctrl.abort();
  if (parent?.aborted) ctrl.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctrl.signal,
    release: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * The planning model: the app-wide speed-ranked utility list.
 *
 * A durable run has no "selected model" to match the provider of — that choice
 * belongs to the chat turn that reads the report, and a job resumed three hours
 * later may be running while the user has switched models twice.
 */
export function researchPlannerModel(): ModelInfo | null {
  // The plan is the one model call whose quality every later call inherits: a
  // planner that writes vague sub-questions sends eight workers after vague
  // things, and no amount of worker budget recovers from it. So it runs on the
  // LEAD model — the strongest configured — not on the workers' cheap one,
  // which is what it used to do. See `researchLeadModel`.
  return researchLeadModel() ?? utilityModelCandidates()[0] ?? null;
}

/**
 * Split the planner's reply into its two sections.
 *
 * Tolerant on purpose, and it degrades in the one direction that is safe. A
 * model that ignores the headings entirely gives us a flat list, and a flat list
 * is what this feature has always received — so the whole reply becomes the
 * QUERIES section and the plan simply has no steps, exactly like every run
 * drafted before steps existed. The gate falls back to the query list, which is
 * where it started. What must never happen is the reverse: prose steps leaking
 * into the query list would have the run searching the web for full sentences.
 *
 * Anything before the first recognised heading is discarded rather than guessed
 * at — it is preamble, and preamble in the query list is a wasted search.
 */
function parsePlanSections(text: string): { plan: string; queries: string } {
  const heading = /^\s*#{0,3}\s*(plan|queries)\s*:?\s*$/i;
  let current: "plan" | "queries" | null = null;
  const buckets = { plan: [] as string[], queries: [] as string[] };
  let sawHeading = false;
  for (const line of text.split("\n")) {
    const match = line.match(heading);
    if (match) {
      current = match[1].toLowerCase() === "plan" ? "plan" : "queries";
      sawHeading = true;
      continue;
    }
    if (current) buckets[current].push(line);
  }
  if (!sawHeading) return { plan: "", queries: text };
  return { plan: buckets.plan.join("\n"), queries: buckets.queries.join("\n") };
}

function parsePlanLines(text: string, max: number): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const q = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (q.length < 8 || q.length > 400) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(q);
    if (queries.length >= max) break;
  }
  return queries;
}

/**
 * The brief-expansion step, and why a second model call earns its keep.
 *
 * A user types one line. That line is what the planner used to see, and a
 * one-line goal produces one-line-shaped queries: near-paraphrases of the
 * request that all return the same first page of results. It is the single
 * biggest reason a run reads as shallow no matter how many queries it is
 * allowed — breadth in the query list cannot come from nowhere, and the model
 * has to be given room to work out what the question actually contains before
 * it is asked to decompose it.
 *
 * So the goal is expanded into an explicit brief first — entities, timeframe,
 * what a complete answer must contain, which fields would argue about it — and
 * the planner decomposes the BRIEF. This is the same clarify/rewrite/research
 * split OpenAI documents for ChatGPT's deep research, where the rewritten brief
 * rather than the user's prompt is what reaches the research model.
 *
 * Never throws, and degrades to the raw goal. An expansion that fails must cost
 * the run nothing but a few seconds.
 */
const BRIEF_SYSTEM = `You turn a short research request into a precise research brief.

Write 120-200 words of plain prose covering, in this order:
- What is actually being asked, restated unambiguously — resolve vague pronouns and name the specific entities, products, organisations, places or people involved.
- The timeframe that matters, and whether recency is critical.
- What a COMPLETE answer must contain: the specific quantities, comparisons, mechanisms or decisions the reader needs.
- Where the genuine disagreement or uncertainty is likely to be, and which communities or disciplines would argue about it.

Do not answer the question. Do not speculate about facts you would need to look up — describe what must be found, not what it might say. Do not use headings or bullets. Output only the brief.`;

/** One utility-model completion, billed. Returns empty text on any failure. */
async function utilityCompletion(opts: {
  userId: string;
  model: ModelInfo;
  system: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  label: string;
}): Promise<{ text: string; costMicroUsd: number }> {
  const box = timeboxSignal(opts.signal, opts.timeoutMs);
  let out = "";
  let input: number | undefined;
  let output: number | undefined;
  try {
    for await (const ev of streamChat({
      model: opts.model,
      system: opts.system,
      history: [{ role: "USER", content: opts.prompt, attachments: [] }],
      maxTokens: opts.maxTokens,
      signal: box.signal,
    })) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "usage") {
        input = ev.input ?? input;
        output = ev.output ?? output;
      }
    }
  } catch (e) {
    console.error(`[research] ${opts.label} failed`, {
      model: opts.model.id,
      message: box.signal.aborted ? "timed out or aborted" : e instanceof Error ? e.message : String(e),
    });
  } finally {
    box.release();
  }

  // Bill whatever was actually consumed, even when the output was unusable —
  // the tokens were spent either way, and a ledger that omits its failures
  // under-reports what research costs.
  const billed = estimateGenerationCostUsd(opts.model, {
    promptTokens: input,
    completionTokens: output,
    promptChars: opts.system.length + opts.prompt.length,
    completionChars: out.length,
  });
  await recordSpend({
    userId: opts.userId,
    model: opts.model.id,
    kind: "chat",
    source: "web",
    promptTokens: billed.promptTokens,
    completionTokens: billed.completionTokens,
    costUsd: billed.costUsd || undefined,
    promptChars: opts.system.length + opts.prompt.length,
    completionChars: out.length,
  });
  return { text: out.trim(), costMicroUsd: Math.round(billed.costUsd * 1_000_000) };
}

/**
 * CLARIFY — what does the goal not say?
 *
 * The prompt is written against the one failure mode that matters here:
 * asking questions for the sake of a form. A request that is already specific
 * must come back with an empty list, and the instruction to return nothing is
 * the first rule rather than a footnote, because a model given a "write
 * questions" task will always find four.
 *
 * It sees the raw goal and nothing else. The brief expansion in
 * `planResearchQueries` exists to smooth ambiguity out; running clarification
 * on its output would be asking a model what it does not know about a text
 * another model already decided for it.
 */
const CLARIFY_SYSTEM = `You read a research request and decide whether it is specific enough to research well.

Reply with ONE JSON object and nothing else — no prose, no Markdown fence:

{ "questions": [ { "id": "q1", "question": "...", "why": "...", "suggestions": ["...", "..."], "skippable": true } ] }

Return {"questions": []} when the request is already specific enough. That is the RIGHT answer for most well-written requests, and asking a question with an obvious answer wastes the reader's time and makes the product feel bureaucratic.

Ask a question ONLY when the answer would change what gets searched or what the report concludes. Good reasons to ask:
- The scope is genuinely ambiguous: which markets, which jurisdictions, which time period, which version of the thing.
- The audience or purpose decides the depth and the framing (a board memo and a technical evaluation need different research).
- A key term has more than one common meaning in the field.
- The request implies a comparison but does not say against what.

Never ask:
- Anything you could look up. "What is the current price of X" is research, not clarification.
- For permission, preferences about formatting, or how long the report should be.
- More than one thing per question.

Rules:
- At most 3 questions, ordered by how much the answer changes the work.
- "question" is one sentence a person can answer in a few words.
- "why" is one short clause saying what changes depending on the answer.
- "suggestions" are 2 to 4 concrete example answers, not categories. They are examples, not a closed list.
- "skippable" is false only when the research genuinely cannot start without it.`;

/** The questions a run asks before planning. Never throws; empty means "do not ask". */
export const clarifyResearchGoal: NonNullable<ResearchDeps["clarify"]> = async ({ userId, goal, effort, signal }) => {
  const model = researchLeadModel();
  if (!model) return { questions: [], costMicroUsd: 0 };
  // The quick tier is for "look this up now": stopping to ask is against the
  // point of choosing it.
  if (effort === "quick") return { questions: [], costMicroUsd: 0 };

  const out = await utilityCompletion({
    userId,
    model,
    system: CLARIFY_SYSTEM,
    prompt: goal.slice(0, CLARIFY_PROMPT_CHARS),
    maxTokens: CLARIFY_OUTPUT_TOKENS,
    timeoutMs: CLARIFY_TIMEOUT_MS,
    signal,
    label: "clarify",
  });

  const json = extractJsonObject(out.text);
  if (!json) return { questions: [], costMicroUsd: out.costMicroUsd };
  try {
    const parsed = JSON.parse(json) as { questions?: unknown };
    return { questions: parseClarifications(parsed.questions), costMicroUsd: out.costMicroUsd };
  } catch {
    // A clarifier that returns nothing usable is a clarifier that asked
    // nothing: the run plans as written rather than stopping on a parse error.
    return { questions: [], costMicroUsd: out.costMicroUsd };
  }
};

/**
 * Did a planner reply contain a decomposition at all?
 *
 * Asked exactly the way `planResearchQueries` asks it below — through the two
 * parsers that actually consume the text — so "worth retrying" can never drift
 * from "the caller got nothing". A length check or a status flag would answer a
 * different question and start disagreeing the first time a parser changed.
 */
function hasUsablePlan(text: string, maxQueries: number): boolean {
  if (!text.trim()) return false;
  if (parseStructuredPlan(text, { maxQueries })) return true;
  return parsePlanLines(parsePlanSections(text).queries, maxQueries).length > 0;
}

/**
 * PLAN — expand the goal into a brief, then decompose the brief into queries.
 *
 * Never throws. But returning nothing is no longer cheap: the engine STOPS the
 * run when this comes back empty rather than searching templated variations of
 * the user's sentence (see `doPlanning`), because a run with no decomposition
 * is not a research run — its objectives, its worker briefs and its gap review
 * are all derived from what this function returns.
 *
 * That raises the cost of a flaky failure, so the decomposition call is
 * ATTEMPTED TWICE. The overwhelmingly common failure is a timeout on a busy
 * provider, and a second attempt costs a few seconds of a run measured in
 * minutes. The brief is not retried: it is an optional augmentation, the
 * planner is prompted to work without it, and doubling down on the enrichment
 * step to save the step that actually matters is the wrong order.
 */
export const planResearchQueries: ResearchDeps["plan"] = async ({
  userId,
  goal,
  constraints,
  effort,
  pinnedSources = [],
  signal,
}) => {
  const planner = researchPlannerModel();
  if (!planner) return { queries: [], costMicroUsd: 0 };

  // Constraints reach the planner as part of the request, not as a separate
  // instruction block: "only sources after 2024" has to shape the queries
  // themselves, and a constraint appended after the fact only shapes the prose.
  const request = constraints.length
    ? `${goal}\n\nConstraints the searches must respect:\n${constraints.map((c) => `- ${c}`).join("\n")}`
    : goal;

  const brief = await utilityCompletion({
    userId,
    model: planner,
    system: BRIEF_SYSTEM,
    // The slice and the cap come from domain.ts rather than from here because
    // the engine has to price this call before it happens and cannot import
    // this module. A number raised here and not there is a ceiling that
    // silently stops holding; see the cost section of domain.ts.
    prompt: request.slice(0, BRIEF_PROMPT_CHARS),
    maxTokens: BRIEF_OUTPUT_TOKENS,
    timeoutMs: BRIEF_TIMEOUT_MS,
    signal,
    label: "brief",
  });

  // The brief AUGMENTS the request rather than replacing it. An expansion that
  // drifted would otherwise silently redirect the whole run, and the user's own
  // words are the only part of this that is not a model's guess.
  const prompt = brief.text
    ? `${request}\n\nResearch brief:\n${brief.text}`
    : request;

  const draft = async (attempt: 1 | 2) =>
    utilityCompletion({
      userId,
      model: planner,
      system: plannerSystemPrompt(effort, pinnedSources),
      prompt: prompt.slice(0, PLANNER_PROMPT_CHARS),
      maxTokens: PLANNER_OUTPUT_TOKENS,
      timeoutMs: PLAN_TIMEOUT_MS,
      signal,
      label: attempt === 1 ? "plan" : "plan (retry)",
    });

  let planned = await draft(1);
  let costMicroUsd = brief.costMicroUsd + planned.costMicroUsd;
  const maxQueries = plannedQueriesFor(effort);
  // Both parsers below key off the text, so "did the first attempt produce
  // anything usable" is asked exactly the way the callers below ask it —
  // rather than by re-deriving it from a length or a status the model does
  // not report. An aborted run does not retry: the caller has gone.
  if (!hasUsablePlan(planned.text, maxQueries) && !signal?.aborted) {
    const second = await draft(2);
    costMicroUsd += second.costMicroUsd;
    if (hasUsablePlan(second.text, maxQueries)) planned = second;
  }

  // The structured plan: sub-questions with evidence contracts, the approach,
  // the bar for done, and the searches attached to the question they serve.
  const structured = parseStructuredPlan(planned.text, { maxQueries });
  if (structured) {
    return {
      steps: structured.steps,
      queries: structured.queries,
      objectives: structured.objectives,
      ...(brief.text ? { brief: brief.text } : {}),
      ...(structured.approach ? { approach: structured.approach } : {}),
      successCriteria: structured.successCriteria,
      risks: structured.risks,
      costMicroUsd,
    };
  }

  // A planner that ignored the JSON shape may still have written the older
  // two-heading text; salvage that before degrading to the templates.
  const sections = parsePlanSections(planned.text);
  const steps = parsePlanLines(sections.plan, PLANNED_STEPS)
    // A "step" that is really a search string is worse than no step at all: it
    // puts the machine's vocabulary on the one screen written for a person. A
    // real step is a sentence, so require sentence shape — a verb phrase long
    // enough to be one, and no leading keyword soup.
    .filter((line) => line.length >= 24 && /\s/.test(line))
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`));

  return {
    steps,
    queries: parsePlanLines(sections.queries, maxQueries),
    ...(brief.text ? { brief: brief.text } : {}),
    // Both calls are the plan step as far as the run's ledger is concerned.
    costMicroUsd,
  };
};

import { isSearchEngineAvailable, searchWithEngineReport } from "@/lib/search/search-engine";
import { crawlResearchPage } from "@/lib/research/crawler";

/** True when a search engine is available. */
export function researchSearchConfigured(): boolean {
  return isSearchEngineAvailable();
}

/**
 * SEARCH — the multi-engine fan-out, with an account of which engines answered.
 *
 * The `engines` roster is not decoration. Every provider used to fail silently,
 * so a revoked Brave key and a healthy-but-quiet Brave were indistinguishable
 * from inside a run, and the only symptom either produced was a thinner report.
 * Passing it up means `query_issued` can carry it and the timeline can show it.
 */
export const searchTheWeb: ResearchDeps["search"] = async ({ query, count, signal }) => {
  if (!query.trim()) return { hits: [], costMicroUsd: 0 };
  const box = timeboxSignal(signal, SEARCH_TIMEOUT_MS);
  try {
    const { results, engines, providers } = await searchWithEngineReport({
      query: query.slice(0, 400),
      count: Math.max(5, Math.min(50, count ?? RESULTS_PER_QUERY)),
      signal: box.signal,
    });

    const hits: ResearchHit[] = results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.snippet.slice(0, 800),
      rawContent: r.rawContent ? r.rawContent.slice(0, PAGE_CONTENT_CHARS) : undefined,
      publishedAt: r.publishedAt,
    }));

    return {
      hits,
      // The engine reserves VENDOR_ESTIMATE_MARGIN times this before each wave.
      // It used to reserve a flat 10,000 against this same 1,000, which is why
      // the constant now lives beside the estimate that projects it.
      costMicroUsd: SEARCH_FEE_MICRO_USD,
      engines,
      providers: {
        keyed: providers.keyed,
        keyless: providers.keyless,
        selfHostedSearxng: providers.selfHostedSearxng,
        hasGoodIndex: providers.hasGoodIndex,
      },
    };
  } catch (e) {
    if (!box.signal.aborted) console.error("[research] multi-engine search error", e);
    return { hits: [], costMicroUsd: 0 };
  } finally {
    box.release();
  }
};

/**
 * FETCH — the universal extractor, including why a page produced no text.
 *
 * A bare null meant the engine could only skip in silence, which mattered most
 * for exactly the documents the planner is prompted to chase: `application/pdf`
 * used to fail the content-type gate, so specs, papers and government reports
 * were dropped without a trace. Those are now parsed; the reason still travels
 * back for the files that genuinely cannot be read.
 */
export const fetchResearchPage: ResearchDeps["fetchPage"] = async ({ url, signal }) => {
  if (!url) return null;
  const box = timeboxSignal(signal, FETCH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    let outcome = await crawlResearchPage(url, { signal: box.signal, maxChars: PAGE_CONTENT_CHARS });

    if (!outcome.ok) {
      // One retry for the two answers that mean "not right now". The page
      // fetcher treated a 429 exactly like a 404 while the search layer beside
      // it already retried its own rate limits, so a run reading a dozen pages
      // from one site lost every one past the first burst. The wait and
      // whether it fits the clock are decided in `fetchRetryDelayMs`.
      const wait = fetchRetryDelayMs(outcome.failure, Date.now() - startedAt, FETCH_TIMEOUT_MS);
      if (wait !== null && !box.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (!box.signal.aborted) {
          outcome = await crawlResearchPage(url, { signal: box.signal, maxChars: PAGE_CONTENT_CHARS });
        }
      }
    }
    if (!outcome.ok) {
      const failure = outcome.failure;
      return {
        skipped: failure.reason,
        // The status is the one fact a reader can act on for a refused
        // request, and it was dropped between the extractor and the timeline.
        ...(failure.detail ? { detail: failure.detail } : failure.httpStatus ? { detail: `HTTP ${failure.httpStatus}` } : {}),
        ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
      };
    }
    if (!outcome.page.text) return null;
    return {
      title: (outcome.page.title || url).slice(0, 300),
      text: outcome.page.text.slice(0, PAGE_CONTENT_CHARS),
      costMicroUsd: PAGE_FETCH_FEE_MICRO_USD,
      links: outcome.page.links,
      // The date the extractor found on the page. Dropped here for as long as
      // this wrapper existed, so every hopped or worker-opened page failed
      // any freshness rule the planner set and scored as undated.
      publishedAt: outcome.page.publishedAt ?? null,
    };
  } catch (e) {
    if (!box.signal.aborted) console.error("[research] fetch page extract error", e);
    return null;
  } finally {
    box.release();
  }
};

/**
 * EXPAND — new queries for the gaps the coverage matrix found.
 *
 * The engine's own fallback is a string template: the objective's question with
 * "primary source evidence" glued on. That is a paraphrase of the query that
 * produced the gap, and a paraphrase hits the same index entries — which is why
 * a follow-up round so often came back with the pages the first round already
 * had. Naming the already-issued queries in the prompt is the part that does
 * the work; without it the model writes the same paraphrase the template does.
 *
 * Never throws, and returns nothing on failure so the templates still apply.
 */
const EXPANSION_SYSTEM = `You write web search queries that close a specific gap in a research corpus.

You will be given a research goal, the questions the corpus has FAILED to answer, and the queries that have already been run. The already-run queries did not find the evidence — so do not paraphrase them.

For each unmet question, write one query that attacks it from a different direction: name the specific institution, dataset, standard, filing, registry, court, journal or trade publication that would hold the answer; use the vocabulary that field would use rather than the vocabulary of the request; or search for the artefact (a report title, a docket number, a table) instead of the topic.

Reply with ONLY the queries, one per line — no numbering, no bullets, no commentary. Each line must be a self-contained web search query. Write at most one line per unmet question.`;

export const expandResearchQueries: NonNullable<ResearchDeps["expandQueries"]> = async ({
  userId,
  goal,
  gaps,
  alreadyIssued,
  limit,
  signal,
}) => {
  const planner = researchPlannerModel();
  if (!planner || gaps.length === 0 || limit <= 0) return { queries: [], costMicroUsd: 0 };

  const prompt = [
    `Research goal: ${truncate(goal, 600)}`,
    "",
    "Questions the corpus has failed to answer:",
    ...gaps.slice(0, EXPANDED_QUERIES).map((gap) => `- (${gap.status}) ${gap.question}${gap.missingReason ? ` — ${gap.missingReason}` : ""}`),
    "",
    "Queries already run, which did NOT find it:",
    // The most RECENT forty: the list is the sweep's queries followed by the
    // workers', newest last, and the first forty of a long run are the seed
    // queries every follow-up has already been told about.
    ...alreadyIssued.slice(-40).map((query) => `- ${query}`),
  ].join("\n");

  const expanded = await utilityCompletion({
    userId,
    model: planner,
    system: EXPANSION_SYSTEM,
    prompt: prompt.slice(0, EXPANSION_PROMPT_CHARS),
    maxTokens: EXPANSION_OUTPUT_TOKENS,
    timeoutMs: PLAN_TIMEOUT_MS,
    signal,
    label: "expand",
  });

  return {
    queries: parsePlanLines(expanded.text, Math.min(limit, EXPANDED_QUERIES)),
    costMicroUsd: expanded.costMicroUsd,
  };
};

/**
 * WRITE — the report, on the utility model.
 *
 * Only the standalone research surface uses this. A research run started from
 * chat stops at `synthesizing` and the chat route streams the report through
 * the model the user picked, so the answer arrives on the same delta path as
 * every other turn instead of appearing all at once when a job finishes.
 */
export const writeResearchReport: NonNullable<ResearchDeps["synthesize"]> = async ({
  userId,
  goal,
  plan,
  sources,
  findings = [],
  signal,
  revision,
}) => {
  const model = researchPlannerModel();
  // The same function the citation audit numbers against — see `citableSources`.
  const readable = citableSources(sources);
  if (!model || readable.length === 0) return { report: "", costMicroUsd: 0 };

  const system = [
    buildResearchCorpus(goal, plan, readable, corpusFindings(plan, readable, findings)),
    ...(revision
      ? [
          `# Citation-driven revision (round ${revision.round})
Rewrite the draft below into a complete replacement report for the original request. Keep only claims that the numbered source material supports, preserve or correct citation numbers, and state any remaining uncertainty plainly. Return the full markdown report only; do not describe the revision process.`,
        ]
      : []),
  ].join("\n\n");
  const historyContent = revision
    ? [
        "Revise this previously audited draft against the source material and return the complete replacement report:",
        wrapUntrusted("previous research draft", revision.report.slice(0, REVISION_REPORT_CHARS)),
      ].join("\n\n")
    : truncate(goal, 2_000);
  let out = "";
  let input: number | undefined;
  let output: number | undefined;
  try {
    for await (const ev of streamChat({
      model,
      system,
      history: [{ role: "USER", content: historyContent, attachments: [] }],
      maxTokens: SYNTHESIS_OUTPUT_TOKENS,
      signal,
    })) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "usage") {
        input = ev.input ?? input;
        output = ev.output ?? output;
      }
    }
  } catch (e) {
    console.error("[research] synthesis failed", {
      model: model.id,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const billed = estimateGenerationCostUsd(model, {
    promptTokens: input,
    completionTokens: output,
    promptChars: system.length + goal.length,
    completionChars: out.length,
  });
  await recordSpend({
    userId,
    model: model.id,
    kind: "chat",
    source: "web",
    promptTokens: billed.promptTokens,
    completionTokens: billed.completionTokens,
    costUsd: billed.costUsd || undefined,
    promptChars: system.length + goal.length,
    completionChars: out.length,
  });
  return { report: out.trim(), costMicroUsd: Math.round(billed.costUsd * 1_000_000) };
};
