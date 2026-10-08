/**
 * The research protocol's source-quality policy (Stage 2), as code.
 *
 * Rule 0.4 of the owner's protocol: never cite a secondary SEO aggregator or an
 * affiliate listicle when primary documentation, official pricing tables,
 * changelogs, benchmark repositories or technical papers exist. Before this
 * module the only ranking signal was `authorityOf`, a host table that knows
 * governments, universities, journals and newspapers — and scores every
 * vendor's own documentation portal exactly like a "Top 10 AI coding tools in
 * 2025 (we tested them all)" affiliate page: 0.45, the unknown-publisher
 * default. For the questions people actually bring to research (products,
 * pricing, APIs, limits, models), that put the primary record and the content
 * farm on the same rung, and the farm usually ranked higher in the search
 * engine.
 *
 * This is deterministic and explainable on purpose: every verdict carries the
 * reasons that produced it, it runs on URL + title + a slice of text with no
 * network, and it never DELETES a source — it re-weights and labels. The
 * engine uses it to (a) rank seed reads and the writer's corpus, (b) label
 * search hits for workers, and (c) skip aggregators at read time when enough
 * better candidates exist.
 *
 * Pure and client-safe.
 */

/** Lower-case host without `www.`; empty when the URL does not parse. Local so claim-analysis can import this module. */
function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export type SourceTier =
  /** The originating record: vendor docs, pricing, changelog, repo, filing, paper, standard. */
  | "primary"
  /** Government, regulator, intergovernmental body, university. */
  | "official"
  /** Established newsroom or trade press. */
  | "reputable"
  | "general"
  /** SEO aggregator, review marketplace, affiliate listicle, sponsored roundup. */
  | "aggregator"
  /** Forums and social posts: first-hand reports, not records. */
  | "community";

export interface SourceAssessment {
  tier: SourceTier;
  /** Multiplier applied to the composite score: below 1 demotes, above 1 promotes. */
  weight: number;
  /** Why, in short phrases — persisted nowhere, shown to workers and in the trace. */
  reasons: string[];
}

/** Review marketplaces and listing farms: never the primary record of anything. */
const AGGREGATOR_HOSTS =
  /(?:^|\.)(?:g2|capterra|getapp|softwareadvice|trustradius|alternativeto|saasworthy|sourceforge|slashdot|financesonline|crozdesk|goodfirms|clutch|selecthub|technologyadvice|comparitech|top10|bestreviews|toolify|futurepedia|theresanaiforthat|aitoolsdirectory|topai|saashub|stackshare|similarweb|producthunt)\.(?:com|net|org|co|io|ai|tools)$/i;

/** First-party portals that are where a vendor publishes the record. */
const PRIMARY_SUBDOMAIN =
  /^(?:docs|doc|developer|developers|dev|api|platform|learn|support|help|status|investors?|ir|changelog|releases?|trust|security|legal|pricing|console|cloud)\./i;

const PRIMARY_PATH =
  /\/(?:docs?|documentation|reference|api(?:-reference)?|pricing|plans|changelog|release-?notes|releases|whats-?new|deprecations?|sunset|migration|limits|rate-?limits|quotas?|sla|terms|legal|security|trust|privacy|status|incidents?|specs?|specification|datasheet|whitepaper|10-?k|10-?q|annual-?report|filings?|investor)(?:[/._-]|$)/i;

/** Hosts whose pages are the record by construction: code, papers, models, standards, filings, leaderboards. */
const PRIMARY_HOSTS =
  /(?:^|\.)(?:github\.com|gitlab\.com|bitbucket\.org|huggingface\.co|arxiv\.org|openreview\.net|aclanthology\.org|paperswithcode\.com|sec\.gov|w3\.org|ietf\.org|rfc-editor\.org|iso\.org|ieee\.org|nist\.gov|lmarena\.ai|lmsys\.org|mlcommons\.org|pypi\.org|npmjs\.com|crates\.io|registry\.terraform\.io|kaggle\.com|zenodo\.org|ssrn\.com|doi\.org|semanticscholar\.org)$/i;

const OFFICIAL_HOST =
  /(?:^|\.)(?:gov|gov\.[a-z]{2,3}|mil|int|edu|ac\.[a-z]{2}|europa\.eu|who\.int|un\.org|oecd\.org|imf\.org|worldbank\.org|iea\.org)$/i;

const REPUTABLE_HOST =
  /(?:^|\.)(?:reuters|apnews|afp|bloomberg|ft|wsj|economist|nytimes|washingtonpost|bbc|theguardian|nature|science|thelancet|nejm|bmj|arstechnica|theverge|techcrunch|wired|theregister|semianalysis|anandtech|tomshardware|infoq|lwn)\.(?:com|co\.uk|org|net)$/i;

const COMMUNITY_HOST =
  /(?:^|\.)(?:reddit|quora|facebook|x|twitter|tiktok|pinterest|news\.ycombinator|stackoverflow|stackexchange|discord|linkedin|youtube)\.(?:com|org)$/i;

/** Listicle and roundup titles: "Top 10 …", "12 Best …", "Best … Tools in 2025", "… Alternatives". */
const LISTICLE_TITLE =
  /\b(?:top|best)\s+\d{1,3}\b|\b\d{1,3}\s+(?:best|top|leading|popular)\b|\bbest\b.*\b(?:tools?|apps?|software|platforms?|services?|alternatives?|options?|picks?)\b|\balternatives?\s+(?:to|for)\b|\b(?:tested|ranked|compared)\b.*\b(?:tools?|apps?)\b/i;

/** Affiliate and sponsorship disclosures: the page is paid to recommend. */
const AFFILIATE_MARKERS =
  /\b(?:affiliate (?:links?|commission|disclosure)|we may (?:earn|receive) (?:a )?(?:small )?(?:commission|compensation)|(?:earn|receive) a commission|sponsored (?:post|content|by)|paid partnership|partner content|this (?:post|article|page) (?:contains|may contain) (?:affiliate|sponsored))\b/i;

/** Where the host is a known vendor docs portal under its own brand, keep the brand for entity hints. */
export function siteName(url: string): string {
  const host = hostOfUrl(url);
  const parts = host.split(".");
  if (parts.length <= 2) return parts[0] ?? host;
  // docs.example.com → example; example.co.uk → example
  const tld2 = /^(?:co|com|org|net|ac|gov)$/.test(parts[parts.length - 2] ?? "");
  return parts[parts.length - (tld2 ? 3 : 2)] ?? host;
}

/**
 * The verdict for one source. `text` may be a snippet or a page; only its
 * first few thousand characters are inspected.
 */
export function assessSource(input: { url: string; title?: string | null; text?: string | null }): SourceAssessment {
  const host = hostOfUrl(input.url);
  const reasons: string[] = [];
  let path = "";
  try {
    path = new URL(input.url).pathname;
  } catch {
    return { tier: "general", weight: 0.8, reasons: ["unparseable URL"] };
  }
  const title = (input.title ?? "").replace(/\s+/g, " ").trim();
  const head = (input.text ?? "").slice(0, 6_000);

  if (AGGREGATOR_HOSTS.test(host)) {
    return { tier: "aggregator", weight: 0.45, reasons: ["review marketplace / listing aggregator"] };
  }
  const affiliate = AFFILIATE_MARKERS.test(head);
  const listicle = LISTICLE_TITLE.test(title) || /\/(?:best|top)-\d*-?[a-z-]*(?:tools|apps|software|alternatives)\b/i.test(path);
  if (affiliate) reasons.push("affiliate or sponsorship disclosure");
  if (listicle) reasons.push("listicle / roundup title");

  if (OFFICIAL_HOST.test(host)) return { tier: "official", weight: 1.2, reasons: ["government, regulator or university domain"] };
  if (PRIMARY_HOSTS.test(host)) {
    return { tier: "primary", weight: 1.2, reasons: [`primary record host (${host})`] };
  }
  // A vendor's own docs/pricing/changelog — unless the "page" is a listicle on
  // the vendor's marketing blog, which is marketing, not the record.
  if (!listicle && !affiliate && (PRIMARY_SUBDOMAIN.test(host) || PRIMARY_PATH.test(path))) {
    return {
      tier: "primary",
      weight: 1.25,
      reasons: [PRIMARY_SUBDOMAIN.test(host) ? "first-party documentation portal" : "first-party docs, pricing, changelog or terms page"],
    };
  }
  if (affiliate || (listicle && !REPUTABLE_HOST.test(host))) {
    return { tier: "aggregator", weight: affiliate ? 0.4 : 0.55, reasons };
  }
  if (COMMUNITY_HOST.test(host)) return { tier: "community", weight: 0.75, reasons: ["forum or social post: first-hand report, not a record"] };
  if (REPUTABLE_HOST.test(host)) return { tier: "reputable", weight: 1.05, reasons: ["established newsroom or trade press"] };
  return { tier: "general", weight: 0.9, reasons: reasons.length ? reasons : ["unclassified publisher"] };
}

/** Short label for a search digest line, e.g. "primary", "aggregator — avoid citing". */
export function tierLabel(tier: SourceTier): string {
  switch (tier) {
    case "primary":
      return "primary record";
    case "official":
      return "official";
    case "reputable":
      return "trade press";
    case "aggregator":
      return "aggregator/affiliate — avoid citing";
    case "community":
      return "community report";
    default:
      return "secondary";
  }
}

/** Rank order of tiers for read and cite decisions, best first. */
const TIER_RANK: Record<SourceTier, number> = { primary: 0, official: 0, reputable: 1, general: 2, community: 3, aggregator: 4 };

/**
 * Hits re-ordered by tier, stable within a tier: what a worker sees first is
 * the primary record, not whatever the engine's SEO ranking put on top.
 */
export function rankByPolicy<T extends { url: string; title?: string | null; snippet?: string | null }>(
  hits: readonly T[]
): Array<T & { assessment: SourceAssessment }> {
  return hits
    .map((hit, index) => ({ ...hit, assessment: assessSource({ url: hit.url, title: hit.title, text: hit.snippet }), index }))
    .sort((a, b) => TIER_RANK[a.assessment.tier] - TIER_RANK[b.assessment.tier] || a.index - b.index)
    .map(({ index: _index, ...rest }) => rest as T & { assessment: SourceAssessment });
}

/** Whether a source is one the read stage should skip while better candidates remain. */
export function isAggregator(input: { url: string; title?: string | null; text?: string | null }): boolean {
  return assessSource(input).tier === "aggregator";
}
