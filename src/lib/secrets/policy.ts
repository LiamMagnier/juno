/**
 * Alevr Secrets — the decisions, without the database (BRIEF §7).
 *
 * A credential is stored once, sealed to its owner (src/lib/secrets/store.ts).
 * A model never receives it. What a run receives is a capability reference: an
 * opaque string naming one GRANT — one credential, one task, a subset of the
 * credential's hosts and scopes, an expiry and a use budget — and carrying a
 * MAC so it cannot be minted or edited outside trusted code. The plaintext is
 * produced only by `redeemSecretGrant` in the store, only for a trusted caller
 * that is about to inject it at the boundary (a browser fill into a password
 * field), and every redemption — granted or refused — writes an access event.
 *
 * Everything here is pure so the adversarial matrix (cross-account, expired,
 * revoked, replayed, wrong host, wrong task, wrong scope) runs without
 * Postgres. The store calls `evaluateRedemption` inside the same transaction
 * that spends a use, so the rule tested here is the rule enforced.
 */

/** What a grant may be used for. Narrow verbs, never "use". */
export const SECRET_SCOPES = ["fill:username", "fill:secret"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

export const SECRET_SCOPE_LABEL: Record<SecretScope, string> = {
  "fill:username": "Fill the username",
  "fill:secret": "Fill the password into a password field",
};

/** A grant outlives its task only by accident; this is the ceiling. */
export const MAX_GRANT_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_GRANT_TTL_MS = 8 * 60 * 60_000;
export const MAX_GRANT_USES = 50;
export const DEFAULT_GRANT_USES = 10;

export const SECRET_REDEMPTION_REFUSALS = [
  "malformed_reference",
  "forged_reference",
  "unknown_grant",
  "wrong_account",
  "wrong_task",
  "grant_expired",
  "grant_revoked",
  "credential_revoked",
  "credential_rotated",
  "insecure_target",
  "host_not_allowed",
  "scope_not_granted",
  "uses_exhausted",
  "field_not_password",
] as const;
export type SecretRedemptionRefusal = (typeof SECRET_REDEMPTION_REFUSALS)[number];

/** The sentence a run is told, which never names the secret or its value. */
export const SECRET_REFUSAL_TEXT: Record<SecretRedemptionRefusal, string> = {
  malformed_reference: "That is not a credential reference this task was given.",
  forged_reference: "That is not a credential reference this task was given.",
  unknown_grant: "That is not a credential reference this task was given.",
  wrong_account: "That is not a credential reference this task was given.",
  wrong_task: "That credential was granted to a different task.",
  grant_expired: "Access to that credential for this task has expired. Ask the user to grant it again.",
  grant_revoked: "The user revoked access to that credential.",
  credential_revoked: "The user removed that credential.",
  credential_rotated: "That credential was changed after access was granted. Ask the user to grant it again.",
  insecure_target: "Credentials are only filled into https pages.",
  host_not_allowed: "That credential is not allowed on this site.",
  scope_not_granted: "This task was not allowed to use that credential this way.",
  uses_exhausted: "This task has used that credential as many times as it was allowed.",
  field_not_password: "A password is only filled into a password field.",
};

export interface SecretGrantView {
  id: string;
  userId: string;
  credentialId: string;
  /** The task the grant belongs to: `work:<sessionId>` for a Work task. */
  taskKey: string;
  hosts: readonly string[];
  scopes: readonly string[];
  /** The credential version the user granted. Rotation invalidates the grant. */
  credentialVersion: number;
  expiresAt: Date;
  revokedAt: Date | null;
  maxUses: number;
  uses: number;
}

export interface SecretCredentialView {
  id: string;
  userId: string;
  version: number;
  hosts: readonly string[];
  revokedAt: Date | null;
}

export interface RedemptionRequest {
  userId: string;
  taskKey: string;
  /** Where the value would go: the page the browser is on. */
  targetUrl: string;
  scope: SecretScope;
  /** For `fill:secret`: the trusted executor's own reading of the field type. */
  targetIsPasswordField?: boolean;
}

export type RedemptionVerdict = { ok: true } | { ok: false; reason: SecretRedemptionRefusal };

// ── Host rules ───────────────────────────────────────────────────────────────

/**
 * A host pattern: `example.com` (that host only) or `*.example.com` (its
 * subdomains, not the apex). Lower-case, no scheme, port or path. A bare `*`,
 * an IP-looking pattern with a wildcard, or a public-suffix-only wildcard such
 * as `*.com` is refused: a credential scoped to every site is not scoped.
 */
export function normalizeHostPattern(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.length > 253) return null;
  const wildcard = value.startsWith("*.");
  const host = wildcard ? value.slice(2) : value;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (host.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))) return null;
  if (wildcard && host.split(".").length < 2) return null;
  if (wildcard && /^\d+(\.\d+)*$/.test(host)) return null;
  return wildcard ? `*.${host}` : host;
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return h.endsWith(`.${base}`) && h.length > base.length + 1;
  }
  return h === pattern;
}

/** A target URL is eligible only over https, with no credentials in it. */
export function targetHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Every grant host must be covered by one of the credential's own hosts. */
export function hostsWithin(grantHosts: readonly string[], credentialHosts: readonly string[]): boolean {
  return grantHosts.every((grant) =>
    credentialHosts.some((cred) => {
      if (grant === cred) return true;
      if (cred.startsWith("*.")) {
        // A grant for a concrete subdomain, or a narrower wildcard, of a wildcard credential.
        const inner = grant.startsWith("*.") ? grant.slice(2) : grant;
        return hostMatches(inner, cred);
      }
      return false;
    }),
  );
}

// ── The decision ─────────────────────────────────────────────────────────────

/**
 * Whether one redemption may produce plaintext. Order matters only for which
 * refusal is reported; every check must pass. Account first, so a reference
 * from another account learns nothing about the grant (same text as unknown).
 */
export function evaluateRedemption(input: {
  grant: SecretGrantView | null;
  credential: SecretCredentialView | null;
  request: RedemptionRequest;
  now: Date;
}): RedemptionVerdict {
  const { grant, credential, request, now } = input;
  if (!grant || !credential) return { ok: false, reason: "unknown_grant" };
  if (grant.userId !== request.userId || credential.userId !== request.userId) {
    return { ok: false, reason: "wrong_account" };
  }
  if (grant.credentialId !== credential.id) return { ok: false, reason: "unknown_grant" };
  if (grant.taskKey !== request.taskKey) return { ok: false, reason: "wrong_task" };
  if (grant.revokedAt) return { ok: false, reason: "grant_revoked" };
  if (credential.revokedAt) return { ok: false, reason: "credential_revoked" };
  if (grant.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "grant_expired" };
  if (grant.credentialVersion !== credential.version) return { ok: false, reason: "credential_rotated" };
  const host = targetHost(request.targetUrl);
  if (!host) return { ok: false, reason: "insecure_target" };
  if (!grant.hosts.some((pattern) => hostMatches(host, pattern))) return { ok: false, reason: "host_not_allowed" };
  // Defence in depth: a grant row edited to a host its credential never had
  // still cannot reach it.
  if (!credential.hosts.some((pattern) => hostMatches(host, pattern))) return { ok: false, reason: "host_not_allowed" };
  if (!grant.scopes.includes(request.scope)) return { ok: false, reason: "scope_not_granted" };
  if (request.scope === "fill:secret" && request.targetIsPasswordField !== true) {
    return { ok: false, reason: "field_not_password" };
  }
  if (grant.uses >= grant.maxUses) return { ok: false, reason: "uses_exhausted" };
  return { ok: true };
}

// ── Capability references ────────────────────────────────────────────────────

export const SECRET_REF_PREFIX = "asec_";

/**
 * `asec_<grantId>.<mac>` — the grant id plus a MAC over it in a dedicated
 * domain. The MAC is computed by the caller's `mac` (the store passes
 * `domainMac`, keyed by AUTH_SECRET), so this module holds no key. The
 * reference carries no secret and no host; knowing it without the task it was
 * granted to, and the account it belongs to, redeems nothing.
 */
export const SECRET_REF_DOMAIN = "alevr.secret-grant.ref.v1";

export function formatSecretRef(grantId: string, mac: (value: string) => string): string {
  return `${SECRET_REF_PREFIX}${grantId}.${mac(grantId)}`;
}

export function parseSecretRef(
  ref: unknown,
  verify: (grantId: string, macValue: string) => boolean,
): { ok: true; grantId: string } | { ok: false; reason: "malformed_reference" | "forged_reference" } {
  if (typeof ref !== "string" || !ref.startsWith(SECRET_REF_PREFIX) || ref.length > 200) {
    return { ok: false, reason: "malformed_reference" };
  }
  const body = ref.slice(SECRET_REF_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed_reference" };
  const grantId = body.slice(0, dot);
  const macValue = body.slice(dot + 1);
  if (!/^[a-z0-9]{8,40}$/i.test(grantId) || !/^[A-Za-z0-9_-]{20,}$/.test(macValue)) {
    return { ok: false, reason: "malformed_reference" };
  }
  return verify(grantId, macValue) ? { ok: true, grantId } : { ok: false, reason: "forged_reference" };
}

/** `work:<sessionId>` — the task a Work grant is scoped to. */
export function workTaskKey(sessionId: string): string {
  return `work:${sessionId}`;
}

// ── Leak prevention ──────────────────────────────────────────────────────────

/**
 * Remove every occurrence of the given plaintext values from text that is
 * about to leave the trusted side (a page snapshot, an error, a log line).
 * Values shorter than four characters are not scrubbed: they would blank
 * ordinary words, and a secret that short is not one this layer can protect.
 */
export function scrubSecrets(text: string, values: Iterable<string>): string {
  let out = text;
  for (const value of values) {
    if (!value || value.length < 4) continue;
    out = out.split(value).join("[credential hidden]");
    const encoded = encodeURIComponent(value);
    if (encoded !== value) out = out.split(encoded).join("[credential hidden]");
  }
  return out;
}
