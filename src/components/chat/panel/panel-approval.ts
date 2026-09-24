import type { ActionApprovalDecision, ClientActionApproval } from "@/lib/action-approval";

import { PANEL_COPY } from "./copy";

/*
 * The Activity panel's compact approval control, as data (SPEC §8.3.1).
 *
 * A waiting call's row answers the same question the transcript's approval
 * card does, through the same endpoint with the same digest: in sheet mode the
 * card is under the panel, so the row is where the reader acts. The two
 * surfaces never disagree for long, because neither keeps the answer as its
 * own state: both read the approval back from the `approval` frame.
 *
 * Pure except for the injected `fetch`, so the request and every way it can
 * come back are tested without a DOM or a server.
 */

export type ApprovalControlState =
  | { kind: "idle" }
  | { kind: "sending"; decision: ActionApprovalDecision }
  | { kind: "answered"; decision: ActionApprovalDecision; approval: ClientActionApproval | null }
  /** `retry`: the question is still open (a network failure, a refused standing permission). */
  | { kind: "refused"; phrase: string; retry: boolean; scopeRefused: boolean };

/** The decisions the control offers: Allow once, Always allow (only when the card would), Decline. */
export function approvalChoices(approval: Pick<ClientActionApproval, "canAllowScope">, state: ApprovalControlState) {
  const scopeRefused = state.kind === "refused" && state.scopeRefused;
  return {
    allowOnce: true,
    alwaysAllow: approval.canAllowScope && !scopeRefused,
    decline: true,
  };
}

function asApproval(value: unknown): ClientActionApproval | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ClientActionApproval>;
  return typeof candidate.id === "string" && typeof candidate.receiptDigest === "string"
    ? (value as ClientActionApproval)
    : null;
}

/**
 * Posts one decision to `/api/approvals/[id]` with the digest that binds it to
 * the action shown, and maps the answer to the control's next state. The
 * refusal codes are the decision route's (`approval-card.tsx` reads the same
 * ones); a code this build does not know reads as "Couldn't record your
 * answer" with the question still open.
 */
export async function sendApprovalDecision(
  approval: Pick<ClientActionApproval, "id" | "receiptDigest">,
  decision: ActionApprovalDecision,
  fetchImpl: typeof fetch,
): Promise<ApprovalControlState> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/approvals/${encodeURIComponent(approval.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, receiptDigest: approval.receiptDigest }),
    });
  } catch {
    return { kind: "refused", phrase: PANEL_COPY.approval.unreachable, retry: true, scopeRefused: false };
  }

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; code?: unknown; error?: unknown; approval?: unknown }
    | null;
  if (response.ok && body?.ok !== false) {
    return { kind: "answered", decision, approval: asApproval(body?.approval) };
  }

  const code = body?.code ?? body?.error;
  switch (code) {
    case "already_decided":
      return { kind: "refused", phrase: PANEL_COPY.approval.alreadyAnswered, retry: false, scopeRefused: false };
    case "expired":
      return { kind: "refused", phrase: PANEL_COPY.approval.expired, retry: false, scopeRefused: false };
    case "blocked":
      return { kind: "refused", phrase: PANEL_COPY.approval.blocked, retry: false, scopeRefused: false };
    case "not_scope_allowable":
      return { kind: "refused", phrase: PANEL_COPY.approval.onceOnly, retry: true, scopeRefused: true };
    default:
      return {
        kind: "refused",
        phrase: PANEL_COPY.approval.refused,
        // A 5xx or an unknown refusal leaves the question open; a 4xx the
        // route named (not found, digest mismatch, policy changed) does not.
        retry: response.status >= 500 || code == null,
        scopeRefused: false,
      };
  }
}

/** The receipt phrase once this control has answered (before the `approval` frame catches up). */
export function answeredPhrase(decision: ActionApprovalDecision): string {
  return decision === "deny"
    ? PANEL_COPY.approval.declined
    : decision === "allow_scope"
      ? PANEL_COPY.approval.alwaysAllowed
      : PANEL_COPY.approval.allowedOnce;
}
