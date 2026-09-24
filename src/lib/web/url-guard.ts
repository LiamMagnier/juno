/**
 * The chat fetch policy on a URL as written, before any network activity
 * (SPEC §6.1 steps 4–5), and on every redirect hop after it (step 7).
 *
 * Two checks, both lexical and both cheap:
 *
 * - `urlGuard`: http(s) only, no credentials, the web's two ports, a literal IP
 *   host must be public, and never one of Juno's own origins. The resolved
 *   addresses are judged later, by the pinned transport, on every hop; this is
 *   the part that needs no DNS. Research and Work keep `isDisallowedHost`
 *   alone, unchanged.
 * - `urlSecretRule`: a URL that came from outside content and carries
 *   a credential-shaped string (a DLP critical rule) is refused. A page that
 *   talked the model into putting an API key in a query string does not get to
 *   have it sent anywhere, even to a host on the ledger.
 *
 * Pure and free of `server-only`.
 */

import { DLP_RULES } from "@/lib/security/dlp";
import { chatFetchBlockReason, type ChatFetchBlockReason } from "@/lib/search/url-safety";

/**
 * Where Juno itself answers, from the deployment's own configuration: the app
 * and auth origins, the voice relay, a self-hosted SearXNG, the code sandbox,
 * the artifact sandbox and preview origins, and the machine's own hostname.
 * `localhost` and `*.localhost` are refused by the SSRF classifier already.
 */
const OWN_ORIGIN_ENV = [
  "NEXT_PUBLIC_APP_URL",
  "AUTH_URL",
  "NEXTAUTH_URL",
  "NEXT_PUBLIC_VOICE_RELAY_URL",
  "VOICE_RELAY_URL",
  "SEARXNG_URL",
  "CODE_INTERPRETER_URL",
  "NEXT_PUBLIC_SANDBOX_ORIGIN",
  "JUNO_PUBLIC_UI_BASE_URL",
  "JUNO_PREVIEW_ORIGIN_PUBLIC",
] as const;

function hostOf(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "") || null;
  } catch {
    return null;
  }
}

/** Juno's own hostnames, lowercase, each with and without a leading `www.`. */
export function ownOriginHosts(env: Readonly<Record<string, string | undefined>> = process.env): Set<string> {
  const hosts = new Set<string>(["localhost"]);
  for (const name of OWN_ORIGIN_ENV) {
    const value = env[name];
    const host = value ? hostOf(value) : null;
    if (host) {
      hosts.add(host);
      hosts.add(host.replace(/^www\./, ""));
    }
  }
  const machine = env.HOSTNAME?.trim().toLowerCase();
  if (machine && machine !== "0.0.0.0") hosts.add(machine.replace(/\.+$/, ""));
  return hosts;
}

let cachedOwnHosts: Set<string> | null = null;

function currentOwnHosts(): Set<string> {
  cachedOwnHosts ??= ownOriginHosts();
  return cachedOwnHosts;
}

/** Why the chat policy refuses `url` as written, or null when it may be fetched. */
export function urlGuardReason(url: string, ownHosts: ReadonlySet<string> = currentOwnHosts()): ChatFetchBlockReason | null {
  return chatFetchBlockReason(url, ownHosts);
}

/** The chat policy as the redirect guard `fetchSafePublicUrl` applies to every hop. */
export function urlGuard(url: string, ownHosts: ReadonlySet<string> = currentOwnHosts()): boolean {
  return urlGuardReason(url, ownHosts) === null;
}

function decodedForms(url: string): string[] {
  const forms = [url];
  try {
    const decoded = decodeURIComponent(url);
    if (decoded !== url) forms.push(decoded);
  } catch {
    // A malformed escape is left as written; the raw form is still checked.
  }
  return forms;
}

/**
 * The critical DLP rule a URL trips, if any (§6.1 step 4). Checked on the URL
 * as written and percent-decoded, because `%2D` is still a hyphen to the server
 * that receives it.
 */
export function urlSecretRule(url: string): string | null {
  for (const form of decodedForms(url)) {
    for (const rule of DLP_RULES) {
      if (rule.severity !== "critical") continue;
      // The shared rules are global regexes; a fresh one keeps `lastIndex` out of it.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", ""));
      if (pattern.test(form)) return rule.type;
    }
  }
  return null;
}
