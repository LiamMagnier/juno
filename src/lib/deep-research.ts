import "server-only";
import { streamChat } from "@/lib/llm";
import { utilityModelCandidates } from "@/lib/memory";
import { PROVIDERS } from "@/lib/providers";
import { recordSpend } from "@/lib/spend";
import { estimateGenerationCostUsd } from "@/lib/pricing";
import { truncate } from "@/lib/utils";
import type { ModelInfo } from "@/lib/models";
import type { ClientActivityEvent, ClientSource } from "@/types/chat";

/**
 * Deep research orchestration: PLAN (a cheap fast model turns the prompt into
 * focused sub-questions) → SEARCH (parallel Tavily queries) → READ (Tavily's
 * raw page content — no scraper of our own) → hand the numbered corpus back to
 * the chat route, which streams the SYNTHESIS through the user's selected
 * model exactly like a normal turn (same delta path, budget enforcement,
 * persistence). Citations [n] in the report map by position to the sources
 * array — the same convention buildSearchContext and the SourcesList UI use.
 *
 * Every failure degrades: plan failure → search the raw prompt; search failure
 * → `ok: false` and the route answers as plain chat with a warning activity.
 * This module never throws into the stream.
 */

// Pre-synthesis time box. Plan (≤20s) and the parallel searches (≤25s) keep us
// well inside it in practice; the deadline is the hard wall for stragglers.
const PREP_DEADLINE_MS = 90_000;
const PLAN_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 25_000;
const MAX_QUERIES = 5;
const RESULTS_PER_QUERY = 5;
/** Pages whose full text enters the corpus; the rest contribute snippets. */
const MAX_READ_PAGES = 8;
/** Total numbered sources (read pages + snippet-only extras). */
const MAX_SOURCES = 12;
const PAGE_CONTENT_CHARS = 4_000;

type SendActivity = (event: Omit<ClientActivityEvent, "id" | "createdAt">) => ClientActivityEvent;

interface ResearchPage extends ClientSource {
  /** Tavily raw page content (already capped to PAGE_CONTENT_CHARS). */
  rawContent?: string;
}

export interface DeepResearchResult {
  /** false = nothing usable came back; the caller answers as plain chat. */
  ok: boolean;
  /** System-prompt section: report instructions + the numbered source corpus. */
  context: string;
  /** Numbered sources, in citation order — emit as the stream's sources chunk. */
  sources: ClientSource[];
  /** Planning-model spend in USD (already written to the ApiSpend ledger). */
  costUsd: number;
}

const EMPTY: DeepResearchResult = { ok: false, context: "", sources: [], costUsd: 0 };

/** A child signal that aborts with its parent OR after `ms` — whichever first. */
function timeboxSignal(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; release: () => void } {
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
 * The planning model: the fastest cheap tier from the SAME provider as the
 * user's selected model when one is configured (keys and quirks are known to
 * work), else the app-wide speed-ranked utility list, else the selected model.
 */
export function pickPlannerModel(selected: ModelInfo): ModelInfo {
  const candidates = utilityModelCandidates();
  return candidates.find((m) => m.provider === selected.provider) ?? candidates[0] ?? selected;
}

const PLANNER_SYSTEM = `You are a research planner. Break the user's request into focused web-search sub-questions.
Reply with ONLY the sub-questions, one per line — no numbering, no bullets, no commentary.
Each line must be a self-contained web search query (repeat names, dates, and context from the request; a query must make sense on its own).
Use 3 to 5 lines: complex requests deserve 5, simple ones 3.`;

function parsePlan(text: string): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const q = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (q.length < 8 || q.length > 400) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(q);
    if (queries.length >= MAX_QUERIES) break;
  }
  return queries;
}

/** PLAN: one cheap fast completion → 3-5 sub-questions. Spend is recorded here. */
async function planQueries(opts: {
  userId: string;
  prompt: string;
  planner: ModelInfo;
  client: "web" | "app";
  signal?: AbortSignal;
}): Promise<{ queries: string[]; costUsd: number }> {
  const { signal, release } = timeboxSignal(opts.signal, PLAN_TIMEOUT_MS);
  let out = "";
  let usage: {
    input?: number;
    output?: number;
    reasoning?: number;
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    webSearchRequests?: number;
    xSearchRequests?: number;
  } = {};
  try {
    for await (const ev of streamChat({
      model: opts.planner,
      system: PLANNER_SYSTEM,
      history: [{ role: "USER", content: opts.prompt.slice(0, 4_000), attachments: [] }],
      maxTokens: 1024,
      signal,
    })) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "usage") {
        usage = {
          input: ev.input ?? usage.input,
          output: ev.output ?? usage.output,
          reasoning: ev.reasoning ?? usage.reasoning,
          total: ev.total ?? usage.total,
          cacheRead: ev.cacheRead ?? usage.cacheRead,
          cacheWrite: ev.cacheWrite ?? usage.cacheWrite,
          cacheWrite5m: ev.cacheWrite5m ?? usage.cacheWrite5m,
          cacheWrite1h: ev.cacheWrite1h ?? usage.cacheWrite1h,
          webSearchRequests: ev.webSearchRequests ?? usage.webSearchRequests,
          xSearchRequests: ev.xSearchRequests ?? usage.xSearchRequests,
        };
      }
    }
  } catch (e) {
    console.error("[deep-research] plan failed", {
      model: opts.planner.id,
      message: signal.aborted ? "timed out or aborted" : e instanceof Error ? e.message : String(e),
    });
  } finally {
    release();
  }
  // Bill whatever the planner actually consumed, even when parsing fails.
  let costUsd = 0;
  if (out || usage.input != null || usage.output != null) {
    const billed = estimateGenerationCostUsd(opts.planner, {
      promptTokens: usage.input,
      completionTokens: usage.output,
      reasoningTokens: usage.reasoning,
      totalTokens: usage.total,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cacheWrite5m: usage.cacheWrite5m,
      cacheWrite1h: usage.cacheWrite1h,
      webSearchRequests: usage.webSearchRequests,
      xSearchRequests: usage.xSearchRequests,
      promptChars: PLANNER_SYSTEM.length + opts.prompt.length,
      completionChars: out.length,
    });
    costUsd = billed.costUsd;
    await recordSpend({
      userId: opts.userId,
      model: opts.planner.id,
      kind: "chat",
      source: opts.client,
      promptTokens: billed.promptTokens,
      completionTokens: billed.completionTokens,
      reasoningTokens: usage.reasoning,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cacheWrite5m: usage.cacheWrite5m,
      cacheWrite1h: usage.cacheWrite1h,
      webSearchRequests: usage.webSearchRequests,
      xSearchRequests: usage.xSearchRequests,
      costUsd: costUsd || undefined,
      promptChars: PLANNER_SYSTEM.length + opts.prompt.length,
      completionChars: out.length,
    });
  }
  return { queries: parsePlan(out), costUsd };
}

/** SEARCH + READ in one call: Tavily returns each result's raw page content. */
async function tavilySearch(query: string, signal: AbortSignal): Promise<ResearchPage[]> {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key || !query.trim()) return [];
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
      signal,
    });
    if (!res.ok) {
      console.error("[deep-research] tavily", res.status);
      return [];
    }
    const data = await res.json();
    return ((data.results ?? []) as { url?: string; title?: string; content?: string; raw_content?: string | null }[])
      .filter((r) => r.url && r.title)
      .slice(0, RESULTS_PER_QUERY)
      .map((r) => ({
        title: r.title!,
        url: r.url!,
        snippet: (r.content ?? "").slice(0, 600),
        rawContent: typeof r.raw_content === "string" && r.raw_content.trim() ? r.raw_content.slice(0, PAGE_CONTENT_CHARS) : undefined,
      }));
  } catch (e) {
    if (!signal.aborted) console.error("[deep-research]", e);
    return [];
  }
}

/**
 * Interleave the per-query result lists (rank 1 of every query, then rank 2…)
 * so each sub-question contributes sources, deduped by URL.
 */
function collectSources(resultLists: ResearchPage[][]): ResearchPage[] {
  const pages: ResearchPage[] = [];
  const seen = new Set<string>();
  for (let rank = 0; rank < RESULTS_PER_QUERY && pages.length < MAX_SOURCES; rank++) {
    for (const list of resultLists) {
      const page = list[rank];
      if (!page || seen.has(page.url)) continue;
      seen.add(page.url);
      pages.push(page);
      if (pages.length >= MAX_SOURCES) break;
    }
  }
  return pages;
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The synthesis contract + numbered corpus, appended to the system prompt. */
function buildResearchContext(prompt: string, pages: ResearchPage[], readUrls: Set<string>): string {
  const corpus = pages
    .map((p, i) => {
      const body = readUrls.has(p.url) && p.rawContent ? p.rawContent : p.snippet;
      return `[${i + 1}] ${p.title}\n${p.url}\n${body}`;
    })
    .join("\n\n");
  return `# Deep research mode
The user enabled deep research for this message: "${truncate(prompt, 300)}". You are writing a research REPORT, not a chat reply, grounded in the numbered source material below (gathered moments ago via live web search).

Structure the report as markdown:
- Start with a single "# " title naming the subject.
- Organize the body into "## " findings sections that together answer the request.
- End with a "## Sources" section listing every source you cited as "[n] Title — URL", one per line.

Rules:
- Cite every load-bearing claim inline with bracketed source numbers like [1] or [2][3] that map EXACTLY to the numbered sources below. Dense citation is expected.
- When sources disagree, say so explicitly and attribute each position to its source.
- If something relevant could not be verified in these sources, say plainly that it is unverified — never fill gaps with guesses.
- Never invent sources or cite numbers outside the list.

# Source material
${corpus}`;
}

export async function runDeepResearch(opts: {
  userId: string;
  /** The user's message, plaintext (clarification-expanded when applicable). */
  prompt: string;
  /** The user's SELECTED model — synthesis runs on it; planning picks a fast sibling. */
  selectedModel: ModelInfo;
  client: "web" | "app";
  signal?: AbortSignal;
  /** The chat route's activity emitter — events land in the existing timeline. */
  sendActivity: SendActivity;
}): Promise<DeepResearchResult> {
  const prompt = opts.prompt.trim();
  if (!prompt) return EMPTY;
  const deadline = Date.now() + PREP_DEADLINE_MS;

  // ── PLAN ──────────────────────────────────────────────────────────────────
  const planner = pickPlannerModel(opts.selectedModel);
  opts.sendActivity({
    kind: "reasoning",
    title: "Planning research",
    detail: `${PROVIDERS[planner.provider].label} · ${planner.name}`,
  });
  const plan = await planQueries({ userId: opts.userId, prompt, planner, client: opts.client, signal: opts.signal });
  // A failed plan degrades to searching the prompt itself, not to a dead turn.
  const queries = plan.queries.length ? plan.queries : [truncate(prompt, 300)];

  // ── SEARCH (+ READ: Tavily returns raw page content in the same call) ─────
  if (opts.signal?.aborted || Date.now() >= deadline) return { ...EMPTY, costUsd: plan.costUsd };
  const { signal: searchSignal, release } = timeboxSignal(
    opts.signal,
    Math.min(SEARCH_TIMEOUT_MS, deadline - Date.now())
  );
  for (const query of queries) {
    opts.sendActivity({ kind: "search", title: "Searching the web", detail: truncate(query, 96) });
  }
  const resultLists = await Promise.all(queries.map((q) => tavilySearch(q, searchSignal)));
  release();

  const pages = collectSources(resultLists);
  if (pages.length === 0) return { ...EMPTY, costUsd: plan.costUsd };

  const readUrls = new Set(pages.filter((p) => p.rawContent).slice(0, MAX_READ_PAGES).map((p) => p.url));
  for (const page of pages) {
    if (!readUrls.has(page.url)) continue;
    opts.sendActivity({
      kind: "visit",
      title: "Reading source",
      detail: truncate(page.title && page.title !== page.url ? page.title : sourceHost(page.url), 96),
      url: page.url,
    });
  }
  opts.sendActivity({
    kind: "context",
    title: "Research corpus ready",
    detail: `${pages.length} source${pages.length === 1 ? "" : "s"} · ${queries.length} ${queries.length === 1 ? "search" : "searches"} · ${readUrls.size} read in full`,
  });

  return {
    ok: true,
    context: buildResearchContext(prompt, pages, readUrls),
    // Strip rawContent: the client/persisted sources stay snippet-sized.
    // `cited` marks these as the numbered corpus the model was actually given,
    // which is what licenses the UI to resolve inline [n] markers positionally.
    // Deep research is the ONLY path that numbers sources for the model.
    sources: pages.map(({ title, url, snippet }) => ({ title, url, snippet, cited: true })),
    costUsd: plan.costUsd,
  };
}
