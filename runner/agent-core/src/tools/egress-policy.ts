/**
 * The domain policy an egress proxy enforces for agent-authored commands.
 *
 * `--network=none` is the right default and it is not always workable: a real
 * build fetches dependencies. The wrong answer to that is to turn the network
 * on, because an agent with unrestricted egress can post the repository
 * anywhere. The answer here is a proxy the container cannot reconfigure, with
 * an explicit allowlist.
 *
 * The rules are pure and live here; enforcing them is the proxy's job. Keeping
 * them separate is what makes them testable — an allowlist that is only
 * exercised by starting a proxy and making real requests is an allowlist whose
 * edge cases are never tested, and the edge cases are the whole point.
 */

export interface EgressDecision {
  allowed: boolean;
  /** Why, for the audit event. */
  reason: string;
}

/** Registries and package hosts a build legitimately needs. */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "repo.maven.apache.org",
];

export interface EgressPolicy {
  /** Exact hosts, or `.example.com` for a domain and its subdomains. */
  allowedDomains: readonly string[];
  /** Ports other than 443 are refused unless listed. */
  allowedPorts?: readonly number[];
}

/**
 * Normalises a host for comparison.
 *
 * Lowercased, trailing dot removed, and any userinfo or port stripped by the
 * caller before this sees it. The trailing dot matters: `evil.com.` and
 * `evil.com` resolve identically, so a policy that compares them as strings
 * lets the first through a list containing the second.
 */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Whether a host matches one allowlist entry.
 *
 * A leading dot means "this domain and anything under it". Without that
 * distinction, an entry of `example.com` either fails to match the subdomain a
 * registry actually serves from, or — if implemented as a suffix test —
 * matches `notexample.com`, which is a different party entirely.
 */
export function hostMatches(host: string, entry: string): boolean {
  const target = normalizeHost(host);
  const rule = normalizeHost(entry);
  if (!target || !rule) return false;
  if (rule.startsWith(".")) {
    const base = rule.slice(1);
    return target === base || target.endsWith(`.${base}`);
  }
  return target === rule;
}

/**
 * Decides one request.
 *
 * Default-deny, and every refusal carries a reason, because a blocked fetch
 * that says only "failed" sends whoever is debugging it to the network stack
 * rather than to the policy that actually refused.
 */
export function evaluateEgress(rawUrl: string, policy: EgressPolicy): EgressDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "the request URL could not be parsed" };
  }

  // Only ever http(s). `file:` would read the container's disk through the
  // proxy, and `gopher:`/`ftp:` are protocol-confusion surface with no
  // legitimate use in a build.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { allowed: false, reason: `protocol ${url.protocol} is not permitted` };
  }

  // Credentials in a URL are how a token reaches a log. A build has no reason
  // to send one, and the proxy is the last place it can be stopped.
  if (url.username || url.password) {
    return { allowed: false, reason: "the request URL carries credentials" };
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const allowedPorts = policy.allowedPorts ?? [443];
  if (!allowedPorts.includes(port)) {
    return { allowed: false, reason: `port ${port} is not permitted` };
  }

  const host = normalizeHost(url.hostname);
  const matched = policy.allowedDomains.some((entry) => hostMatches(host, entry));
  return matched
    ? { allowed: true, reason: `${host} is on the allowlist` }
    : { allowed: false, reason: `${host} is not on the allowlist` };
}

/**
 * An audit record for a request the proxy saw.
 *
 * Both outcomes are recorded, not only refusals. A run whose log shows no
 * blocked egress could equally be one that never tried and one whose proxy was
 * bypassed, and those need to be distinguishable after the fact.
 */
export interface EgressAuditEvent {
  kind: "egress_allowed" | "egress_blocked";
  host: string;
  port: number;
  reason: string;
}

export function auditEvent(rawUrl: string, decision: EgressDecision): EgressAuditEvent {
  let host = "unparseable";
  let port = 0;
  try {
    const url = new URL(rawUrl);
    host = normalizeHost(url.hostname);
    port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    // Keep the placeholders. The raw URL is deliberately NOT recorded: it can
    // carry a token in a query string, and an audit log is exactly the wrong
    // place for one.
  }
  return {
    kind: decision.allowed ? "egress_allowed" : "egress_blocked",
    host,
    port,
    reason: decision.reason,
  };
}
