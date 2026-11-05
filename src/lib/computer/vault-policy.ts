/**
 * The agents' credential vault, the decisions without the database or the
 * browser (docs/design/agents-v2/VAULT.md).
 *
 * A saved login belongs to one person and one of their agents. It is filled
 * only into that agent's computer, only while the browser's top-level page is
 * on exactly the origin it was saved for (scheme, host and port: no
 * subdomain, no parent domain, no lookalike), and the model is told only the
 * sentences below, never a value. Everything here is pure so the origin rule,
 * the TOTP codes and the wording are tested on their own
 * (tests/agent-vault.test.ts).
 */

import { base32Decode, base32Encode, totp } from "@/lib/totp";

/** At most this many saved logins per agent. */
export const MAX_AGENT_CREDENTIALS = 20;
export const MAX_CREDENTIAL_LABEL = 80;
export const MAX_CREDENTIAL_USERNAME = 320;
export const MAX_CREDENTIAL_PASSWORD = 1024;

/** The tool's name. Not part of agent-core's REMOTE_TOOL_NAMES: it exists only while the vault is on. */
export const FILL_LOGIN_TOOL_NAME = "computer_fill_login";
/** The approval and audit action. "login" is a hard-floor credential token, so no "always allow" ever covers it. */
export const FILL_LOGIN_ACTION = "work.computer.fill_login";

export class VaultInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultInputError";
  }
}

/** Sentences for the person (routes and the panel). Never a value. */
export const VAULT_INPUT_MESSAGE = {
  label: "Give the login a name.",
  labelTaken: "This agent already has a login with that name.",
  origin: "Enter the site as an https address, such as https://github.com.",
  username: "Enter the username.",
  password: "Enter the password.",
  totp: "That two-step secret could not be read. Paste the setup key or the otpauth:// link.",
  totpParams: "Only standard six-digit, 30-second codes can be generated.",
  tooMany: "This agent has as many saved logins as it can keep. Remove one first.",
} as const;

/**
 * What the model is told. Fixed sentences around the person's own label;
 * none of them can carry a username, a password or a code.
 */
export const VAULT_RESULT_MESSAGE = {
  unknown: "There is no saved login by that name for this agent. Use one of the labels listed in this tool's description.",
  ambiguous: "More than one saved login is for that site. Name the login by its label.",
  noPage: "Nothing is open in the computer's browser yet. Open the site's sign-in page first.",
  originMismatch:
    "The browser is not on the site this login was saved for, so nothing was filled. Saved logins are only filled on exactly their own site. Open the sign-in page on that site, and check the address.",
  noForm: "No sign-in field is visible on this page, so nothing was filled. Open the sign-in form and try again.",
  noTotp: "This page asks for a two-step code, and this login has no two-step secret saved. Ask the person to take over for the code.",
  notApproved: "This login has not been approved for use yet, so nothing was filled. Call computer_fill_login again to ask the person.",
  unavailable: "This computer's browser cannot fill saved logins right now.",
  failed: "The login could not be filled. Nothing was submitted. Look at the screen and try again, or ask the person to take over.",
  changed: "The page changed while the login was being filled, so filling stopped. Look at the screen and try again.",
} as const;

/** The one success sentence. The label is the person's own name for the login. */
export function filledLoginMessage(label: string): string {
  return `Filled the login for ${cleanLabel(label)}.`;
}

/** A label made safe to quote in a sentence: no control or bidi characters, one line, bounded. */
export function cleanLabel(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CREDENTIAL_LABEL);
}

// ── Origins ──────────────────────────────────────────────────────────────────

/**
 * `https://host[:port]` for what the person typed, or null. A bare host means
 * https. Anything but https, a URL with a user or password in it, or one with
 * no host is refused. `URL` lower-cases the host, turns an international name
 * into its `xn--` form and drops the default port, so two spellings of one
 * site store the same string, and a lookalike in another script stores a
 * different one.
 */
export function normalizeVaultOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/\.$/, "");
  if (!host || !/^[a-z0-9.:[\]-]+$/.test(host)) return null;
  // A single label ("localhost", "intranet") is no site anyone else can be told apart from.
  if (!host.includes(".") && !host.startsWith("[")) return null;
  return `https://${host}${url.port ? `:${url.port}` : ""}`;
}

/** The top-level origin of the page the browser says it is on, or null for anything not http(s). */
export function pageOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.origin === "null") return null;
    const host = url.hostname.replace(/\.$/, "");
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return null;
  }
}

/**
 * The anti-phishing rule: the page's own origin, as the browser reports it,
 * is exactly the saved one. No suffix or prefix matching of any kind, so
 * `login.github.com`, `github.com.evil.example`, `http://github.com` and
 * `https://github.com:8443` are all different sites from `https://github.com`.
 */
export function originMatches(currentUrl: string, savedOrigin: string): boolean {
  const current = pageOrigin(currentUrl);
  return current !== null && current === savedOrigin && savedOrigin.startsWith("https://");
}

/** The host part, for sentences ("on github.com"). */
export function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

// ── TOTP ─────────────────────────────────────────────────────────────────────

/**
 * The base32 secret behind what the person pasted: a setup key (any case,
 * spaces allowed) or an `otpauth://totp/...` link. Only the standard codes
 * (SHA-1, six digits, 30 seconds) are accepted, because only the secret is
 * stored. Throws `VaultInputError` with a sentence that never quotes the input.
 */
export function normalizeTotpSecret(raw: unknown): string {
  if (typeof raw !== "string") throw new VaultInputError(VAULT_INPUT_MESSAGE.totp);
  let value = raw.trim();
  if (/^otpauth:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new VaultInputError(VAULT_INPUT_MESSAGE.totp);
    }
    if (url.host.toLowerCase() !== "totp") throw new VaultInputError(VAULT_INPUT_MESSAGE.totpParams);
    const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
    const digits = url.searchParams.get("digits") ?? "6";
    const period = url.searchParams.get("period") ?? "30";
    if (algorithm !== "SHA1" || digits !== "6" || period !== "30") {
      throw new VaultInputError(VAULT_INPUT_MESSAGE.totpParams);
    }
    value = url.searchParams.get("secret") ?? "";
  }
  let bytes: Buffer;
  try {
    bytes = base32Decode(value);
  } catch {
    throw new VaultInputError(VAULT_INPUT_MESSAGE.totp);
  }
  // 80 bits is the least RFC 4226 allows; 1 KB is far beyond any real key.
  if (bytes.length < 10 || bytes.length > 1024) throw new VaultInputError(VAULT_INPUT_MESSAGE.totp);
  return base32Encode(bytes).replace(/=+$/, "");
}

/** The current six-digit code (RFC 6238 over src/lib/totp.ts), generated on the server at fill time. */
export function vaultTotpCode(secret: string, atMs: number = Date.now()): string {
  return totp(secret, atMs);
}

// ── Sealing ──────────────────────────────────────────────────────────────────

export type SealedField = "username" | "password" | "totp";

/**
 * The additional data each value is sealed with (`encryptSecretBound`): the
 * owner, the agent, the row and the field. A ciphertext moved to another
 * field, row, agent or account does not open.
 */
export function agentCredentialContext(userId: string, agentId: string, id: string, field: SealedField): string {
  return `juno.agent-credential.v1:${userId}:${agentId}:${id}:${field}`;
}

// ── Which login a call names ─────────────────────────────────────────────────

/** The view the routes return and the panel draws: the label and the site, and whether it was approved. Never a value. */
export interface ClientAgentCredential {
  id: string;
  label: string;
  origin: string;
  hasTotp: boolean;
  approved: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface VaultEntry {
  id: string;
  label: string;
  origin: string;
  /** The person approved a fill of it before. */
  approved: boolean;
  hasTotp: boolean;
}

/**
 * The saved login a call names: its label (case and spacing ignored), or its
 * site when exactly one login is saved for that site.
 */
export function resolveVaultEntry(
  entries: readonly VaultEntry[],
  ref: unknown,
): { ok: true; entry: VaultEntry } | { ok: false; message: string } {
  if (typeof ref !== "string" || !ref.trim()) return { ok: false, message: VAULT_RESULT_MESSAGE.unknown };
  const wanted = cleanLabel(ref).toLowerCase();
  const byLabel = entries.find((entry) => cleanLabel(entry.label).toLowerCase() === wanted);
  if (byLabel) return { ok: true, entry: byLabel };
  const origin = normalizeVaultOrigin(ref);
  if (origin) {
    const bySite = entries.filter((entry) => entry.origin === origin);
    if (bySite.length === 1) return { ok: true, entry: bySite[0]! };
    if (bySite.length > 1) return { ok: false, message: VAULT_RESULT_MESSAGE.ambiguous };
  }
  return { ok: false, message: VAULT_RESULT_MESSAGE.unknown };
}

/** The tool's description: what it does, and the saved logins by label and site (never a value). */
export function fillLoginToolDescription(entries: readonly VaultEntry[]): string {
  const list = entries.map((entry) => `"${cleanLabel(entry.label)}" (${entry.origin})`).join(", ");
  return (
    "Fill a login the person saved for you into the sign-in form open in your computer's browser. " +
    "You never see the username, password or code: they are typed in for you, and you are told only whether it worked. " +
    "It fills only when the browser is on exactly the site the login was saved for. " +
    "The person is asked the first time each login is used. It does not submit the form: press the sign-in button afterwards. " +
    "For a two-step code page, call it again on that page. " +
    (list ? `Saved logins: ${list}.` : "No logins are saved yet.")
  );
}
