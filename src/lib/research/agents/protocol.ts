import { isDisallowedHost } from "@/lib/search/url-safety";
import type { ResearchDelegation, ResearchObjective, ResearchRoundReview } from "@/lib/research/domain";

/**
 * The contract between the research engine and its agents.
 *
 * Three parties meet here and none of them may import the others: the engine
 * (src/lib/research/engine.ts) implements the tools and owns the money; the
 * worker runner (src/lib/research/agents/worker.ts) drives a model against
 * those tools and is `server-only`; and the tests drive the engine with fakes
 * of both. So the tool names, their JSON schemas, the argument validation and
 * the page chunking live in this one dependency-free module, and each side
 * imports the same definitions rather than its own copy — a worker that calls
 * `open_page` with a schema the engine validates differently is a worker whose
 * every call fails, silently, in production only.
 */

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

/** Characters per chunk. A chunk is what a worker greps and what a finding cites. */
export const CHUNK_CHARS = 1_200;
/** Chunks one page may hold: 50 × 1,200 covers the 60,000-character store cap. */
export const MAX_CHUNKS_PER_PAGE = 50;
/** Characters of a chunk shown in the page digest's index. */
export const CHUNK_PREVIEW_CHARS = 160;

export interface PageChunk {
  ordinal: number;
  text: string;
  /** `chars:<start>-<end>` into the stored snapshot, for the citation inspector. */
  locator: string;
}

/**
 * Cuts a page into numbered chunks, deterministically.
 *
 * Deterministic is the property that matters: the chunks are NOT stored as
 * the page's canonical form — the snapshot is — so `open_page`, `find_in_page`
 * and the finding's `chunk:<n>` locator all have to agree on where chunk 7
 * starts, and they agree by recomputing it from the same bytes with this
 * function. Boundaries prefer a paragraph break, then a sentence end, so a
 * quote a worker takes from chunk 7 is not cut mid-sentence.
 */
export function chunkText(text: string): PageChunk[] {
  const out: PageChunk[] = [];
  let cursor = 0;
  while (cursor < text.length && out.length < MAX_CHUNKS_PER_PAGE) {
    let end = Math.min(text.length, cursor + CHUNK_CHARS);
    if (end < text.length) {
      const window = text.slice(cursor, end);
      const paragraph = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
      const cut = paragraph >= CHUNK_CHARS / 2 ? paragraph : sentence >= CHUNK_CHARS / 2 ? sentence + 1 : -1;
      if (cut > 0) end = cursor + cut;
    }
    const body = text.slice(cursor, end);
    if (body.trim().length > 0) {
      out.push({ ordinal: out.length, text: body.trim(), locator: `chars:${cursor}-${end}` });
    }
    cursor = end;
    // Skip the whitespace between chunks so the next one starts on text.
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
  }
  return out;
}

/** The chunk a `chunk:<n>` locator names, or null. */
export function chunkOrdinal(locator: string | null | undefined): number | null {
  const match = /^chunk:(\d{1,3})$/.exec(locator ?? "");
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const WORKER_TOOL_NAMES = ["search", "open_page", "find_in_page", "note_finding", "done"] as const;
export type WorkerToolName = (typeof WORKER_TOOL_NAMES)[number];

/** A tool as declared to the model — the OpenAI function shape, which every adapter can translate. */
export interface WorkerToolDefinition {
  name: WorkerToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export const MAX_QUERY_ARG_CHARS = 300;
export const MAX_PATTERN_ARG_CHARS = 200;
export const MAX_CLAIM_ARG_CHARS = 600;
export const MAX_QUOTE_ARG_CHARS = 800;
export const MAX_SUMMARY_ARG_CHARS = 3_000;
export const MAX_URL_ARG_CHARS = 2_000;

export const WORKER_TOOLS: readonly WorkerToolDefinition[] = [
  {
    name: "search",
    description:
      "Search the web. Start with short, broad queries (2-5 words) and narrow only once you know the vocabulary the field uses. Returns numbered results; results already read by this run are marked so you can skip them.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "open_page",
    description:
      "Open a page from a search result and read it as a summary plus a numbered chunk index. Use find_in_page to read specific chunks in full. A page already read by this run returns its cached summary without a fetch.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "An http(s) URL from a search result." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "find_in_page",
    description:
      "Search an opened page for a word, phrase or regular expression and get the matching chunks in full. Use it to pull the exact figure, date or quote you will cite.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "A URL you have opened." },
        pattern: { type: "string", description: "A word, phrase or regular expression to find." },
      },
      required: ["url", "pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "note_finding",
    description:
      "Record one finding: a claim in your own words, the verbatim quote from the page that supports it, the page URL and the chunk it came from. Note a finding as soon as you have it — findings are the only thing you return.",
    parameters: {
      type: "object",
      properties: {
        claim: { type: "string", description: "The claim, one or two sentences, specific (numbers, dates, names)." },
        quote: { type: "string", description: "The exact words from the page that support the claim." },
        url: { type: "string", description: "The page the quote is from." },
        locator: { type: "string", description: "The chunk, as chunk:<n>, from open_page or find_in_page." },
        confidence: { type: "number", description: "0 to 1: how well the quote supports the claim." },
      },
      required: ["claim", "quote", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "done",
    description:
      "Finish. Give a short summary of what you established, the questions you could not answer, and the searches you would suggest next.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What you established, in a few sentences." },
        open_questions: { type: "array", items: { type: "string" }, description: "What you could not answer." },
        follow_ups: { type: "array", items: { type: "string" }, description: "Searches or sources worth trying next." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

/**
 * A URL a worker may hand to a tool.
 *
 * Validated against the SAME filter the fetcher applies, so a worker cannot
 * be talked — by a page it read — into probing an internal address: the
 * fetcher would refuse it anyway, but refusing it here keeps the attempt out
 * of the event log and out of the worker's tool budget.
 */
export function validateToolUrl(raw: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "url must be a string" };
  const url = raw.trim().slice(0, MAX_URL_ARG_CHARS);
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "only http(s) URLs can be opened" };
  try {
    new URL(url);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (isDisallowedHost(url)) return { ok: false, reason: "that address is not one this app is allowed to fetch" };
  return { ok: true, url };
}

export type ParsedToolArgs =
  | { name: "search"; query: string }
  | { name: "open_page"; url: string }
  | { name: "find_in_page"; url: string; pattern: string }
  | { name: "note_finding"; claim: string; quote: string; url: string; locator?: string; confidence?: number }
  | { name: "done"; summary: string; openQuestions: string[]; followUps: string[] };

/**
 * Turns whatever the model sent into typed arguments, or a reason it cannot.
 *
 * Every string is bounded here, because the arguments are model output and
 * model output is unbounded: a worker that pastes a whole page into `quote`
 * would otherwise store it as a finding and send it back to the lead.
 */
export function parseToolArgs(
  name: string,
  args: Record<string, unknown>
): { ok: true; parsed: ParsedToolArgs } | { ok: false; reason: string } {
  const text = (key: string, max: number): string => (typeof args[key] === "string" ? (args[key] as string).trim().slice(0, max) : "");
  switch (name) {
    case "search": {
      const query = text("query", MAX_QUERY_ARG_CHARS);
      if (!query) return { ok: false, reason: "search needs a query" };
      return { ok: true, parsed: { name, query } };
    }
    case "open_page": {
      const url = validateToolUrl(args.url);
      if (!url.ok) return url;
      return { ok: true, parsed: { name, url: url.url } };
    }
    case "find_in_page": {
      const url = validateToolUrl(args.url);
      if (!url.ok) return url;
      const pattern = text("pattern", MAX_PATTERN_ARG_CHARS);
      if (!pattern) return { ok: false, reason: "find_in_page needs a pattern" };
      return { ok: true, parsed: { name, url: url.url, pattern } };
    }
    case "note_finding": {
      const claim = text("claim", MAX_CLAIM_ARG_CHARS);
      const quote = text("quote", MAX_QUOTE_ARG_CHARS);
      if (!claim || !quote) return { ok: false, reason: "note_finding needs a claim and a quote" };
      const url = validateToolUrl(args.url);
      if (!url.ok) return url;
      const locator = text("locator", 20);
      const confidence =
        typeof args.confidence === "number" && Number.isFinite(args.confidence)
          ? Math.max(0, Math.min(1, args.confidence))
          : undefined;
      return {
        ok: true,
        parsed: {
          name,
          claim,
          quote,
          url: url.url,
          ...(chunkOrdinal(locator) !== null ? { locator } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
        },
      };
    }
    case "done": {
      const list = (key: string): string[] =>
        Array.isArray(args[key])
          ? (args[key] as unknown[])
              .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              .map((item) => item.trim().slice(0, MAX_QUERY_ARG_CHARS))
              .slice(0, 8)
          : [];
      return {
        ok: true,
        parsed: {
          name,
          summary: text("summary", MAX_SUMMARY_ARG_CHARS),
          openQuestions: list("open_questions"),
          followUps: list("follow_ups"),
        },
      };
    }
    default:
      return { ok: false, reason: `unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------
// What the engine offers a worker, and what a worker returns
// ---------------------------------------------------------------------------

export interface WorkerSearchHit {
  url: string;
  title: string;
  snippet: string;
  /** Already opened by this run — the worker is told, so it can skip it. */
  read: boolean;
}

export type WorkerPageDigest =
  | {
      ok: true;
      sourceId: string;
      url: string;
      title: string;
      /** The cached summary, or the first chunk when no summariser is wired. */
      summary: string;
      chunkCount: number;
      chunks: Array<{ ordinal: number; preview: string }>;
      /** True when another worker (or an earlier round) had already read it. */
      alreadyRead: boolean;
    }
  | { ok: false; url: string; reason: string };

export interface WorkerFindMatch {
  ordinal: number;
  text: string;
}

/**
 * Why a tool result tells the worker to stop.
 *
 * Carried on the result rather than thrown, because the runner has to relay it
 * to the model as the reason its next call will not be honoured — a worker
 * that is cut off with an exception ends with no `done` summary, and the lead
 * then has nothing to review from it.
 */
export type WorkerStopReason = "tool_limit" | "time_limit" | "budget" | "page_limit" | "aborted";

export interface WorkerToolOutcome<T> {
  result: T;
  /** Set when this was the worker's last honoured call. */
  stop?: WorkerStopReason;
}

/** The tools the engine implements for one worker, already bound to the run and the worker id. */
export interface WorkerTools {
  search(query: string): Promise<WorkerToolOutcome<{ hits: WorkerSearchHit[]; note?: string }>>;
  openPage(url: string): Promise<WorkerToolOutcome<WorkerPageDigest>>;
  findInPage(
    url: string,
    pattern: string
  ): Promise<WorkerToolOutcome<{ ok: boolean; matches: WorkerFindMatch[]; reason?: string }>>;
  noteFinding(finding: {
    claim: string;
    quote: string;
    url: string;
    locator?: string;
    confidence?: number;
  }): Promise<WorkerToolOutcome<{ ok: boolean; reason?: string }>>;
}

/** What one worker is sent to do. `delegation` is the lead's brief; the rest is shared run context. */
export interface WorkerBrief {
  delegation: ResearchDelegation;
  round: number;
  goal: string;
  /** The lead's research brief — see `ResearchPlan.brief`. */
  brief: string;
  constraints: string[];
  /** URLs already read by the run, so the worker is not sent to re-open them. */
  visited: string[];
}

export interface WorkerLimits {
  maxToolCalls: number;
  wallClockMs: number;
}

export type WorkerFinishReason =
  | "done"
  | WorkerStopReason
  | "error"
  | "model_unavailable";

/** The compressed product of one worker. Never raw pages. */
export interface WorkerResult {
  summary: string;
  openQuestions: string[];
  followUps: string[];
  /** Model tokens the worker consumed, input and output together. */
  tokens: number;
  /** What the worker's OWN model calls cost. Tool fees are billed by the engine as they happen. */
  costMicroUsd: number;
  reason: WorkerFinishReason;
}

export interface RunWorkerInput {
  userId: string;
  brief: WorkerBrief;
  tools: WorkerTools;
  limits: WorkerLimits;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// What the lead reviews, and what it decides
// ---------------------------------------------------------------------------

/** A finding as the engine stores it. */
export interface ResearchFindingRow {
  id: string;
  workerId: string;
  round: number;
  objectiveId: string | null;
  sourceId: string | null;
  url: string;
  claim: string;
  quote: string;
  locator: string | null;
  confidence: number | null;
  createdAt: Date;
}

export interface ReviewRoundInput {
  userId: string;
  goal: string;
  brief: string;
  constraints: string[];
  objectives: ResearchObjective[];
  findings: ResearchFindingRow[];
  /** Worker summaries and open questions from the round just finished. */
  workerReports: Array<{ workerId: string; objectiveId: string; summary: string; openQuestions: string[]; followUps: string[] }>;
  round: number;
  /** Rounds and pages the tier still allows, so the lead does not plan work it cannot have. */
  roundsLeft: number;
  pagesLeft: number;
  /** The previous review, so coverage cannot silently regress between rounds. */
  previous?: ResearchRoundReview;
  signal?: AbortSignal;
}

export interface ReviewContradiction {
  objectiveId?: string;
  description: string;
  /** The two sources that disagree — `ResearchSource.id`s. */
  sourceIds: string[];
}

export interface ReviewRoundOutput {
  /** 0..1 per objective id. */
  coverage: Record<string, number>;
  /** New delegation briefs for the gaps; empty means nothing worth another round. */
  gaps: Array<{ objectiveId: string; reason: string; whatToFind: string; boundaries: string }>;
  contradictions: ReviewContradiction[];
  decision: "continue" | "synthesize";
  reason: string;
  costMicroUsd: number;
}

export interface SummarizePageInput {
  userId: string;
  goal: string;
  url: string;
  title: string;
  text: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Digests — what a tool result looks like to the model
// ---------------------------------------------------------------------------

/**
 * Renders a page digest as the text the model reads.
 *
 * The page's own words — title, summary, chunk previews — are untrusted and
 * are wrapped by the caller; this only lays them out. The chunk index is what
 * lets a worker ask for chunk 12 by number instead of re-reading the page.
 */
export function renderPageDigest(digest: Extract<WorkerPageDigest, { ok: true }>): string {
  const lines = [
    `Title: ${digest.title}`,
    `URL: ${digest.url}`,
    digest.alreadyRead ? "(already read by this run — cached)" : "",
    "",
    "Summary:",
    digest.summary,
    "",
    `Chunks (${digest.chunkCount}; use find_in_page to read one in full):`,
    ...digest.chunks.map((chunk) => `[chunk:${chunk.ordinal}] ${chunk.preview}`),
  ];
  return lines.filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
}

export function renderSearchDigest(hits: WorkerSearchHit[], note?: string): string {
  if (hits.length === 0) return note ?? "No results.";
  return [
    ...(note ? [note, ""] : []),
    ...hits.map((hit, i) => `${i + 1}. ${hit.title}${hit.read ? " (already read)" : ""}\n   ${hit.url}\n   ${hit.snippet}`),
  ].join("\n");
}

export function renderFindMatches(matches: WorkerFindMatch[]): string {
  if (matches.length === 0) return "No match.";
  return matches.map((match) => `[chunk:${match.ordinal}]\n${match.text}`).join("\n\n");
}

/**
 * Compiles a worker's `pattern` into something safe to run over a page.
 *
 * A model-authored regex is a denial-of-service vector — `(a+)+$` on a
 * 60,000-character page never returns — so anything but a short, simple
 * pattern is demoted to a literal search. `find_in_page` is for pulling a
 * figure or a phrase, and a literal covers that.
 */
export function compileFindPattern(pattern: string): RegExp {
  const trimmed = pattern.trim().slice(0, MAX_PATTERN_ARG_CHARS);
  const looksSimple = /^[\w\s.,;:'"()\-|?*+\\[\]^$\/%€£$]+$/.test(trimmed) && !/(\([^)]*[+*][^)]*\)[+*?])/.test(trimmed);
  if (looksSimple) {
    try {
      return new RegExp(trimmed, "i");
    } catch {
      // fall through to the literal
    }
  }
  return new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
