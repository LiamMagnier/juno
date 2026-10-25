import type { ClientSource } from "@/types/chat";

/**
 * Which sources each model's answer rests on, and which of them the models
 * agree on.
 *
 * Two kinds of evidence are read, and kept apart:
 *  - `inSources`: the source came back with the answer (provider search
 *    grounding: what the model's search tool returned for it);
 *  - `inText`: the answer itself links to it (a Markdown link or a bare URL
 *    in the prose, outside code).
 *
 * URLs are compared after normalisation (scheme, `www.`, fragment, tracking
 * parameters, parameter order and a trailing slash do not make two links
 * different), so the same page reached by two models counts once and shows as
 * shared.
 */

export interface CitationRef {
  /** Normalised identity: host + path + sorted query. */
  key: string;
  /** The URL as the model gave it (first seen). */
  url: string;
  host: string;
  title: string;
  inSources: boolean;
  inText: boolean;
}

export interface PaneCitationRef extends CitationRef {
  /** The other panes whose answers cite the same page. */
  sharedWith: string[];
}

export interface PaneCitations {
  paneId: string;
  refs: PaneCitationRef[];
  total: number;
  /** Refs at least one other pane also cites. */
  shared: number;
  /** Refs no other pane cites. */
  unique: number;
}

export interface CitationComparison {
  panes: PaneCitations[];
  /** Distinct pages across every pane. */
  union: number;
  /** Pages every compared pane cites (empty with fewer than two panes). */
  sharedByAll: CitationRef[];
  /** Sites (hosts) more than one pane draws on, most shared first. */
  sharedHosts: Array<{ host: string; paneIds: string[] }>;
}

const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "dclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
  "_hsenc",
  "_hsmi",
  "srsltid",
  "yclid",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/**
 * `%28planet%29` and `(planet)` are the same path: decode the escapes of
 * characters that mean the same either way (RFC 3986 unreserved characters
 * plus the sub-delimiters models and sites spell both ways), and upper-case
 * the hex of every other escape, so one page has one key however it was spelled.
 */
function decodeSafePercentEscapes(path: string): string {
  return path.replace(/%([0-9a-fA-F]{2})/g, (escape, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~()!*',]/.test(char) ? char : escape.toUpperCase();
  });
}

/** The comparable identity of a link, or null for anything that is not an http(s) URL. */
export function normalizeCitationUrl(raw: string): { key: string; host: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const query = params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
  let path = decodeSafePercentEscapes(url.pathname || "/");
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  return { key: `${host}${path === "/" ? "" : path}${query ? `?${query}` : ""}`, host };
}

/** Markdown with fenced and inline code removed: a URL in code is an example, not a citation. */
function withoutCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/~~~[\s\S]*?(?:~~~|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

const TRAILING_PUNCTUATION = /[.,;:!?'"’”]+$/;

/**
 * A bare URL's end, the way GFM autolinks find it: trailing punctuation is
 * prose, and so is a closing parenthesis with no opening one in the URL. So
 * `(see https://en.wikipedia.org/wiki/Mercury_(planet)).` keeps `(planet)`
 * and drops the sentence's own `).`.
 */
function trimBareUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  const count = (char: string) => url.split(char).length - 1;
  while (url.endsWith(")") && count(")") > count("(")) {
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return url;
}

/**
 * A Markdown link's destination: any run of non-space characters in which
 * parentheses come in balanced pairs (one level deep), as CommonMark allows,
 * so `[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))` is read whole.
 */
const MD_LINK = /(!?)\[([^\]\n]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\)/g;
/** A bare URL: stops at whitespace, angle brackets, quotes, backticks and `]`; parentheses are settled by `trimBareUrl`. */
const BARE_URL = /<?(https?:\/\/[^\s<>"'`\]]+)>?/g;

/**
 * The links an answer's prose carries, in order, with the link text when the
 * link is a Markdown link. Images are skipped; so is anything inside code.
 */
export function extractAnswerLinks(markdown: string): Array<{ url: string; title: string }> {
  const text = withoutCode(markdown);
  const out: Array<{ url: string; title: string }> = [];
  let rest = "";
  let last = 0;
  for (const match of text.matchAll(MD_LINK)) {
    rest += text.slice(last, match.index);
    last = (match.index ?? 0) + match[0].length;
    if (match[1] === "!") continue; // an image, not a citation
    out.push({ url: match[3], title: match[2].trim() });
  }
  rest += text.slice(last);
  for (const match of rest.matchAll(BARE_URL)) {
    const url = trimBareUrl(match[1]);
    if (url) out.push({ url, title: "" });
  }
  return out;
}

/** One pane's citations: its returned sources first, then the links its prose adds. */
export function collectCitations(input: { sources: readonly ClientSource[]; content: string }): CitationRef[] {
  const byKey = new Map<string, CitationRef>();
  for (const source of input.sources) {
    const normal = normalizeCitationUrl(source.url);
    if (!normal) continue;
    const existing = byKey.get(normal.key);
    if (existing) {
      existing.inSources = true;
      if (!existing.title && source.title) existing.title = source.title;
      continue;
    }
    byKey.set(normal.key, { key: normal.key, url: source.url, host: normal.host, title: source.title?.trim() || "", inSources: true, inText: false });
  }
  for (const link of extractAnswerLinks(input.content)) {
    const normal = normalizeCitationUrl(link.url);
    if (!normal) continue;
    const existing = byKey.get(normal.key);
    if (existing) {
      existing.inText = true;
      if (!existing.title && link.title) existing.title = link.title;
      continue;
    }
    byKey.set(normal.key, { key: normal.key, url: link.url, host: normal.host, title: link.title, inSources: false, inText: true });
  }
  return [...byKey.values()];
}

/** Compare the citations of two or more panes. */
export function compareCitations(
  panes: ReadonlyArray<{ paneId: string; sources: readonly ClientSource[]; content: string }>
): CitationComparison {
  const collected = panes.map((pane) => ({ paneId: pane.paneId, refs: collectCitations(pane) }));
  const citedBy = new Map<string, string[]>();
  const hostBy = new Map<string, Set<string>>();
  for (const { paneId, refs } of collected) {
    for (const ref of refs) {
      citedBy.set(ref.key, [...(citedBy.get(ref.key) ?? []), paneId]);
      const hosts = hostBy.get(ref.host) ?? new Set<string>();
      hosts.add(paneId);
      hostBy.set(ref.host, hosts);
    }
  }
  const report: PaneCitations[] = collected.map(({ paneId, refs }) => {
    const withShared = refs.map((ref) => ({ ...ref, sharedWith: (citedBy.get(ref.key) ?? []).filter((id) => id !== paneId) }));
    const shared = withShared.filter((ref) => ref.sharedWith.length > 0).length;
    return { paneId, refs: withShared, total: refs.length, shared, unique: refs.length - shared };
  });
  const firstSeen = new Map<string, CitationRef>();
  for (const { refs } of collected) for (const ref of refs) if (!firstSeen.has(ref.key)) firstSeen.set(ref.key, ref);
  const sharedByAll =
    panes.length < 2
      ? []
      : [...citedBy.entries()].filter(([, ids]) => ids.length === panes.length).map(([key]) => firstSeen.get(key)!);
  const sharedHosts = [...hostBy.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([host, ids]) => ({ host, paneIds: [...ids] }))
    .sort((a, b) => b.paneIds.length - a.paneIds.length || (a.host < b.host ? -1 : 1));
  return { panes: report, union: citedBy.size, sharedByAll, sharedHosts };
}
