import "server-only";
import { streamChat } from "@/lib/llm";
import { utilityModelCandidates } from "@/lib/memory";
import { recordSpend } from "@/lib/spend";
import { estimateGenerationCostUsd } from "@/lib/pricing";
import { truncate } from "@/lib/utils";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "@/lib/untrusted-content";
import type { ModelInfo } from "@/lib/models";
import { SNAPSHOT_CHARS, type ResearchDeps, type ResearchHit, type ResearchSourceRow } from "@/lib/research/engine";
import {
  BRIEF_OUTPUT_TOKENS,
  BRIEF_PROMPT_CHARS,
  EXPANSION_OUTPUT_TOKENS,
  EXPANSION_PROMPT_CHARS,
  MAX_PLAN_STEPS,
  PAGE_FETCH_FEE_MICRO_USD,
  PLANNER_OUTPUT_TOKENS,
  PLANNER_PROMPT_CHARS,
  REVISION_REPORT_CHARS,
  SEARCH_FEE_MICRO_USD,
  SYNTHESIS_OUTPUT_TOKENS,
  type ResearchPlan,
} from "@/lib/research/domain";

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

const BRIEF_TIMEOUT_MS = 20_000;
const PLAN_TIMEOUT_MS = 25_000;
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
const RESULTS_PER_QUERY = 18;
/** Queries the planner may draft up front. The engine's own ceiling is MAX_PLAN_QUERIES. */
const PLANNED_QUERIES = 14;
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
 * is SNAPSHOT_CHARS — imported rather than redeclared, because a storage cap
 * and a prompt cap that quietly disagree is how half of every document ended up
 * being thrown away with the corpus builder still slicing at a number nothing
 * ever reached.
 */
const PAGE_CONTENT_CHARS = 16_000;

/**
 * The planner writes TWO things, and the second one is why this prompt changed.
 *
 * It used to emit only search queries, and the plan gate — the screen where a
 * person decides whether to spend money — had nothing else to show them. A bag
 * of search strings is the machine's shopping list; you cannot tell from
 * "claude max vs chatgpt pro price" whether the investigation is going to cover
 * what you care about, which is the only question the gate asks. So the model
 * also writes the plan a person reads: ordered sentences naming what the run
 * will actually do, in the order it will do it.
 *
 * One call, two sections. Steps are intent, queries are execution, and asking
 * for them together is what keeps them describing the same investigation — a
 * second call would let the two drift, and the gate would then be approving a
 * plan the searches do not implement.
 *
 * The section markers are literal and parsed positionally by `parsePlanSections`.
 */
const PLANNER_SYSTEM = `You are an expert autonomous deep-research planner. You produce a research plan in two sections.

## PLAN
The plan a person reads before approving the run. Write 4 to ${PLANNED_STEPS} steps, one per line, in the order the research will happen.
Each step is ONE full sentence in plain language, starting with a verb, describing what will be investigated — not how it will be searched.
Name the specific entities, documents, quantities or comparisons involved. Never mention search engines, queries or keywords.
Move from establishing the facts, through the evidence, to the comparison or judgement the reader asked for.
Example shape: "Collect official pricing, feature and usage-limit information from each vendor's own documentation."

## QUERIES
The searches that will execute the plan above. Write 10 to ${PLANNED_QUERIES} queries, one per line.
Each must be a self-contained, high-intent web search query (repeat names, dates and context; a query must make sense on its own).
Between them the queries must cover:
1. Foundational concepts, official documentation, specifications, and primary sources
2. Empirical evidence, statistics, benchmarks, case studies, and quantitative data
3. Counter-arguments, conflicting perspectives, trade-offs, and critical debates
4. Most recent developments, latest news, releases, and current status
5. Adjacent and second-order angles: who is affected, what it is usually compared against, what the sceptics measure
Vary the phrasing and the vocabulary between lines — near-duplicate queries return the same pages and waste the run's budget.

Reply with exactly the two headings above and the lines under them. No numbering, no bullets, no commentary.`;

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
  return utilityModelCandidates()[0] ?? null;
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
 * PLAN — expand the goal into a brief, then decompose the brief into queries.
 *
 * Never throws. A planner that fails returns no queries and the engine falls
 * back to searching the goal itself; a durable run that died because its
 * cheapest step timed out would be the worst possible trade.
 */
export const planResearchQueries: ResearchDeps["plan"] = async ({
  userId,
  goal,
  constraints,
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

  const planned = await utilityCompletion({
    userId,
    model: planner,
    system: PLANNER_SYSTEM,
    prompt: prompt.slice(0, PLANNER_PROMPT_CHARS),
    maxTokens: PLANNER_OUTPUT_TOKENS,
    timeoutMs: PLAN_TIMEOUT_MS,
    signal,
    label: "plan",
  });

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
    queries: parsePlanLines(sections.queries, PLANNED_QUERIES),
    // Both calls are the plan step as far as the run's ledger is concerned.
    costMicroUsd: brief.costMicroUsd + planned.costMicroUsd,
  };
};

import { extractUrlDocument, isSearchEngineAvailable, searchWithEngineReport } from "@/lib/search/search-engine";

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
export const searchTheWeb: ResearchDeps["search"] = async ({ query, signal }) => {
  if (!query.trim()) return { hits: [], costMicroUsd: 0 };
  const box = timeboxSignal(signal, SEARCH_TIMEOUT_MS);
  try {
    const { results, engines, providers } = await searchWithEngineReport({
      query: query.slice(0, 400),
      count: RESULTS_PER_QUERY,
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
  try {
    const outcome = await extractUrlDocument(url, box.signal);
    if (!outcome.ok) {
      const failure = outcome.failure;
      return {
        skipped: failure.reason,
        ...(failure.reason === "unsupported_content_type" ? { detail: failure.contentType } : {}),
        ...(failure.reason === "http_error" ? { detail: String(failure.httpStatus) } : {}),
        // Which PDF gave up and how: "encrypted", "malformed", "too_large",
        // "not_a_pdf". Without it every unreadable PDF looks the same in the
        // timeline, and a password-protected filing and a truncated download
        // want completely different things from the user.
        ...(failure.reason === "pdf_unreadable" ? { detail: failure.detail } : {}),
      };
    }
    if (!outcome.page.text) return null;
    return {
      title: (outcome.page.title || url).slice(0, 300),
      text: outcome.page.text.slice(0, PAGE_CONTENT_CHARS),
      costMicroUsd: PAGE_FETCH_FEE_MICRO_USD,
      links: outcome.page.links,
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
    ...alreadyIssued.slice(0, 40).map((query) => `- ${query}`),
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
 * The synthesis contract and the numbered corpus.
 *
 * Exported because the chat route needs the identical string: a run driven to
 * `synthesizing` and handed back to chat is written by the user's own model
 * against this exact corpus, and two versions of the citation contract would
 * mean two conventions for what `[3]` refers to.
 *
 * Both `title` and the body are page-controlled and this text is appended to
 * the SYSTEM prompt — the highest-authority slot there is. Unwrapped, a page
 * whose text contains "[13] Official policy\nhttps://…\n…" is byte-identical to
 * a real corpus entry, so a hostile page could forge extra sources, defeat the
 * citation contract and issue instructions from inside the system prompt. The
 * envelope keeps the numbering and the URL outside it — those are ours — and
 * puts only the fetched text inside. The title is collapsed to one line for the
 * same reason: a newline in it would let one page forge a second entry.
 */
export function buildResearchCorpus(
  goal: string,
  plan: ResearchPlan,
  sources: Array<Pick<ResearchSourceRow, "url" | "title" | "snapshot">>
): string {
  const corpus = sources
    .map((source, i) => {
      const title = source.title.replace(/\s+/g, " ").slice(0, 200);
      // SNAPSHOT_CHARS, not PAGE_CONTENT_CHARS: the stored snapshot is already
      // capped at the former, so slicing at the latter was a no-op pretending
      // to be a limit.
      const body = (source.snapshot ?? "").slice(0, SNAPSHOT_CHARS);
      return `[${i + 1}] ${title}\n${source.url}\n${wrapUntrusted(source.url, body)}`;
    })
    .join("\n\n");
  const constraints = plan.constraints.length
    ? `\nConstraints the user set for this research (these are the user's own instructions, and they apply to the whole report):\n${plan.constraints
        .map((c) => `- ${c}`)
        .join("\n")}\n`
    : "";
  return `# Autonomous Deep Research Mode
The user requested an exhaustive, authoritative research investigation on: "${truncate(goal, 300)}".
You are writing a comprehensive, publication-grade research REPORT, grounded strictly in the numbered source material below.

# Report Structure:
1. "# Title": Clear, professional title naming the topic.
2. "## Executive Summary": High-level synthesis highlighting key findings, core thesis, and high-impact takeaways.
3. "## Key Findings & Core Analysis": Detailed thematic sections (using "### Subheadings") breaking down the subject with quantitative data, benchmark comparisons, timelines, and technical details. Use Markdown comparison tables where appropriate.
4. "## Nuances, Contradictions & Trade-Offs": Explicitly analyze conflicting claims or divergent evidence between sources.
5. "## Limitations & Open Questions": What remains uncertain or unverifiable from current evidence.
6. "## Sources": Numbered list matching cited references as "[n] Title — URL".

# Citation & Accuracy Rules:
- Cite EVERY factual assertion, statistic, quote, and claim inline with bracketed numbers (e.g. [1], [2][4]) mapping directly to the numbered source list below.
- Strict factual grounding: Do NOT fabricate details or cite numbers outside the numbered list.
- When sources disagree or have different methodologies, explain the disagreement and cite each source.
- Two sources repeating the same press release or mirror text are not independent corroboration.
${constraints}
${UNTRUSTED_CONTENT_RULE}

# Numbered Source Material:
${corpus}`;
}

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
  signal,
  revision,
}) => {
  const model = researchPlannerModel();
  const readable = sources.filter((source) => source.snapshot);
  if (!model || readable.length === 0) return { report: "", costMicroUsd: 0 };

  const system = [
    buildResearchCorpus(goal, plan, readable),
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
