/**
 * What the search stack refuses to fetch, and what counts as "the same page".
 *
 * Both functions were private to search-engine.ts. They live here now because
 * open-corpora.ts has to apply the identical host guard to every URL a third
 * party corpus hands back, and search-engine.ts is `server-only` — importing
 * from it would have dragged that marker into the corpora module and put its
 * parsers out of reach of `tsx --test`, the same split index.ts already
 * describes for the unified engine. A second copy of an SSRF guard is the kind
 * of duplication that drifts, and the copy that drifts is the one that stops
 * blocking something.
 */

/**
 * The literal-IPv4 deny rules, split out so an IPv4-mapped IPv6 address can be
 * run through the identical checks rather than a second, weaker copy of them.
 */
function isPrivateIPv4(host: string): boolean {
  // The whole of 127.0.0.0/8 is loopback, not just 127.0.0.1. Matching the one
  // address left `http://127.0.0.2/` reaching the same local service, which is
  // the bypass every SSRF cheatsheet opens with.
  if (/^127\./.test(host)) return true;
  if (host === "0.0.0.0") return true;
  // Link-local, which is how the cloud metadata endpoints are reached.
  if (/^169\.254\./.test(host)) return true;
  // RFC 1918.
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * SSRF & Private IP Protection: blocks internal network probes.
 */
export function isDisallowedHost(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    /*
     * Everything below reasons about hostnames, and a scheme with no host at
     * all sails past all of it: `data:text/html,…` parses, yields an empty
     * hostname, matches none of the deny rules and is fetchable by undici. That
     * is a way to hand the extractor attacker-authored "page text" with no
     * network request to notice, so the allowlist comes first.
     */
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return true;
    /*
     * The trailing dot is the fully-qualified form of the SAME name and resolves
     * identically, but it is a different string — so `http://localhost./` and
     * `http://svc.internal./` walked straight through suffix checks written
     * against the bare form. Strip it before anything compares names.
     */
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host.endsWith(".internal") || host.endsWith(".local")) return true;

    /*
     * WHATWG `URL` reports an IPv6 literal WITH its brackets, so `host` here is
     * `[::1]`, never `::1` — an equality test against the bare form matched
     * nothing and let IPv6 loopback through untouched. Unwrap once, then reason
     * about the address. Note the parser has already normalised and compressed
     * it, so `[0:0:0:0:0:0:0:1]` arrives as `::1` and needs no separate case.
     */
    if (host.startsWith("[") && host.endsWith("]")) {
      const v6 = host.slice(1, -1);
      if (v6 === "::1" || v6 === "::") return true;
      // fc00::/7 unique-local and fe80::/10 link-local: the IPv6 equivalents of
      // the RFC 1918 and metadata ranges blocked below.
      if (/^f[cd]/.test(v6)) return true;
      if (/^fe[89ab]/.test(v6)) return true;
      /*
       * IPv4-mapped (::ffff:0:0/96) is a full second path to every address the
       * IPv4 rules block — `https://[::ffff:127.0.0.1]/` reaches loopback — and
       * the parser rewrites the dotted tail into hex groups (`::ffff:7f00:1`),
       * so it has to be folded back to a quad before those rules can see it.
       */
      const mapped = /^::ffff:(.+)$/.exec(v6)?.[1];
      if (mapped) {
        if (mapped.includes(".")) return isPrivateIPv4(mapped);
        const groups = mapped.split(":");
        if (groups.length === 2) {
          const [hi, lo] = groups.map((g) => Number.parseInt(g, 16));
          if (Number.isFinite(hi) && Number.isFinite(lo)) {
            return isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
          }
        }
      }
      return false;
    }

    return isPrivateIPv4(host);
  } catch {
    return true;
  }
}

/**
 * The dedupe key for a result.
 *
 * Two engines almost never return the same URL byte-for-byte — one keeps the
 * tracking parameters, one resolves the redirect, one adds the trailing slash —
 * so deduping on the raw string leaves the corpus full of the same page three
 * times, which then reads to the synthesis model as three independent sources
 * corroborating each other. That is the specific failure this prevents.
 */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_[ce]id|ref|source|_hs)/i.test(key)) u.searchParams.delete(key);
    }
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const qs = u.searchParams.toString();
    return `${u.protocol}//${u.hostname}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}
