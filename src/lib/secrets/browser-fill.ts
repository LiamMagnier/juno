/**
 * The trusted boundary where an Alevr Secrets value meets a page (BRIEF §7).
 *
 * The model names a capability reference and a field. This code — in the
 * runner, never in the model's process — reads the page's real URL and the
 * field's real type from the DOM, asks the broker to redeem the reference
 * for exactly that (account, task, host, scope, field type), fills the value,
 * and returns the page with the value scrubbed. It remembers what it filled
 * for the life of the run so that every later page read, error message or
 * summary that leaves this side is scrubbed as well: a site that echoes a
 * username into the page, or mirrors a password into a `value` attribute,
 * cannot hand it back to the model.
 *
 * Pure apart from its injected dependencies, so the leak and refusal paths are
 * tested without a database or a browser (tests/secrets-browser-fill.test.ts).
 */

import {
  SECRET_REFUSAL_TEXT,
  scrubSecrets,
  type SecretRedemptionRefusal,
  type SecretScope,
} from "@/lib/secrets/policy";
import type { BrowserOutcome } from "@/lib/work/browser";
import type { FieldKind } from "@/lib/work/browser-page";

type Target = { ref?: number; selector?: string };

export type FillOutcome = BrowserOutcome;

export interface CredentialFillDeps {
  currentUrl(): string;
  fieldKind(target: Target): Promise<FieldKind | null>;
  fillSecret(target: Target, value: string, opts: { requirePasswordField: boolean }): Promise<FillOutcome>;
  redeem(request: {
    ref: string;
    targetUrl: string;
    scope: SecretScope;
    targetIsPasswordField: boolean;
  }): Promise<{ ok: true; value: string; label: string } | { ok: false; reason: SecretRedemptionRefusal }>;
}

export function createCredentialFill(deps: CredentialFillDeps) {
  const filled = new Set<string>();

  function scrubText(text: string): string {
    return filled.size ? scrubSecrets(text, filled) : text;
  }

  function scrub(outcome: FillOutcome): FillOutcome {
    if (filled.size === 0) return outcome;
    if (!outcome.ok) return { ...outcome, message: scrubText(outcome.message) };
    return {
      ...outcome,
      page: {
        ...outcome.page,
        url: scrubText(outcome.page.url),
        title: scrubText(outcome.page.title),
        html: scrubText(outcome.page.html),
        elements: outcome.page.elements.map((element) => ({ ...element, label: scrubText(element.label) })),
      },
    };
  }

  async function fill(target: Target, request: { credential: string; field: "username" | "password" }): Promise<FillOutcome> {
    const scope: SecretScope = request.field === "password" ? "fill:secret" : "fill:username";
    const kind = await deps.fieldKind(target);
    if (kind === null) return { ok: false, message: "That field is not on the page you last read. Read the page again." };
    if (request.field === "username" && kind !== "text") {
      return { ok: false, message: "A username is only filled into an ordinary text field." };
    }
    const redeemed = await deps.redeem({
      ref: request.credential,
      targetUrl: deps.currentUrl(),
      scope,
      targetIsPasswordField: kind === "password",
    });
    if (!redeemed.ok) return { ok: false, message: SECRET_REFUSAL_TEXT[redeemed.reason] };
    filled.add(redeemed.value);
    const outcome = await deps.fillSecret(target, redeemed.value, { requirePasswordField: request.field === "password" });
    return scrub(outcome);
  }

  return { fill, scrub, scrubText, filledCount: () => filled.size };
}
