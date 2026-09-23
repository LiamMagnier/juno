import type { ClientActivityEvent, ClientMessage, ClientSource } from "@/types/chat";
import type { ChatSourceOrigin } from "@/types/run";

/*
 * The Activity panel's Sources tab (SPEC §8.3.2): which sources the answer
 * CITED, which the run READ without citing, and — only when there is neither —
 * which a search merely FOUND.
 *
 * The distinction is the whole point of the tab. A search returns eight results
 * and the model opens two; listing all ten as "sources" credits the answer with
 * reading pages it never saw, which is the inflation DECISIONS U3 removes. So a
 * Juno search result counts as read only when a `web_fetch` of the same page
 * succeeded, and as cited only when a marker in the answer points at it.
 *
 * Citation markers resolve exactly as `markdown.tsx` resolves them: `[n]` maps
 * to `sources[n - 1]` BY POSITION, and only on a message whose sources carry
 * `cited` (the numbered-corpus contract). On any other message a bracketed
 * number is prose, and nothing is cited.
 *
 * Pure, and free of React and of `server-only`: the panel and its tests import
 * it, and the panel's message selector calls `citationOrder` on every streamed
 * token, so it stays a linear scan.
 */

export interface SourceRow {
  url: string;
  title: string;
  /** Host without `www.`, for display. */
  domain: string;
  /** The page's own `/favicon.ico` (never a third-party favicon proxy, see source-chip.tsx). */
  favicon?: string;
  /** Legacy sources without an origin are read as `provider_search` (SPEC §8.3.2). */
  origin: ChatSourceOrigin;
  /** The citation numbers that resolve to this source, in order of first citation. Empty when uncited. */
  citedAs: number[];
  /** The verbatim supporting quote, where the producer kept one (research sources). */
  quote?: string;
  /** When the run finished reading the page (the `web_fetch` call's end), ISO. */
  readAt?: string;
}

export interface SourcesSplit {
  /** Referenced by a marker in the answer, ordered by first citation. */
  cited: SourceRow[];
  /** Every other source the run read, ordered by first appearance. */
  alsoRead: SourceRow[];
  /** Search results neither opened nor cited. Listed (under a quiet heading) only when
   *  `cited` and `alsoRead` are both empty; otherwise always empty. */
  found: SourceRow[];
}

/** Host without the `www.` noise, or null for anything that is not an http(s) URL. */
export function sourceDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * One key per page, so a search result and the fetch that opened it meet: host
 * (lower-cased, without `www.`), port, path without a trailing slash, and the
 * query. The scheme and the fragment are dropped — `http://` and `https://` of
 * one page, or two anchors in it, are the same reading.
 */
export function sourceKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${parsed.port ? `:${parsed.port}` : ""}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

function faviconOf(url: string): string | undefined {
  try {
    const { origin, protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? `${origin}/favicon.ico` : undefined;
  } catch {
    return undefined;
  }
}

/** A human title, falling back to the host when a producer handed over a URL or nothing. */
function titleFor(raw: string | undefined, url: string, domain: string): string {
  const title = raw?.replace(/\s+/g, " ").trim();
  return title && title !== url && !/^https?:\/\//i.test(title) ? title : domain;
}

/** How many sources a `[n]` may point into: all of them on a numbered-corpus message, none otherwise. */
export function citableSourceCount(sources: readonly Pick<ClientSource, "cited">[] | null | undefined): number {
  return sources?.some((source) => source.cited) ? sources.length : 0;
}

/*
 * What markdown never turns into a citation chip: fenced and inline code (they
 * are value nodes, not text), link labels (`[3](…)`, a chip inside a link would
 * be a link inside a link) and definitions (`[3]: …`). Blanked with spaces
 * rather than cut so nothing else shifts.
 */
const FENCE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g;
const INLINE_CODE = /(`+)[^`\n][\s\S]*?\1/g;
const MARKER = /\[(\d{1,3})\](?![(:])/g;

const blank = (match: string) => match.replace(/[^\n]/g, " ");

/**
 * The citation numbers in `content`, distinct, in order of first appearance,
 * limited to 1…`sourceCount` (a model invents indices past its list; those
 * stay prose in the answer and cite nothing here).
 */
export function citationOrder(content: string, sourceCount: number): number[] {
  if (sourceCount <= 0 || !content.includes("[")) return [];
  const text = content.includes("`") || content.includes("~~~")
    ? content.replace(FENCE, blank).replace(INLINE_CODE, blank)
    : content;
  const seen = new Set<number>();
  const order: number[] = [];
  MARKER.lastIndex = 0;
  for (let match = MARKER.exec(text); match; match = MARKER.exec(text)) {
    const n = Number(match[1]);
    if (n < 1 || n > sourceCount || seen.has(n)) continue;
    seen.add(n);
    order.push(n);
  }
  return order;
}

interface Read {
  at?: string;
  title?: string;
}

/**
 * Pages the run opened: every `web_fetch` record that succeeded, keyed by the
 * page it landed on and the one it asked for (a redirect is one reading). The
 * record, not the English title, is what says a page was read (INV-28).
 */
function pagesRead(activity: readonly ClientActivityEvent[] | null | undefined) {
  const read = new Map<string, Read>();
  const order: Array<{ key: string; url: string; title?: string; at?: string }> = [];
  for (const event of activity ?? []) {
    const call = event.call;
    if (!call || call.tool !== "web_fetch" || call.status !== "succeeded") continue;
    const argUrl = typeof call.args?.url === "string" ? call.args.url : undefined;
    const url = call.web?.finalUrl ?? event.url ?? call.web?.requestedUrl ?? argUrl;
    if (!url) continue;
    const key = sourceKey(url);
    if (!key) continue;
    const domain = sourceDomain(url) ?? "";
    // The legacy `detail` of a fetch row is the host until the page title is known.
    const title = event.detail && event.detail !== domain ? event.detail : undefined;
    const entry: Read = { at: call.endedAt, title };
    for (const alias of [url, call.web?.requestedUrl, argUrl]) {
      const aliasKey = alias ? sourceKey(alias) : null;
      if (aliasKey && !read.has(aliasKey)) read.set(aliasKey, entry);
    }
    if (!order.some((page) => page.key === key)) order.push({ key, url, title, at: call.endedAt });
  }
  return { read, order };
}

/** A Juno search result: read only once a fetch opened it (provider sources are read by the provider). */
function isSearchResult(origin: ChatSourceOrigin) {
  return origin === "juno_search";
}

/**
 * Cited, also read, and found (SPEC §8.3.2). Sources are de-duplicated by page
 * (first appearance wins its title and origin); a page cited under two numbers
 * carries both. Pages the run fetched that never reached `message.sources`
 * (a stream cut before the sources frame) still count as read.
 */
export function splitSources(message: Pick<ClientMessage, "sources" | "content" | "activity">): SourcesSplit {
  const sources = message.sources ?? [];
  const order = citationOrder(message.content ?? "", citableSourceCount(sources));
  const citedRank = new Map(order.map((n, rank) => [n, rank]));
  const { read, order: fetched } = pagesRead(message.activity);

  const rows = new Map<string, SourceRow & { firstCitation: number }>();
  sources.forEach((source, index) => {
    const key = sourceKey(source.url);
    const domain = sourceDomain(source.url);
    if (!key || !domain) return;
    const n = index + 1;
    const cited = citedRank.has(n);
    const existing = rows.get(key);
    if (existing) {
      if (cited) {
        existing.citedAs.push(n);
        existing.firstCitation = Math.min(existing.firstCitation, citedRank.get(n)!);
      }
      return;
    }
    const opened = read.get(key);
    const quote = source.origin === "research" ? source.snippet?.trim() || undefined : undefined;
    rows.set(key, {
      url: source.url,
      title: titleFor(source.title, source.url, domain),
      domain,
      favicon: faviconOf(source.url),
      origin: source.origin ?? "provider_search",
      citedAs: cited ? [n] : [],
      ...(quote ? { quote } : {}),
      ...(opened?.at ? { readAt: opened.at } : {}),
      firstCitation: cited ? citedRank.get(n)! : Number.POSITIVE_INFINITY,
    });
  });

  for (const page of fetched) {
    if (rows.has(page.key)) continue;
    const domain = sourceDomain(page.url);
    if (!domain) continue;
    rows.set(page.key, {
      url: page.url,
      title: titleFor(page.title, page.url, domain),
      domain,
      favicon: faviconOf(page.url),
      origin: "juno_fetch",
      citedAs: [],
      ...(page.at ? { readAt: page.at } : {}),
      firstCitation: Number.POSITIVE_INFINITY,
    });
  }

  const cited: Array<SourceRow & { firstCitation: number }> = [];
  const alsoRead: SourceRow[] = [];
  const unopened: SourceRow[] = [];
  for (const [key, row] of rows) {
    if (row.citedAs.length > 0) {
      row.citedAs.sort((a, b) => citedRank.get(a)! - citedRank.get(b)!);
      cited.push(row);
      continue;
    }
    const { firstCitation: _unused, ...plain } = row;
    if (isSearchResult(row.origin) && !read.has(key)) unopened.push(plain);
    else alsoRead.push(plain);
  }
  cited.sort((a, b) => a.firstCitation - b.firstCitation);

  return {
    cited: cited.map(({ firstCitation: _unused, ...row }) => row),
    alsoRead,
    found: cited.length === 0 && alsoRead.length === 0 ? unopened : [],
  };
}
