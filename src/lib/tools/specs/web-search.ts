/**
 * `web_search` (SPEC §3.8.1): Juno's own search, for the models that have no
 * provider search and for turns where it is off (RC-2).
 *
 * The engine work — one primary keyed engine, one fallback on failure, the
 * query hygiene, the per-turn limit — is `chatWebSearch` (`src/lib/web/search.ts`,
 * WS2). This spec is what the model sees of it: the numbered result list inside
 * the untrusted envelope, the turn's source numbering, the ledger entries that
 * let `web_fetch` open a result, and the fee.
 *
 * The backend is loaded with `await import()`: the search stack's static graph
 * reaches `server-only` modules, and the registry must stay importable offline
 * (SPEC §13 harness rule 1). Tests inject a fake through `createWebSearchSpec`.
 */

import {
  bulletedResult,
  CITE_LINKS_LINE,
  citeNumberedLine,
  EMPTY_QUERY_TEXT,
  NO_RESULTS_TEXT,
  numberedResult,
  SEARCH_RESULTS_LABEL,
  searchedLine,
  searchUnavailableText,
} from "@/lib/tools/specs/web-search.prompt";
import type { RegisteredSource } from "@/lib/chat/source-registry";
import { failed, intArg, oneLine, stringArg, succeeded } from "@/lib/tools/specs/shared";
import { defineTool, type ToolSpec } from "@/lib/tools/types";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { ChatSearchResult, EngineReport, PrivateSpanSet, TurnWebLimits } from "@/lib/web/types";
import { createPrivateSpanSet } from "@/lib/web/private-spans";
import { TOOL_ERROR_CODES, type ToolErrorCode, type ToolWebDetail } from "@/types/run";
import type { ClientSource } from "@/types/chat";

export interface WebSearchArgs extends Record<string, unknown> {
  query?: unknown;
  recency?: unknown;
  count?: unknown;
}

export type WebSearchBackend = (
  input: { query: string; count?: number; recency?: string },
  ctx: { signal: AbortSignal; private: boolean; privateSpans: PrivateSpanSet; limits: TurnWebLimits },
) => Promise<{
  results: ChatSearchResult[];
  engine: string | null;
  engines: EngineReport[];
  feeMicroUsd: number;
  degraded: boolean;
}>;

export const WEB_SEARCH_DEFAULT_COUNT = 5;
export const WEB_SEARCH_MAX_COUNT = 8;
const SNIPPET_CHARS = 300;
const QUERY_DETAIL_CHARS = 400;
const WEB_RESULTS_KEPT = 10;

/** A query guard that guards nothing, for a turn that holds no private text. */
const NO_PRIVATE_SPANS: PrivateSpanSet = { matches: () => false };

function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return typeof value === "string" && (TOOL_ERROR_CODES as readonly string[]).includes(value);
}

/** The page age a result carries, as a date: "2026-09-21". */
function ageOf(result: ChatSearchResult): string | null {
  if (!result.publishedAt) return null;
  const date = new Date(result.publishedAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * The registry's number for a result. One entry per input in order is the
 * registry's contract; a source it dropped as malformed (INV-3) shifts the
 * rest, so the URL decides whenever the two lists differ in length.
 */
function numberFor(registered: readonly RegisteredSource[], url: string, index: number): number {
  const byIndex = registered[index];
  if (byIndex && byIndex.source.url === url) return byIndex.n;
  return registered.find((entry) => entry.source.url === url)?.n ?? byIndex?.n ?? index + 1;
}

function engineDetail(engines: readonly EngineReport[]): string | null {
  const failedEngine = engines.find((engine) => engine.status !== "ok" && engine.status !== "empty");
  return failedEngine ? `${failedEngine.name}: ${failedEngine.status.replace(/_/g, " ")}` : null;
}

export function createWebSearchSpec(deps: { search?: WebSearchBackend; now?: () => Date } = {}): ToolSpec<WebSearchArgs> {
  const now = deps.now ?? (() => new Date());
  const backend = async (): Promise<WebSearchBackend> =>
    deps.search ?? (await import("@/lib/web/search")).chatWebSearch;

  return defineTool<WebSearchArgs>({
    id: "web_search",
    title: "Web search",
    description:
      "Searches the web and returns up to 8 results, each with a number, title, URL, snippet and page age. Use it for anything current or changing — news, prices, releases and versions, people's current roles, laws, schedules — or whenever the user asks you to look something up. Do not use it for timeless facts, arithmetic, or content already in the conversation. Write short queries of 2 to 8 words; start broad, then narrow; make each new query meaningfully different; search separately for each item in a comparison. Queries are sent to a third-party search engine, so never put the user's credentials, personal details or document text in a query unless they asked you to search for exactly that. Snippets are brief: open the 1 to 3 most relevant results with web_fetch before stating specifics, and cite only sources you used.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, 2 to 8 words. Required." },
        recency: {
          type: "string",
          enum: ["any", "day", "week", "month", "year"],
          description: "Limit results to pages published within this period. Default any.",
        },
        count: { type: "integer", description: "How many results, 1 to 8. Default 5." },
      },
      required: ["query"],
    },
    risk: "read",
    parallelSafe: true,
    timeoutMs: 15_000,
    icon: "search",
    broker: "juno_runtime",
    dedupe: true,
    present(args) {
      return { query: oneLine(args.query) };
    },
    async execute(args, ctx) {
      const query = stringArg(args.query);
      if (!query) return failed("invalid_args", EMPTY_QUERY_TEXT);
      const count = intArg(args.count, WEB_SEARCH_DEFAULT_COUNT, 1, WEB_SEARCH_MAX_COUNT);
      const recency = typeof args.recency === "string" && args.recency !== "any" ? args.recency : undefined;

      if (!ctx.limits || !ctx.sources) return failed("unavailable", searchUnavailableText(null));
      let found: Awaited<ReturnType<WebSearchBackend>>;
      try {
        const search = await backend();
        found = await search(
          { query, count, ...(recency ? { recency } : {}) },
          {
            signal: ctx.signal,
            private: Boolean(ctx.private),
            privateSpans:
              ctx.privateSpans && typeof (ctx.privateSpans as PrivateSpanSet).matches === "function"
                ? (ctx.privateSpans as PrivateSpanSet)
                : Array.isArray(ctx.privateSpans)
                ? createPrivateSpanSet({ texts: ctx.privateSpans })
                : NO_PRIVATE_SPANS,
            limits: ctx.limits,
          },
        );
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        // The backend's own refusals (rate_limited, not_permitted) carry a
        // code and a sentence written for the model; anything else is a fault.
        const code = (error as { code?: unknown } | null)?.code;
        const message = error instanceof Error ? error.message : String(error);
        if (isToolErrorCode(code)) return failed(code, message);
        return failed("provider_error", searchUnavailableText(null));
      }

      const web: ToolWebDetail = { query: oneLine(query, QUERY_DETAIL_CHARS) };
      if (found.engine) web.engine = found.engine;

      if (found.results.length === 0) {
        if (!found.engine) {
          return failed("provider_error", searchUnavailableText(engineDetail(found.engines)), {
            web,
            ...(found.feeMicroUsd > 0 ? { feeMicroUsd: found.feeMicroUsd } : {}),
          });
        }
        return succeeded(NO_RESULTS_TEXT, {
          figure: { kind: "results", n: 0 },
          web: { ...web, results: [] },
          ...(found.feeMicroUsd > 0 ? { feeMicroUsd: found.feeMicroUsd } : {}),
        });
      }

      const results = found.results.slice(0, WEB_SEARCH_MAX_COUNT);
      const sources: ClientSource[] = results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: oneLine(result.snippet, SNIPPET_CHARS),
      }));
      // One numbering for the turn: the number the model cites is the source's
      // position in the list `Message.sources` persists (SPEC §2.11).
      const registered = ctx.sources.register(sources, { cited: Boolean(ctx.citationsNumbered), origin: "juno_search" });
      const numbered = results.map((result, i) => ({ result, n: numberFor(registered, result.url, i) }));

      // Every result joins the provenance ledger, so `web_fetch` may open it.
      for (const { result } of numbered) ctx.ledger?.add(result.url, "search_result");

      const lines = numbered.map(({ result, n }) => {
        const title = oneLine(result.title, 300) || result.url;
        const snippet = oneLine(result.snippet, SNIPPET_CHARS);
        return ctx.citationsNumbered
          ? numberedResult(n, title, result.url, ageOf(result), snippet)
          : bulletedResult(title, result.url, ageOf(result), snippet);
      });
      const engine = found.engine ?? results[0].engine;
      const header = searchedLine(query, engine, results.length, now().toISOString());
      const text = [
        header,
        wrapUntrusted(SEARCH_RESULTS_LABEL, lines.join("\n")),
        ctx.citationsNumbered ? citeNumberedLine(numbered[0].n) : CITE_LINKS_LINE,
      ].join("\n");
      const body = [header, lines.join("\n")].join("\n");

      return succeeded(text, {
        body,
        sources: registered.length ? registered.map((entry) => entry.source) : sources,
        figure: { kind: "results", n: results.length },
        web: {
          ...web,
          engine,
          results: numbered.slice(0, WEB_RESULTS_KEPT).map(({ result, n }) => ({
            ...(ctx.citationsNumbered ? { n } : {}),
            title: oneLine(result.title, 300) || result.url,
            url: result.url,
          })),
        },
        ...(found.feeMicroUsd > 0 ? { feeMicroUsd: found.feeMicroUsd } : {}),
      });
    },
  });
}

export const webSearchSpec = createWebSearchSpec();
