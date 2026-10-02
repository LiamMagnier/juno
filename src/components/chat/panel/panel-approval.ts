import type { ActionApprovalDecision, ActionRiskClass, ClientActionApproval } from "@/lib/action-approval";

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
 * The digest binds the answer to "the exact bytes the person was shown"
 * (`/api/approvals/[id]`), so the control shows what the card shows before it
 * asks: the preview, the connector and tool (or a task's title and estimate),
 * the risk, the untrusted-content warning, and — one disclosure away — the
 * redacted detail the digest covers. A standing permission (Always allow) is
 * offered only once that detail has been shown.
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

/**
 * The decisions the control offers: Allow once, Always allow and Decline.
 * Always allow needs three things: the store would honour it
 * (`canAllowScope`), it was not just refused, and the reader has seen the
 * detail it would stand for (`reviewed`).
 */
export function approvalChoices(
  approval: Pick<ClientActionApproval, "canAllowScope">,
  state: ApprovalControlState,
  opts: { reviewed: boolean } = { reviewed: false },
) {
  const scopeRefused = state.kind === "refused" && state.scopeRefused;
  return {
    allowOnce: true,
    alwaysAllow: approval.canAllowScope && !scopeRefused && opts.reviewed,
    decline: true,
  };
}

/**
 * A background-task handoff (`start_task`) asks through the same broker, but
 * its question is a brief and an estimate rather than connector arguments.
 * Recognised the way the card and `isTaskApproval` recognise it: connector id
 * and tool name together.
 */
export function isTaskHandoff(approval: Pick<ClientActionApproval, "connectorId" | "toolName">): boolean {
  return approval.connectorId === "juno_work" && approval.toolName === "start_task";
}

/** Values are printed, never described: strings as they are, anything else as indented JSON. */
export function formatDetailValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function detailText(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const RISK_KEYS: readonly ActionRiskClass[] = [
  "read_only",
  "reversible_write",
  "external_write",
  "destructive_or_sensitive",
  "unknown",
];

/** What the control shows about the request before the reader answers it. */
export interface ApprovalSummary {
  task: boolean;
  /** The request in one line: the task's title, else the store's preview. Verbatim. */
  headline: string;
  /** Connector calls: the connector's label and the tool's name, verbatim. */
  source: { connector: string; tool: string } | null;
  /** Task handoffs: the estimate, as the server wrote it. */
  estimate: string | null;
  /** Connector calls: the risk class as a short label and its sentence. */
  risk: { label: string; detail: string; warn: boolean } | null;
  /** The warning a request written from outside content carries, or null. */
  untrusted: string | null;
  /** The disclosure's name. */
  reviewLabel: string;
  /** Task handoffs: the brief, verbatim. */
  brief: string | null;
  /** Connector calls: every key/value of the redacted detail the digest covers. */
  rows: Array<{ key: string; value: string }>;
}

export function approvalSummary(approval: ClientActionApproval): ApprovalSummary {
  const task = isTaskHandoff(approval);
  const detail = approval.detail ?? {};
  const riskClass = RISK_KEYS.includes(approval.riskClass) ? approval.riskClass : "unknown";
  return {
    task,
    headline: (task ? detailText(detail, "title") : null) ?? approval.preview,
    source: task ? null : { connector: approval.connectorLabel, tool: approval.toolName },
    estimate: task ? detailText(detail, "estimate") : null,
    risk: task
      ? null
      : {
          label: PANEL_COPY.approval.risk[riskClass],
          detail: PANEL_COPY.approval.riskDetail[riskClass],
          warn: riskClass !== "read_only" && riskClass !== "reversible_write",
        },
    untrusted: approval.derivedFromUntrusted
      ? task
        ? PANEL_COPY.approval.untrustedTask
        : PANEL_COPY.approval.untrusted
      : null,
    reviewLabel: task ? PANEL_COPY.approval.reviewTask : PANEL_COPY.approval.review,
    brief: task ? detailText(detail, "goal") : null,
    rows: task ? [] : Object.entries(detail).map(([key, value]) => ({ key, value: formatDetailValue(value) })),
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
 * The decision route's refusals after which this request can no longer be
 * answered (`approval-card.tsx` marks the same ones terminal). Anything else —
 * a 5xx, a 400 for a malformed body, a code this build has not learned — leaves
 * the question open, as the card does.
 */
const FINAL_REFUSALS: ReadonlySet<string> = new Set([
  "not_found",
  "digest_mismatch",
  "policy_changed",
  "expired",
  "already_decided",
  "blocked",
]);

/**
 * Posts one decision to `/api/approvals/[id]` with the digest that binds it to
 * the action shown, and maps the answer to the control's next state. The route
 * sends `{ error: <message>, code? }`; the code is read first.
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

  // Signed out: the request is still waiting on the server, so the answer can
  // be given again once the reader has signed in.
  if (response.status === 401) {
    return { kind: "refused", phrase: PANEL_COPY.approval.signedOut, retry: true, scopeRefused: false };
  }

  const code = typeof body?.code === "string" ? body.code : typeof body?.error === "string" ? body.error : null;
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
        retry: code == null || !FINAL_REFUSALS.has(code),
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
