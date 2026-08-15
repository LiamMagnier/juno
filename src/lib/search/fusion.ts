import { canonicalUrl, isDisallowedHost } from "./url-safety";

/**
 * How many ranked lists become one ranked list.
 *
 * Split out of search-engine.ts (which is `server-only`, and so unimportable
 * from `tsx --test`) because this is the part with the judgement in it: which
 * of two disagreeing engines wins, when agreement between weak engines beats a
 * lone strong one, and which copy of a duplicated page survives. That is
 * exactly the behaviour worth holding down with tests, and none of it needs a
 * network. The fan-out — who is asked, with what timeout — stays next to the
 * engines.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  rawContent?: string;
  publishedAt?: Date;
  author?: string;
  engine: string;
}

/**
 * One search backend, as the fan-out sees it.
 *
 * `weight` is how much this engine's ranking is trusted when engines disagree —
 * it multiplies the reciprocal-rank score below, so a keyed commercial index
 * outvotes a scraped one without ever silencing it. Nothing is a "fallback"
 * any more: every available engine runs, and the merge decides.
 */
export interface EngineSpec {
  name: string;
  weight: number;
  available(): boolean;
  run(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

/**
 * The constant in reciprocal-rank fusion. 60 is the value from the original
 * Cormack et al. paper and the one every IR implementation uses; it flattens
 * the head of each list enough that a result ranked #1 by one engine does not
 * automatically beat a result ranked #2 by three engines.
 */
export const RRF_K = 60;

/**
 * Merge every engine's ranked list into one, by reciprocal-rank fusion.
 *
 * The property that makes this safe to point at a dozen very different corpora:
 * a result's score is the SUM of `weight / (K + rank)` over the engines that
 * returned it, so agreement is what climbs. A lone hit from a specialist corpus
 * scores below a lone hit from a general web engine as long as its weight is
 * lower — which is how OpenAlex answering a question about a kitchen appliance
 * (it always answers something) fails to displace the actual web results —
 * while the same paper returned by OpenAlex, Crossref and PubMed stacks three
 * contributions and rightly outranks a blog post about it.
 */
export function fuseRankedLists(
  lists: Array<{ engine: Pick<EngineSpec, "name" | "weight">; hits: SearchResult[] }>,
  count: number
): SearchResult[] {
  const scored = new Map<string, { result: SearchResult; score: number; engines: Set<string> }>();
  for (const { engine, hits } of lists) {
    hits.forEach((hit, rank) => {
      if (!hit.url || !hit.url.startsWith("http") || isDisallowedHost(hit.url)) return;
      const key = canonicalUrl(hit.url);
      const contribution = engine.weight / (RRF_K + rank + 1);
      const existing = scored.get(key);
      if (!existing) {
        scored.set(key, { result: { ...hit, engine: engine.name }, score: contribution, engines: new Set([engine.name]) });
        return;
      }
      existing.score += contribution;
      existing.engines.add(engine.name);
      // Keep the richest copy: a snippet beats nothing, a fetched body beats a
      // snippet, and a date from any engine beats no date at all.
      if (!existing.result.rawContent && hit.rawContent) existing.result.rawContent = hit.rawContent;
      if (!existing.result.publishedAt && hit.publishedAt) existing.result.publishedAt = hit.publishedAt;
      if (!existing.result.author && hit.author) existing.result.author = hit.author;
      if (hit.snippet.length > existing.result.snippet.length) existing.result.snippet = hit.snippet;
      if (!existing.result.title && hit.title) existing.result.title = hit.title;
    });
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title))
    .slice(0, count)
    .map(({ result, engines }) => ({ ...result, engine: [...engines].sort().join("+") }));
}
