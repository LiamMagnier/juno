/**
 * `web_fetch` (SPEC §3.8.2): one page or PDF as clean text, so the model can
 * quote and reason over a page rather than a search snippet. It replaces
 * `browser_agent` in chat, which advertised clicks and typing it never did.
 *
 * Everything that makes it safe lives in `fetchPageForChat` (WS2): the
 * provenance ledger (it opens only a URL that already appeared in this
 * conversation), the SSRF guard on every redirect hop, the size caps, the
 * injection scan and the turn's limits. This spec is the model's view of it —
 * the description, the schema and the row's `present` args — and never fetches
 * anything itself.
 *
 * The backend is loaded with `await import()` for the reason `web-search.ts`
 * gives; tests inject a fake through `createWebFetchSpec`.
 */

import { domainToUnicode } from "node:url";

import { EMPTY_URL_TEXT, FETCH_UNAVAILABLE_TEXT } from "@/lib/tools/specs/web-fetch.prompt";
import { failed, intArg, oneLine, stringArg } from "@/lib/tools/specs/shared";
import { defineTool, type ToolOutcome, type ToolSpec } from "@/lib/tools/types";
import type { TurnTaint } from "@/lib/web/taint";
import type { LazyUrlLedger, TurnWebLimits } from "@/lib/web/types";

export interface WebFetchArgs extends Record<string, unknown> {
  url?: unknown;
  offset?: unknown;
  max_chars?: unknown;
}

export type WebFetchBackend = (
  input: { url: string; offset?: number; maxChars?: number },
  ctx: { ledger: LazyUrlLedger; taint: TurnTaint; limits: TurnWebLimits; signal: AbortSignal; private: boolean },
) => Promise<ToolOutcome>;

export const WEB_FETCH_DEFAULT_CHARS = 16_000;
export const WEB_FETCH_MIN_CHARS = 1_000;
export const WEB_FETCH_MAX_CHARS = 40_000;

/** The Unicode host without `www.`, as a row shows it; "" when the URL does not parse. */
export function displayDomain(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    const host = new URL(raw.trim()).hostname.replace(/\.$/, "");
    return domainToUnicode(host).replace(/^www\./i, "") || host.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

export function createWebFetchSpec(deps: { fetchPage?: WebFetchBackend } = {}): ToolSpec<WebFetchArgs> {
  const backend = async (): Promise<WebFetchBackend> =>
    deps.fetchPage ?? (await import("@/lib/web/fetch-page")).fetchPageForChat;

  return defineTool<WebFetchArgs>({
    id: "web_fetch",
    title: "Read web page",
    description:
      "Reads one web page or PDF and returns its text, so you can quote and reason over it instead of relying on a search snippet. Use it after web_search to open the most relevant results, or when the user gives you a URL. It only opens a URL that already appeared in this conversation — typed by the user or returned by an earlier search or page — so never build, guess or edit a URL; to reach a page you have not seen, search for it first. Long pages are returned in parts: the result says how many characters remain and which offset to pass to continue. It returns the final URL after redirects, the title, the text and a numbered list of links on the page; it cannot open pages behind a login or pages that need JavaScript, and it says so when that is the reason.",
    input: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "An absolute http(s) URL that appeared in this conversation. Required.",
        },
        offset: {
          type: "integer",
          description: "Character offset to continue from, from a previous result. Default 0.",
        },
        max_chars: {
          type: "integer",
          description: "Characters to return, 1,000 to 40,000. Default 16,000.",
        },
      },
      required: ["url"],
    },
    risk: "read",
    parallelSafe: true,
    timeoutMs: 20_000,
    icon: "globe",
    broker: "juno_runtime",
    dedupe: true,
    present(args) {
      return { url: oneLine(args.url), domain: oneLine(displayDomain(args.url)) };
    },
    async execute(args, ctx) {
      const url = stringArg(args.url);
      if (!url) return failed("invalid_args", EMPTY_URL_TEXT);
      if (!ctx.ledger || !ctx.taint || !ctx.limits) return failed("unavailable", FETCH_UNAVAILABLE_TEXT);
      const offset = intArg(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const maxChars = intArg(args.max_chars, WEB_FETCH_DEFAULT_CHARS, WEB_FETCH_MIN_CHARS, WEB_FETCH_MAX_CHARS);
      const fetchPage = await backend();
      return fetchPage(
        { url, offset, maxChars },
        { ledger: ctx.ledger, taint: ctx.taint, limits: ctx.limits, signal: ctx.signal, private: Boolean(ctx.private) },
      );
    },
  });
}

export const webFetchSpec = createWebFetchSpec();
