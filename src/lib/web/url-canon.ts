/**
 * The provenance key: what counts as "the same URL" when `web_fetch` asks
 * whether a link appeared earlier in the conversation (SPEC §6.2.2).
 *
 * The rule it enforces is asymmetric on purpose. A candidate may DROP
 * information from a URL it was shown — a fragment, a query parameter, a
 * trailing slash, `www.` — and may upgrade `http` to `https`, but it may never
 * ADD or CHANGE anything. That is the whole defence against a model (or a page
 * steering it) that appends `?q=<the user's secret>` to a link it saw: the
 * extended URL is not on the ledger, so nothing is fetched and nothing leaves.
 *
 * `canonicalUrl` in `src/lib/search/url-safety.ts` is NOT this key and must
 * never become it: it deletes tracking parameters (`ref`, `utm_*`, `source`),
 * so a URL carrying an added `?ref=<secret>` would compare equal to the one
 * that was shown.
 *
 * Pure, linear in its input, and free of `server-only`.
 */

/** URLs longer than this are refused outright (`url_too_long`), and never enter the ledger. */
export const MAX_URL_CHARS = 2048;

export interface Canon {
  scheme: "http:" | "https:";
  /** Lowercase, no trailing dots, no leading `www.`; an IPv6 literal keeps its brackets. */
  host: string;
  /** "" for the scheme's default port. */
  port: string;
  /** RFC 3986 §6.2.2 normalised; a trailing "/" is dropped except at the root. */
  path: string;
  /** `key=value`, decoded, sorted. A multiset: a key may repeat. */
  params: string[];
  /** The cleaned absolute URL (entities decoded, wrappers and trailing punctuation removed). */
  raw: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  shy: "",
  zwj: "",
  zwnj: "",
};

/** Bounded alternatives only, so the scan is linear however hostile the text. */
const ENTITY_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/**
 * One pass over `text`, decoding numeric references and a small set of named
 * ones. Unknown names are left exactly as written. One pass also means
 * `&amp;lt;` becomes `&lt;` and stays there, which is what a browser shows.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Surrogates, NUL and anything past Unicode are not characters.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** Characters GFM's autolink extension never counts as the end of a URL. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*", "_", "~"]);
const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

function count(text: string, char: string): number {
  let n = 0;
  for (let i = text.indexOf(char); i >= 0; i = text.indexOf(char, i + 1)) n += 1;
  return n;
}

/**
 * The GFM autolink rule: trailing punctuation is prose, not URL — except a
 * closing bracket that balances an opening one inside the URL, which is how
 * `https://en.wikipedia.org/wiki/Mercury_(planet)` survives being written at
 * the end of a sentence in parentheses.
 */
export function trimTrailingPunctuation(value: string): string {
  let s = value;
  for (;;) {
    const last = s[s.length - 1];
    if (last === undefined) return s;
    if (TRAILING_PUNCTUATION.has(last)) {
      s = s.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && count(s, last) > count(s, opener)) {
      s = s.slice(0, -1);
      continue;
    }
    return s;
  }
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * RFC 3986 §6.2.2: percent-encoded unreserved characters are decoded, every
 * other percent-encoding gets upper-case hex, and a trailing slash is dropped
 * except at the root. `URL` has already removed dot segments.
 */
export function normalizePath(pathname: string): string {
  let path = pathname.replace(/%([0-9a-fA-F]{2})/g, (_whole, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
  path = path.replace(/\/+$/, "");
  return path || "/";
}

const BARE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
/** A bare domain's last label is a word, so `3.14` and `v1.2.3` are not hosts. */
const ALPHA_TLD = /\.[a-z]{2,63}$/i;

function isBareDomain(value: string): boolean {
  if (!BARE_DOMAIN.test(value)) return false;
  const slash = value.indexOf("/");
  return ALPHA_TLD.test(slash < 0 ? value : value.slice(0, slash));
}

/**
 * The provenance form of `raw`, or null when it is not an absolute http(s)
 * URL we could fetch. `bareDomain` admits `example.com/page` as
 * `https://example.com/page`; only text the USER typed may do that (§6.2.1).
 */
export function canonicalize(raw: string, opts: { bareDomain: boolean }): Canon | null {
  let s = decodeHtmlEntities(raw.trim());
  s = s.replace(/^<|>$/g, "");
  s = trimTrailingPunctuation(s);
  if (!/^https?:\/\//i.test(s)) {
    if (!opts.bareDomain || !isBareDomain(s)) return null;
    s = `https://${s}`;
  }
  if (s.length > MAX_URL_CHARS) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  if (!host) return null;
  u.hash = "";
  return {
    scheme: u.protocol as Canon["scheme"],
    host,
    port: u.port,
    path: normalizePath(u.pathname),
    params: [...u.searchParams].map(([key, value]) => `${key}=${value}`).sort(),
    raw: s,
  };
}

/** Every item of `sub` is in `set`, counting repeats. */
export function isSubMultiset(sub: readonly string[], set: readonly string[]): boolean {
  if (sub.length > set.length) return false;
  const available = new Map<string, number>();
  for (const item of set) available.set(item, (available.get(item) ?? 0) + 1);
  for (const item of sub) {
    const left = available.get(item) ?? 0;
    if (left === 0) return false;
    available.set(item, left - 1);
  }
  return true;
}

/**
 * Whether `candidate` may be opened on the strength of ledger entry `entry`.
 *
 * Same host and port; the same scheme or an upgrade to https (never a
 * downgrade); then either the same path with the candidate's parameters a
 * sub-multiset of the entry's (dropping is fine, adding or changing is not),
 * or the candidate is the bare site root of a host already on the ledger
 * (DECISIONS §4c, "ancestor paths").
 */
export function matches(candidate: Canon, entry: Canon): boolean {
  if (candidate.host !== entry.host || candidate.port !== entry.port) return false;
  const schemeOk =
    candidate.scheme === entry.scheme || (entry.scheme === "http:" && candidate.scheme === "https:");
  if (!schemeOk) return false;
  if (candidate.path === entry.path) return isSubMultiset(candidate.params, entry.params);
  return candidate.path === "/" && candidate.params.length === 0;
}

/** What separates URLs in running text. Parentheses and brackets are not in it: URLs contain them. */
const SEPARATORS = /[\s<>"'`|\\^]+/;
const SCHEME_START = /https?:\/\//gi;
/** Leading punctuation a bare domain may be wrapped in. */
const LEADING_WRAPPERS = /^[([{*_~]+/;

/**
 * Every absolute http(s) URL in `text`, and — with `bareDomain` — every word
 * that is a bare domain (`example.com`, `docs.example.org/guide`). Returned as
 * written, for `canonicalize` to judge. Linear: one split, then one bounded
 * scan per word, and no regular expression that can backtrack across words.
 */
export function extractUrlCandidates(text: string, opts: { bareDomain: boolean }): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const word of text.split(SEPARATORS)) {
    if (!word || !word.includes(".")) continue;
    SCHEME_START.lastIndex = 0;
    const starts: number[] = [];
    for (let m = SCHEME_START.exec(word); m; m = SCHEME_START.exec(word)) starts.push(m.index);
    if (starts.length > 0) {
      for (let i = 0; i < starts.length; i += 1) {
        const piece = word.slice(starts[i], starts[i + 1] ?? word.length);
        const trimmed = trimTrailingPunctuation(piece);
        if (trimmed.length > "https://".length) out.push(trimmed);
      }
      continue;
    }
    if (!opts.bareDomain || word.length > MAX_URL_CHARS || word.includes("@")) continue;
    const bare = trimTrailingPunctuation(word.replace(LEADING_WRAPPERS, ""));
    if (isBareDomain(bare)) out.push(bare);
  }
  return out;
}

/**
 * One string per canonical URL, for exact lookups (the search prefetch, the
 * ledger's de-duplication). Equal keys mean `matches` holds both ways.
 */
export function canonKey(canon: Canon): string {
  return `${canon.scheme}//${canon.host}:${canon.port}${canon.path}?${canon.params.join("&")}`;
}
