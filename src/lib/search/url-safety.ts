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
 *
 * It did drift. The Work runner's classifier (`blockedFetchAddress`,
 * runner/agent-core/src/work/tools.ts) blocked all of 0.0.0.0/8 and caught
 * multicast and documentation IPv6 at the host level, where this one caught
 * them only after DNS; and both missed the IPv6 transition ranges that embed
 * or translate an IPv4 address (SPEC §6.4 item 2). This file now carries the
 * union of the two plus those ranges. The runner is vendored and is not edited
 * from here, so `tests/web-url-guard-drift.test.ts` runs one fixture through
 * both and holds this side to blocking everything the runner blocks.
 */

/** Exactly four decimal octets, each 0–255; null for anything else. */
function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? (octets as [number, number, number, number]) : null;
}

/**
 * Eight hextets, with `::` expanded and a dotted-quad tail folded in; null
 * when the text is not an IPv6 address. A zone id (`fe80::1%eth0`) is not
 * parsed: the caller treats an address it cannot read as one it refuses.
 */
function parseIpv6(value: string): number[] | null {
  if (!value.includes(":") || value.includes("%")) return null;
  let normalized = value;
  const tail = value.slice(value.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    const [a, b, c, d] = octets;
    normalized = `${value.slice(0, value.lastIndexOf(":") + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const double = normalized.indexOf("::");
  let groups: string[];
  if (double >= 0) {
    if (normalized.indexOf("::", double + 2) >= 0) return null;
    const left = normalized.slice(0, double).split(":").filter(Boolean);
    const right = normalized.slice(double + 2).split(":").filter(Boolean);
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  } else {
    groups = normalized.split(":");
  }
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * The IPv4 deny rules, on parsed octets. The whole of 0.0.0.0/8 (not only
 * 0.0.0.0, which is all this file used to catch: Linux routes 0.x.y.z to the
 * local host), loopback, RFC 1918, CGNAT, link-local — the cloud metadata
 * address lives there — the IETF and documentation blocks, benchmarking, and
 * everything from multicast up.
 */
function isPrivateIPv4Octets([a, b, c]: readonly number[]): boolean {
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && b >= 18 && b <= 19)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

/** The IPv4 address carried in two hextets. */
function embeddedIpv4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * The IPv6 deny rules, on parsed hextets.
 *
 * Beside the ranges both classifiers already knew (unspecified, loopback,
 * unique-local, link-local, multicast, documentation, and IPv4-mapped folded
 * back to its quad), the ones that are a second road to an IPv4 address or an
 * address nobody should be fetching from:
 * - `::/96`, the deprecated IPv4-compatible form: `[::127.0.0.1]` parses to
 *   `::7f00:1`, which neither guard recognised as loopback;
 * - `64:ff9b::/96` and `64:ff9b:1::/48`, NAT64: on an IPv6-only network the
 *   translator turns these into the IPv4 address they embed, private or not;
 * - `2002::/16`, 6to4, which embeds an IPv4 address in hextets 2–3 and is
 *   refused when that address is private;
 * - `fec0::/10`, the deprecated site-local range, and `100::/64`, discard-only.
 */
function isPrivateIPv6Hextets(h: readonly number[]): boolean {
  const zeroUntil = (end: number) => h.slice(0, end).every((group) => group === 0);
  if (zeroUntil(6)) return true; // ::/96: the unspecified address, loopback and IPv4-compatible
  if (zeroUntil(5) && h[5] === 0xffff) return isPrivateIPv4Octets(embeddedIpv4(h[6], h[7]));
  if (h[0] === 0x64 && h[1] === 0xff9b && (h[2] === 1 || (h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0))) {
    return true; // 64:ff9b::/96 and 64:ff9b:1::/48
  }
  if (h[0] === 0x2002) return isPrivateIPv4Octets(embeddedIpv4(h[1], h[2]));
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // 100::/64
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32
  return false;
}

/**
 * The lexical rules for a HOSTNAME that is not an address literal.
 *
 * Kept from the original guard on purpose: it applies prefix tests to names,
 * so `10.example.com` and `127.0.0.1.nip.io` are refused before DNS. That
 * overblocks a handful of real names, harmlessly, and it is the one place a
 * name built to resolve somewhere private is caught without a lookup — the
 * lists of links a page hands us are filtered here and never resolved.
 */
function looksLikePrivateName(host: string): boolean {
  if (/^127\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  const [a, b, c] = host.split(".").map(Number);
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && b >= 18 && b <= 19)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

/** True when a resolved IP is not a permitted public-web destination. */
export function isDisallowedAddress(rawAddress: string): boolean {
  const address = rawAddress.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = parseIpv4(address);
  if (ipv4) return isPrivateIPv4Octets(ipv4);
  const ipv6 = parseIpv6(address);
  // Neither form: something a resolver should never have answered with.
  if (!ipv6) return true;
  return isPrivateIPv6Hextets(ipv6);
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
    if (!host) return true;
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host.endsWith(".internal") || host.endsWith(".local")) return true;

    /*
     * WHATWG `URL` reports an IPv6 literal WITH its brackets, so `host` here is
     * `[::1]`, never `::1` — an equality test against the bare form matched
     * nothing and let IPv6 loopback through untouched. Unwrap once and run the
     * same classifier the resolved addresses go through, so a literal is judged
     * exactly as its DNS answer would be. The parser has already normalised and
     * compressed it (`[0:0:0:0:0:0:0:1]` arrives as `::1`, `[::ffff:127.0.0.1]`
     * as `::ffff:7f00:1`), and the hextet parse reads every spelling anyway.
     */
    if (host.startsWith("[") && host.endsWith("]")) return isDisallowedAddress(host.slice(1, -1));

    // `URL` has already rewritten the integer, octal and short forms
    // (`2130706433`, `0177.0.0.1`, `127.1`) into a dotted quad.
    const ipv4 = parseIpv4(host);
    if (ipv4) return isPrivateIPv4Octets(ipv4);
    return looksLikePrivateName(host);
  } catch {
    return true;
  }
}

/**
 * Validates whether a URL is safe for browser or search tools to fetch.
 */
export function isUrlSafeForToolAccess(urlString: string): boolean {
  return !isDisallowedHost(urlString);
}

/** Why a chat fetch refuses a URL before any network activity. */
export type ChatFetchBlockReason = "scheme" | "credentials" | "port" | "private_address" | "own_origin";

/**
 * The chat fetch policy on one literal URL, with no DNS (SPEC §6.1 step 5).
 *
 * Stricter than `isDisallowedHost`, which Research and Work keep as it is:
 * chat fetches run on every model by default and on URLs a web page chose, so
 * they are held to the web's two ports and kept off Juno's own origins — the
 * app itself, the voice relay, a self-hosted SearXNG, the code sandbox. A
 * public page that redirects to `https://<app host>/api/…` would otherwise be
 * Juno fetching itself, and `http://public-host:8080` is a service somebody
 * did not mean to put on the web. The resolved addresses are judged later, by
 * the pinned transport, on every hop.
 *
 * `ownHosts` are lowercase hostnames without a trailing dot or brackets.
 */
export function chatFetchBlockReason(rawUrl: string, ownHosts: ReadonlySet<string>): ChatFetchBlockReason | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "scheme";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "scheme";
  if (url.username || url.password) return "credentials";
  // `URL` drops a port that is its scheme's default, so "" covers :80 on http
  // and :443 on https; an explicit :443 on http (or :80 on https) is still one
  // of the web's two ports.
  if (url.port !== "" && url.port !== "80" && url.port !== "443") return "port";
  if (isDisallowedHost(rawUrl)) return "private_address";
  const host = url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (ownHosts.has(host) || ownHosts.has(host.replace(/^www\./, ""))) return "own_origin";
  return null;
}

/**
 * The dedupe key for a result.
 *
 * Two engines almost never return the same URL byte-for-byte — one keeps the
 * tracking parameters, one resolves the redirect, one adds the trailing slash —
 * so deduping on the raw string leaves the corpus full of the same page three
 * times, which then reads to the synthesis model as three independent sources
 * corroborating each other. That is the specific failure this prevents.
 *
 * Never a provenance key: it deletes `ref`, `source` and `utm_*`, so a URL a
 * model ADDED `?ref=<secret>` to would compare equal to the one it was shown.
 * `src/lib/web/url-canon.ts` is the key that may drop information and never
 * add it.
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
