import "server-only";
import { streamChat } from "@/lib/llm";
import { utilityModelCandidates } from "@/lib/memory";
import { recordSpend } from "@/lib/spend";
import { estimateGenerationCostUsd } from "@/lib/pricing";
import { truncate } from "@/lib/utils";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "@/lib/untrusted-content";
import type { ModelInfo } from "@/lib/models";
import type { ResearchDeps, ResearchHit, ResearchSourceRow } from "@/lib/research/engine";
import type { ResearchPlan } from "@/lib/research/domain";

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

const PLAN_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 25_000;
const FETCH_TIMEOUT_MS = 20_000;
const RESULTS_PER_QUERY = 5;
const PAGE_CONTENT_CHARS = 8_000;
/** What one Tavily basic search costs us, for the pre-spend estimate. */
const TAVILY_SEARCH_MICRO_USD = 8_000;
const TAVILY_EXTRACT_MICRO_USD = 2_000;

const PLANNER_SYSTEM = `You are a research planner. Break the user's request into focused web-search sub-questions.
Reply with ONLY the sub-questions, one per line — no numbering, no bullets, no commentary.
Each line must be a self-contained web search query (repeat names, dates, and context from the request; a query must make sense on its own).
Use 3 to 5 lines: complex requests deserve 5, simple ones 3.`;

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
 * PLAN — one cheap fast completion turns the goal into sub-questions.
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
  const prompt = constraints.length
    ? `${goal}\n\nConstraints the searches must respect:\n${constraints.map((c) => `- ${c}`).join("\n")}`
    : goal;

  const box = timeboxSignal(signal, PLAN_TIMEOUT_MS);
  let out = "";
  let input: number | undefined;
  let output: number | undefined;
  try {
    for await (const ev of streamChat({
      model: planner,
      system: PLANNER_SYSTEM,
      history: [{ role: "USER", content: prompt.slice(0, 4_000), attachments: [] }],
      maxTokens: 1024,
      signal: box.signal,
    })) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "usage") {
        input = ev.input ?? input;
        output = ev.output ?? output;
      }
    }
  } catch (e) {
    console.error("[research] plan failed", {
      model: planner.id,
      message: box.signal.aborted ? "timed out or aborted" : e instanceof Error ? e.message : String(e),
    });
  } finally {
    box.release();
  }

  // Bill whatever the planner actually consumed, even when parsing produced
  // nothing usable — the tokens were spent either way, and a run whose ledger
  // omits its failures under-reports what research costs.
  const billed = estimateGenerationCostUsd(planner, {
    promptTokens: input,
    completionTokens: output,
    promptChars: PLANNER_SYSTEM.length + prompt.length,
    completionChars: out.length,
  });
  await recordSpend({
    userId,
    model: planner.id,
    kind: "chat",
    source: "web",
    promptTokens: billed.promptTokens,
    completionTokens: billed.completionTokens,
    costUsd: billed.costUsd || undefined,
    promptChars: PLANNER_SYSTEM.length + prompt.length,
    completionChars: out.length,
  });
  return {
    queries: parsePlanLines(out, 5),
    costMicroUsd: Math.round(billed.costUsd * 1_000_000),
  };
};

/** True when the deployment has a search backend at all. */
export function researchSearchConfigured(): boolean {
  return !!process.env.TAVILY_API_KEY?.trim();
}

/**
 * SEARCH — Tavily, with the page body in the same call.
 *
 * `include_raw_content` is what stops the READ stage paying to fetch a page the
 * search already returned; the engine stores that body as the snapshot on the
 * spot. No scraper of our own, which is the same decision the in-request
 * pipeline made and for the same reason: a fetch-and-strip loop over arbitrary
 * URLs is a server-side request forgery surface, and this one is driven by
 * whatever a search engine decided to return.
 */
export const searchTheWeb: ResearchDeps["search"] = async ({ query, signal }) => {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key || !query.trim()) return { hits: [], costMicroUsd: 0 };
  const box = timeboxSignal(signal, SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query: query.slice(0, 400),
        max_results: RESULTS_PER_QUERY,
        search_depth: "basic",
        include_raw_content: true,
      }),
      signal: box.signal,
    });
    if (!res.ok) {
      console.error("[research] tavily search", res.status);
      // A refused request costs nothing; a rate-limited one already did. Bill
      // the estimate either way rather than let a run retry a failing backend
      // for free until it hits the step limit.
      return { hits: [], costMicroUsd: res.status === 429 ? TAVILY_SEARCH_MICRO_USD : 0 };
    }
    const data = (await res.json()) as {
      results?: Array<{ url?: string; title?: string; content?: string; raw_content?: string | null }>;
    };
    const hits: ResearchHit[] = (data.results ?? [])
      .filter((r): r is { url: string; title: string; content?: string; raw_content?: string | null } =>
        !!r.url && !!r.title
      )
      .slice(0, RESULTS_PER_QUERY)
      .map((r) => ({
        url: r.url,
        title: r.title,
        snippet: (r.content ?? "").slice(0, 600),
        rawContent:
          typeof r.raw_content === "string" && r.raw_content.trim()
            ? r.raw_content.slice(0, PAGE_CONTENT_CHARS)
            : undefined,
      }));
    return { hits, costMicroUsd: TAVILY_SEARCH_MICRO_USD };
  } catch (e) {
    if (!box.signal.aborted) console.error("[research] tavily search", e);
    return { hits: [], costMicroUsd: 0 };
  } finally {
    box.release();
  }
};

/**
 * FETCH — Tavily's extract endpoint, for a URL no search returned text for.
 *
 * This is the only path that reaches a user-supplied URL (a pinned source), and
 * it deliberately goes through Tavily rather than fetching directly: the
 * request leaves Tavily's network, not ours, so a pinned `http://169.254.…`
 * reaches a third party's fetcher instead of our metadata endpoint.
 */
export const fetchResearchPage: ResearchDeps["fetchPage"] = async ({ url, signal }) => {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) return null;
  const box = timeboxSignal(signal, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, urls: [url] }),
      signal: box.signal,
    });
    if (!res.ok) {
      console.error("[research] tavily extract", res.status);
      return null;
    }
    const data = (await res.json()) as {
      results?: Array<{ url?: string; raw_content?: string | null; title?: string }>;
    };
    const first = data.results?.[0];
    const text = typeof first?.raw_content === "string" ? first.raw_content.trim() : "";
    if (!text) return null;
    return {
      title: (first?.title ?? url).slice(0, 300),
      text: text.slice(0, PAGE_CONTENT_CHARS),
      costMicroUsd: TAVILY_EXTRACT_MICRO_USD,
    };
  } catch (e) {
    if (!box.signal.aborted) console.error("[research] tavily extract", e);
    return null;
  } finally {
    box.release();
  }
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
      const body = (source.snapshot ?? "").slice(0, PAGE_CONTENT_CHARS);
      return `[${i + 1}] ${title}\n${source.url}\n${wrapUntrusted(source.url, body)}`;
    })
    .join("\n\n");
  const constraints = plan.constraints.length
    ? `\nConstraints the user set for this research (these are the user's own instructions, and they apply to the whole report):\n${plan.constraints
        .map((c) => `- ${c}`)
        .join("\n")}\n`
    : "";
  return `# Deep research mode
The user asked for research on: "${truncate(goal, 300)}". You are writing a research REPORT, not a chat reply, grounded in the numbered source material below (gathered by a research run, with each source's fetched text stored alongside a hash of it).

Structure the report as markdown:
- Start with a single "# " title naming the subject.
- Organize the body into "## " findings sections that together answer the request.
- End with a "## Sources" section listing every source you cited as "[n] Title — URL", one per line.

Rules:
- Cite every load-bearing claim inline with bracketed source numbers like [1] or [2][3] that map EXACTLY to the numbered sources below. Dense citation is expected.
- When sources disagree, say so explicitly and attribute each position to its source.
- Two sources with the same text are one source: never present them as independent corroboration.
- Distinguish when a source was published from when the event it describes happened.
- If something relevant could not be verified in these sources, say plainly that it is unverified — never fill gaps with guesses.
- Never invent sources or cite numbers outside the list.
${constraints}
${UNTRUSTED_CONTENT_RULE}

# Source material
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
}) => {
  const model = researchPlannerModel();
  const readable = sources.filter((source) => source.snapshot);
  if (!model || readable.length === 0) return { report: "", costMicroUsd: 0 };

  const system = buildResearchCorpus(goal, plan, readable);
  let out = "";
  let input: number | undefined;
  let output: number | undefined;
  try {
    for await (const ev of streamChat({
      model,
      system,
      history: [{ role: "USER", content: truncate(goal, 2_000), attachments: [] }],
      maxTokens: 8_192,
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
