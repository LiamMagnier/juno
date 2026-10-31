/**
 * The trusted boundary where a saved login meets the agent's browser
 * (docs/design/agents-v2/VAULT.md).
 *
 * The model names a login by its label (or its site). This code, in the Work
 * runner and never in the model's process:
 *
 * 1. resolves the label among THIS agent's logins (the runner passes the
 *    person's and the agent's ids, from the server, never from the model);
 * 2. refuses a login the person has not approved unless this very call was
 *    put to them and approved;
 * 3. reads the browser's own record of the page's top-level URL and refuses
 *    unless its origin is exactly the saved one;
 * 4. only then opens (decrypts) the login, and types each value with CDP
 *    `Input.insertText` into a field it focused itself in the page's main
 *    document, reading the takeover fence and the origin again before each;
 * 5. answers with one fixed sentence.
 *
 * The values never reach a return value, an error message, a log line or an
 * audit row: every failure is one of the fixed sentences in vault-policy.ts,
 * and an exception's own message is never passed on. What it typed is
 * remembered for the run so later page reads can be scrubbed of it.
 *
 * Pure apart from its injected dependencies (tests/agent-vault.test.ts).
 */

import { scrubSecrets } from "@/lib/secrets/policy";
import {
  VAULT_RESULT_MESSAGE,
  filledLoginMessage,
  originMatches,
  resolveVaultEntry,
  vaultTotpCode,
  type VaultEntry,
} from "./vault-policy";

export type LoginFieldKind = "username" | "password" | "otp";

/** The login fields visible in the page's main document (never their values). */
export interface LoginFields {
  username: boolean;
  password: boolean;
  otp: boolean;
}

/** The agent's page, as the fill needs it (vault-page.ts over CDP; a stand-in in tests). */
export interface LoginPagePort {
  /** The browser's own record of the page's top-level URL ("" when nothing is open). */
  url(): Promise<string>;
  fields(): Promise<LoginFields | null>;
  /** Focuses and selects that field; true only when the main document's focused element is it. */
  focus(kind: LoginFieldKind): Promise<boolean>;
  /** CDP `Input.insertText` into whatever has focus. */
  insertText(text: string): Promise<void>;
  /** How many characters the focused field holds now (a count; the value is never read back). */
  focusedLength(): Promise<number | null>;
}

export interface OpenedLogin {
  id: string;
  label: string;
  origin: string;
  username: string;
  password: string;
  totpSecret: string | null;
}

export type VaultFillAuditReason =
  | "origin_mismatch"
  | "not_approved"
  | "no_form"
  | "no_totp"
  | "unavailable"
  | "did_not_open"
  | "changed"
  | "blocked"
  | "failed";

export interface VaultFillerDeps {
  /** This agent's logins, fresh (labels and sites only). */
  entries(): Promise<VaultEntry[]>;
  /** Decrypts one of this agent's logins. Called only after every check passed. */
  open(id: string): Promise<OpenedLogin | null>;
  recordFill(id: string, approvedNow: boolean): Promise<void>;
  /** The computer's browser page, or null when it has none that can fill. */
  page(): LoginPagePort | null;
  /** The takeover and lease fence: the refusal sentence, or null to go on. */
  fence(): Promise<string | null>;
  /** Identifiers and verdicts only. */
  audit?(event: { kind: "login_filled" | "login_refused"; credentialId: string | null; reason?: VaultFillAuditReason }): void;
  now?(): number;
}

export interface VaultFillResult {
  ok: boolean;
  output: string;
}

export function createVaultFiller(deps: VaultFillerDeps) {
  const typed = new Set<string>();

  const refuse = (credentialId: string | null, reason: VaultFillAuditReason, output: string): VaultFillResult => {
    deps.audit?.({ kind: "login_refused", credentialId, reason });
    return { ok: false, output };
  };

  /** Types one value into one field, with the fence and the origin read right before. */
  async function typeInto(
    page: LoginPagePort,
    origin: string,
    kind: LoginFieldKind,
    value: string,
  ): Promise<{ ok: true } | { ok: false; reason: VaultFillAuditReason; output: string }> {
    const blocked = await deps.fence();
    if (blocked) return { ok: false, reason: "blocked", output: blocked };
    if (!originMatches(await page.url(), origin)) return { ok: false, reason: "changed", output: VAULT_RESULT_MESSAGE.changed };
    if (!(await page.focus(kind))) return { ok: false, reason: "failed", output: VAULT_RESULT_MESSAGE.failed };
    typed.add(value);
    await page.insertText(value);
    if (!originMatches(await page.url(), origin)) return { ok: false, reason: "changed", output: VAULT_RESULT_MESSAGE.changed };
    const length = await page.focusedLength();
    if (!length) return { ok: false, reason: "failed", output: VAULT_RESULT_MESSAGE.failed };
    return { ok: true };
  }

  async function fill(request: { ref: unknown; approvedNow: boolean }): Promise<VaultFillResult> {
    let credentialId: string | null = null;
    try {
      const resolved = resolveVaultEntry(await deps.entries(), request.ref);
      if (!resolved.ok) return { ok: false, output: resolved.message };
      const entry = resolved.entry;
      credentialId = entry.id;

      const page = deps.page();
      if (!page) return refuse(entry.id, "unavailable", VAULT_RESULT_MESSAGE.unavailable);
      const url = await page.url();
      if (!url || url === "about:blank") return refuse(entry.id, "no_form", VAULT_RESULT_MESSAGE.noPage);
      if (!originMatches(url, entry.origin)) return refuse(entry.id, "origin_mismatch", VAULT_RESULT_MESSAGE.originMismatch);
      // Approved before (a fresh read), or this very call was put to the person.
      if (!entry.approved && !request.approvedNow) return refuse(entry.id, "not_approved", VAULT_RESULT_MESSAGE.notApproved);

      const fields = await page.fields();
      if (!fields) return refuse(entry.id, "no_form", VAULT_RESULT_MESSAGE.noForm);
      const plan: LoginFieldKind[] = fields.password
        ? [...(fields.username ? (["username"] as const) : []), "password"]
        : fields.otp
          ? ["otp"]
          : fields.username
            ? ["username"]
            : [];
      if (plan.length === 0) return refuse(entry.id, "no_form", VAULT_RESULT_MESSAGE.noForm);
      if (plan[0] === "otp" && !entry.hasTotp) return refuse(entry.id, "no_totp", VAULT_RESULT_MESSAGE.noTotp);

      // Every check has passed: only now is anything decrypted.
      const login = await deps.open(entry.id);
      if (!login || login.origin !== entry.origin) return refuse(entry.id, "did_not_open", VAULT_RESULT_MESSAGE.unknown);
      if (plan[0] === "otp" && !login.totpSecret) return refuse(entry.id, "no_totp", VAULT_RESULT_MESSAGE.noTotp);

      for (const kind of plan) {
        const value =
          kind === "username" ? login.username : kind === "password" ? login.password : vaultTotpCode(login.totpSecret!, deps.now ? deps.now() : Date.now());
        const step = await typeInto(page, login.origin, kind, value);
        if (!step.ok) return refuse(entry.id, step.reason, step.output);
      }

      await deps.recordFill(entry.id, request.approvedNow);
      deps.audit?.({ kind: "login_filled", credentialId: entry.id });
      return { ok: true, output: filledLoginMessage(login.label) };
    } catch {
      // Never the exception's own text: a browser error can quote what it was given.
      return refuse(credentialId, "failed", VAULT_RESULT_MESSAGE.failed);
    }
  }

  /** Removes everything this run typed from text about to reach the model (a page read, an error). */
  function scrubText(text: string): string {
    return typed.size ? scrubSecrets(text, typed) : text;
  }

  return { fill, scrubText, typedCount: () => typed.size };
}

export type VaultFiller = ReturnType<typeof createVaultFiller>;
